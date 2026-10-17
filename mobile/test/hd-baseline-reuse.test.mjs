import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import { MAINNET_GENESIS } from '../src/model.mjs';
import { HdWalletSession, hdSnapshot } from '../src/hd-session.mjs';
import { addressSyncFromCheckpoints, setAddressBaseline, updateAddressSync } from '../src/hd-sync.mjs';

const hash = n => n.toString(16).padStart(64, '0');
const members = [1, 2, 3].map((n, index) => ({
  address: bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.multiply(BigInt(n)).toBytes(true).slice(1))]),
  network: 'main', index, change: 0, path: `m/44'/0'/0'/0/${index}`,
}));
const walletId = members[0].address;
const tip = { chain: 'main', genesis_hash: MAINNET_GENESIS, height: 200, hash: hash(200), mediantime: 1700000000 };
const history = (id, amount = '1') => ({ txid: hash(id), status: 'confirmed', block_height: 100,
  block_hash: hash(100), confirmations: 101, received: amount, spent: '0', balance_delta: amount });
const utxo = (id, amount = '1') => ({ txid: hash(id), vout: 0, amount, status: 'confirmed', block_height: 100,
  confirmations: 101, coinbase: false, mature: true, pending_spent_by: null });
const envelope = (address, items) => ({ address, tip, unit: 'connects', live: true, items, next_cursor: null });
const journal = (next_cursor, changes = [], through_sequence = 0, has_more = false) => ({
  tip, unit: 'connects', changes, next_cursor, through_sequence, has_more, journal_epoch: 1,
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = (sequence, addressIndex, kind, amount) => ({ sequence, address: members[addressIndex].address,
  kind, action: 'upsert', txid: hash(addressIndex + 1), ...(kind === 'utxo' ? { vout: 0 } : {}),
  item: kind === 'history' ? history(addressIndex + 1, amount) : utxo(addressIndex + 1, amount) });

function fixture(events = [event(1, 0, 'history', '2'), event(2, 0, 'utxo', '2'),
  event(3, 0, 'history', '3'), event(4, 0, 'utxo', '3')]) {
  // Deliberately preserve a non-sorted native group. Cursors bind the original
  // membership, not the order or subset of accounts already ready for display.
  const groups = [[members[0]], [members[2], members[1]]].map((accounts, index) => ({
    addresses: accounts.map(account => account.address), sync: journal(`seed-${index}`),
    histories: accounts.map(account => envelope(account.address, [history(account.index + 1)])),
  }));
  const gates = members.map(deferred), waits = new Map(), publications = [], calls = [], freshCheckpoints = [];
  let sequence = 2, phase = 'baseline', transform = value => value;
  const publish = (sync, selected) => {
    publications.push({ sync, selected: selected.map(account => account.address) });
    waits.get(selected.length)?.resolve();
  };
  const request = async (method, params) => {
    if (method === 'getaddressutxos') {
      const index = members.findIndex(account => account.address === params.address);
      assert.notEqual(index, -1); await gates[index].promise;
      return envelope(params.address, [utxo(index + 1)]);
    }
    assert.equal(method, 'getaddresschanges', 'Private history seeds must not be downloaded again');
    if (!Object.hasOwn(params, 'cursor')) {
      freshCheckpoints.push([...params.addresses]);
      throw new Error('Fresh checkpoint deliberately unavailable in this recovery fixture');
    }
    const group = params.addresses.includes(walletId) ? 0 : 1;
    assert.deepEqual([...params.addresses].sort(), [...groups[group].addresses].sort());
    const parts = params.cursor.split('-');
    const from = parts[0] === 'seed' ? 0 : Number(parts[2]);
    const through = parts[0] === 'page' ? Number(parts[3]) : sequence;
    const remaining = events.filter(item => params.addresses.includes(item.address) && item.sequence > from && item.sequence <= through);
    const changes = remaining.slice(0, 1), more = remaining.length > 1;
    const next = more ? `page-${group}-${changes[0].sequence}-${through}` : `tail-${group}-${through}`;
    const response = transform(journal(next, changes, through, more), { method, params, phase, group });
    calls.push({ phase, group, cursor: params.cursor, events: response.changes.length,
      bytes: new TextEncoder().encode(JSON.stringify(response)).length });
    return response;
  };
  const session = new HdWalletSession({ query: request,
    readRecoverySnapshots: async () => ({ walletId, groups }),
    onChange: state => { if (state.partial) waits.get(state.verifiedAddresses.length)?.resolve(); },
  });
  return {
    session, groups, gates, publications, calls, freshCheckpoints, rpc: { request },
    waitFor(count) { if (!waits.has(count)) waits.set(count, deferred()); return waits.get(count).promise; },
    setSequence(value) { sequence = value; },
    setPhase(value) { phase = value; },
    setTransform(value) { transform = value; },
    start(check = () => {}) { return session.baseline({ rpc: { request }, accounts: members, address: walletId,
      check, progress: () => {}, publishPartial: publish }); },
    load() { return session.loadWallet({ accountScope: 'hd-wallet', walletId, account: members[0], accounts: members,
      hd: { complete: true, recovering: false } }); },
    originalCandidate() {
      const state = addressSyncFromCheckpoints({ network: 'main', addresses: members.map(account => account.address), checkpoints: groups });
      for (const account of members) setAddressBaseline(state, account.address,
        { history: [history(account.index + 1)], utxos: [utxo(account.index + 1)] });
      return state;
    },
  };
}

test('complete partial groups retain whole checkpoints and avoid downloading old pages while accepting later events', async t => {
  const f = fixture(), ready = f.waitFor(1), work = f.start();
  f.gates[0].resolve(); await ready;
  const partial = f.publications.at(-1).sync, originalPartial = structuredClone(partial);
  f.gates[1].resolve(); f.gates[2].resolve();
  const { candidate } = await work;
  assert.equal(candidate.batches[0], partial.batches[0]);
  assert.equal(candidate.addresses.get(walletId), partial.addresses.get(walletId));
  assert.equal(candidate.batches[1].cursor, 'seed-1');
  assert.equal(candidate.addresses.size, 3); assert.equal(candidate.batches.length, 2);
  assert.equal(f.groups[0].sync.next_cursor, 'seed-0');
  f.setSequence(4); f.setPhase('retained-final');
  const final = await updateAddressSync(candidate, { rpc: f.rpc, check: () => {} });
  f.setPhase('original-final');
  const original = await updateAddressSync(f.originalCandidate(), { rpc: f.rpc, check: () => {} });
  assert.deepEqual(final, original); assert.deepEqual(partial, originalPartial);
  assert.equal(hdSnapshot(final, members, walletId).balance.total, '5');
  const retained = f.calls.filter(call => call.phase === 'retained-final'), old = f.calls.filter(call => call.phase === 'original-final');
  assert.deepEqual([...new Set(retained.map(call => call.group))], [0, 1], 'ALL groups still receive their final delta');
  assert.equal(retained.length, 3); assert.equal(old.length, 5);
  assert.equal(retained.reduce((sum, call) => sum + call.events, 0), 2);
  assert.equal(old.reduce((sum, call) => sum + call.events, 0), 4);
  const bytes = rows => rows.reduce((sum, call) => sum + call.bytes, 0);
  assert.ok(bytes(retained) < bytes(old));
  t.diagnostic(`Same final snapshot: ${old.length}→${retained.length} pages, 4→2 events, ${bytes(old)}→${bytes(retained)} JSON payload bytes`);
});

test('a group represented in the last partial still keeps its original checkpoint until EVERY member was ready there', async () => {
  const f = fixture([event(1, 0, 'history', '2'), event(2, 2, 'utxo', '7')]);
  const first = f.waitFor(1), second = f.waitFor(2), work = f.start();
  f.gates[1].resolve(); await first;
  f.gates[0].resolve(); await second;
  const partial = f.publications.at(-1).sync;
  assert.equal(partial.addresses.get(members[2].address).history.size, 0);
  assert.equal(partial.addresses.get(members[2].address).utxos.size, 1, 'A journal event is not a complete baseline');
  f.gates[2].resolve(); const { candidate } = await work;
  assert.equal(candidate.batches[0].cursor, 'tail-0-2');
  assert.equal(candidate.batches[1].cursor, 'seed-1');
  assert.equal(candidate.addresses.get(members[2].address).history.size, 1);
  assert.equal(candidate.addresses.get(members[2].address).utxos.get(`${hash(3)}:0`).amount, '1');
  const final = await updateAddressSync(candidate, { rpc: f.rpc, check: () => {} });
  assert.equal(final.addresses.get(members[2].address).utxos.get(`${hash(3)}:0`).amount, '7');
  assert.equal(hdSnapshot(final, members, walletId).history.length, 3);
});

test('late invalid frozen pages do not mutate a retained partial or publish a complete journal', async () => {
  const f = fixture(), ready = f.waitFor(1), work = f.start();
  f.gates[0].resolve(); await ready; f.gates[1].resolve(); f.gates[2].resolve();
  const { candidate } = await work, before = structuredClone(candidate);
  f.setSequence(4); f.setTransform((value, { params }) => params.cursor.startsWith('page-0-3-')
    ? { ...value, through_sequence: value.through_sequence + 1 } : value);
  await assert.rejects(updateAddressSync(candidate, { rpc: f.rpc, check: () => {} }), { code: -32011 });
  assert.deepEqual(candidate, before); assert.equal(f.session.journal, null);
  assert.equal(f.publications.at(-1).sync.addresses.get(walletId).history.get(hash(1)).received, '2');
});

test('a final busy candidate retains ALL baseline groups and retries only deltas without changing retained snapshots', async () => {
  const f = fixture(), ready = f.waitFor(1), work = f.start();
  f.gates[0].resolve(); await ready; f.gates[1].resolve(); f.gates[2].resolve();
  const { candidate } = await work, before = structuredClone(candidate);
  let sequence = 2, busy;
  const moving = { request: async (_, params) => journal(`moving-${++sequence}`, [], sequence) };
  await assert.rejects(updateAddressSync(candidate, { rpc: moving, check: () => {} }), error => {
    busy = error.candidate; return error.code === 'ADDRESS_SYNC_BUSY';
  });
  assert.equal(busy.addresses.size, 3); assert.equal(busy.batches.length, 2);
  assert.deepEqual(busy.batches.flatMap(batch => batch.addresses).sort(), members.map(account => account.address).sort());
  const groups = [];
  const final = await updateAddressSync(busy, { rpc: { request: async (_, params) => {
    groups.push(params.addresses); return journal('stable', [], sequence);
  } }, check: () => {} });
  assert.equal(groups.length, 2); assert.ok(final.batches.every(batch => batch.throughSequence === sequence));
  assert.deepEqual(candidate, before); assert.equal(hdSnapshot(final, members, walletId).history.length, 3);
});

test('an expired retained cursor cannot publish complete funds and recovery retries only a fresh baseline', async () => {
  const f = fixture(), ready = f.waitFor(1), loading = f.load();
  f.gates[0].resolve(); await ready;
  f.setTransform((value, { params }) => {
    if (params.cursor.startsWith('tail-0-')) throw Object.assign(new Error('expired'), { code: -32011 });
    return value;
  });
  // A fresh baseline must ask for new checkpoints, not keep the expired
  // recovered one. This fixture refuses that new RPC to keep funds unverified.
  f.gates[1].resolve(); f.gates[2].resolve();
  assert.equal(await loading, false);
  assert.equal(f.session.recoveryConsumed, true);
  assert.equal(f.session.journal, null); assert.equal(f.session.state.stale, true);
  assert.deepEqual(f.session.state.verifiedAddresses, []);
  assert.deepEqual(f.session.state.fundingAddresses, []);
  assert.deepEqual(f.freshCheckpoints, [members.map(account => account.address)]);
});

test('lock or reorg after a partial cannot promote retained groups or resurrect a complete balance', async () => {
  for (const action of ['lock', 'reorg']) {
    const f = fixture(), ready = f.waitFor(1), loading = f.load();
    f.gates[0].resolve(); await ready;
    assert.equal(f.session.state.partial, true); assert.equal(f.session.journal, null);
    if (action === 'lock') f.session.clearAccount();
    else f.session.observeTip({ ...tip, hash: hash(201) }, { reset: true });
    f.gates[1].resolve(); f.gates[2].resolve();
    assert.equal(await loading, false); assert.equal(f.session.journal, null);
    assert.deepEqual(f.session.state.verifiedAddresses ?? [], []);
    assert.deepEqual(f.session.state.fundingAddresses ?? [], []);
    assert.equal(f.session.pendingRefreshes, 0);
  }
});

test('lock or reorg during the retained group final response cannot commit the complete candidate', async () => {
  for (const action of ['lock', 'reorg']) {
    const f = fixture(), ready = f.waitFor(1), loading = f.load();
    f.gates[0].resolve(); await ready;
    let invalidations = 0;
    f.setTransform((value, { params }) => {
      if (params.cursor.startsWith('tail-0-')) {
        invalidations++;
        if (action === 'lock') f.session.clearAccount();
        else f.session.observeTip({ ...tip, hash: hash(201) }, { reset: true });
      }
      return value;
    });
    f.gates[1].resolve(); f.gates[2].resolve();
    assert.equal(await loading, false); assert.equal(invalidations, 1);
    assert.equal(f.session.journal, null); assert.equal(f.session.pendingRefreshes, 0);
    assert.deepEqual(f.session.state.verifiedAddresses ?? [], []);
    assert.deepEqual(f.session.state.fundingAddresses ?? [], []);
  }
});
