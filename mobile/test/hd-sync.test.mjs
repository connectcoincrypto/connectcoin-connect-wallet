import test from 'node:test';
import assert from 'node:assert/strict';
import { MAINNET_GENESIS } from '../src/model.mjs';
import { beginAddressSync, setAddressBaseline, updateAddressSync, addressSyncSnapshot, syncHistoryRow, syncUtxoRow, addressSetKey } from '../src/hd-sync.mjs';

const tip = { chain: 'main', height: 100, hash: 'a'.repeat(64), mediantime: 1789500000, genesis_hash: MAINNET_GENESIS };
const addr = 'tcc1publicfixtureaddress';
const hash = i => i.toString(16).padStart(64, '0');
const history = (i, extra = {}) => ({ txid: hash(i), status: 'confirmed', block_height: 90, block_hash: hash(900), confirmations: 11, received: '100', spent: '0', balance_delta: '100', ...extra });
const utxo = (i, extra = {}) => ({ txid: hash(i), vout: 0, amount: '100', block_height: 90, status: 'confirmed', confirmations: 11, coinbase: false, mature: true, pending_spent_by: null, ...extra });
const page = (changes = [], extra = {}) => ({ tip, unit: 'connects', changes, next_cursor: 'cursor1', has_more: false, through_sequence: 100, journal_epoch: 1, ...extra });
const event = (sequence, kind, action, item, extra = {}) => ({ sequence, address: addr, kind, action, txid: item.txid,
  ...(kind === 'utxo' ? { vout: item.vout } : {}), ...(action === 'upsert' ? { item } : {}), ...extra });
const check = () => {};
async function fixture() {
  const state = await beginAddressSync({ rpc: { request: async () => page([], { next_cursor: 'start', through_sequence: 0 }) }, network: 'main', addresses: [addr], check });
  setAddressBaseline(state, addr, { history: [history(1)], utxos: [utxo(1)] });
  return state;
}

test('watermarks bind canonical address batches before baseline reads', async () => {
  const calls = [], addresses = Array.from({ length: 101 }, (_, i) => `address${String(i).padStart(3, '0')}`).reverse();
  const state = await beginAddressSync({ rpc: { request: async (method, params) => { calls.push({ method, params }); return page([], { next_cursor: `cursor${calls.length}` }); } }, network: 'main', addresses, check });
  assert.deepEqual(calls.map(call => call.params.addresses.length), [100, 1]);
  assert.equal(calls[0].params.addresses[0], 'address000');
  assert.ok(calls.every(call => call.method === 'getaddresschanges' && !('cursor' in call.params)));
  assert.equal(state.addresses.size, 101);
  await assert.rejects(beginAddressSync({ rpc: {}, network: 'main', addresses: [addr, addr], check }), /invalid address synchronization/);
});

test('empty baseline preserves all map identities and existing rows, including a frozen owner', async () => {
  const state = await fixture(), addresses = state.addresses, rows = addresses.get(addr);
  const original = structuredClone(state);
  Object.freeze(rows); Object.freeze(state);
  assert.equal(setAddressBaseline(state, addr, { history: Object.freeze([]), utxos: Object.freeze([]) }), undefined);
  assert.equal(state.addresses, addresses); assert.equal(state.addresses.get(addr), rows);
  assert.equal(state.addresses.get(addr).history, rows.history); assert.equal(state.addresses.get(addr).utxos, rows.utxos);
  assert.deepEqual(state, original);

  const empty = await beginAddressSync({ rpc: { request: async () => page() }, network: 'main', addresses: [addr], check });
  const emptyAddresses = empty.addresses, emptyRows = emptyAddresses.get(addr);
  setAddressBaseline(empty, addr, { history: [], utxos: [] });
  assert.equal(empty.addresses, emptyAddresses); assert.equal(empty.addresses.get(addr), emptyRows);
  assert.equal(emptyRows.history.size, 0); assert.equal(emptyRows.utxos.size, 0);
});

test('empty baseline still rejects missing addresses, malformed arrays and oversized input before mutation', async () => {
  const state = await fixture(), addresses = state.addresses, original = structuredClone(state);
  assert.throws(() => setAddressBaseline(state, 'missing', { history: [], utxos: [] }), /invalid address synchronization/);
  for (const input of [
    { history: null, utxos: [] }, { history: [], utxos: {} },
    { history: { length: 0 }, utxos: [] }, { history: [], utxos: { length: 0 } },
    { history: new Array(20001), utxos: [] }, { history: [], utxos: new Array(20001) },
  ]) assert.throws(() => setAddressBaseline(state, addr, input), /invalid address synchronization/);
  assert.equal(state.addresses, addresses); assert.deepEqual(state, original);
});

test('empty baseline checks preexisting per-address and aggregate limits without changing the owner', () => {
  const rows = new Map(Array.from({ length: 20001 }, (_, index) => [index, null]));
  const exact = new Map([...rows].slice(0, 20000));
  for (const addresses of [
    new Map([[addr, { history: new Map(), utxos: new Map() }], ['other', { history: rows, utxos: new Map() }]]),
    new Map([[addr, { history: new Map(), utxos: new Map() }], ['other', { history: new Map(), utxos: rows }]]),
    new Map(Array.from({ length: 6 }, (_, index) => [index ? `other${index}` : addr, { history: exact, utxos: exact }])),
  ]) {
    const state = Object.freeze({ addresses }), before = [...addresses];
    assert.throws(() => setAddressBaseline(state, addr, { history: [], utxos: [] }), /local resource limit/);
    assert.equal(state.addresses, addresses); assert.deepEqual([...addresses], before);
  }
});

test('partial replay indexes only original groups, rejects invalid selections and keeps canonical batch order', async () => {
  const addresses = Array.from({ length: 205 }, (_, index) => `address${String(index).padStart(3, '0')}`);
  const state = await beginAddressSync({ rpc: { request: async () => page([], { next_cursor: 'start' }) }, network: 'main', addresses, check });
  const keys = state.batches.map(batch => addressSetKey(batch.addresses));
  for (const initialBatches of [[], [keys[0], keys[0]], [keys[0], 'foreign'], [keys[0], addressSetKey(addresses.slice(1, 101))]]) {
    let calls = 0;
    await assert.rejects(updateAddressSync(state, { rpc: { request: async () => { calls++; return page(); } }, check, initialBatches }), /invalid address synchronization/);
    assert.equal(calls, 0); assert.equal(state.batches[0].cursor, 'start');
  }
  const calls = [];
  const next = await updateAddressSync(state, { rpc: { request: async (_, params) => {
    calls.push({ addresses: [...params.addresses], cursor: params.cursor }); return page([], { next_cursor: 'updated' });
  } }, check, initialBatches: [keys[2], keys[0]] });
  assert.deepEqual(calls, [0, 2].map(index => ({ addresses: state.batches[index].addresses, cursor: 'start' })));
  assert.deepEqual(next.batches.map(batch => batch.cursor), ['updated', 'start', 'updated']);
  assert.deepEqual(state.batches.map(batch => batch.cursor), ['start', 'start', 'start']);
});

test('partial replay selection still converges an unselected older group and validates its frozen pages', async () => {
  const addresses = Array.from({ length: 101 }, (_, index) => `address${String(index).padStart(3, '0')}`);
  const state = await beginAddressSync({ rpc: { request: async () => page([], { next_cursor: 'start', through_sequence: 0 }) }, network: 'main', addresses, check });
  const selected = addressSetKey(state.batches[1].addresses), calls = [];
  const next = await updateAddressSync(state, { rpc: { request: async (_, params) => {
    calls.push({ group: params.addresses.length, cursor: params.cursor });
    if (params.addresses.length === 1) return page([], { next_cursor: 'selected', through_sequence: 2 });
    if (params.cursor === 'start') return page([event(1, 'history', 'upsert', history(1), { address: params.addresses[0] })],
      { next_cursor: 'frozen', has_more: true, through_sequence: 2 });
    return page([event(2, 'utxo', 'upsert', utxo(1), { address: params.addresses[0] })], { next_cursor: 'complete', through_sequence: 2 });
  } }, check, initialBatches: [selected] });
  assert.deepEqual(calls, [{ group: 1, cursor: 'start' }, { group: 100, cursor: 'start' }, { group: 100, cursor: 'frozen' }]);
  assert.deepEqual(next.batches.map(batch => batch.throughSequence), [2, 2]);
  assert.equal(next.addresses.get(addresses[0]).history.size, 1);
  assert.equal(next.addresses.get(addresses[0]).utxos.size, 1);
  assert.equal(state.addresses.get(addresses[0]).history.size, 0);
});

test('pending-spent confirmed outputs remain visible and balances exclude their pending spend', async () => {
  const state = await fixture();
  setAddressBaseline(state, addr, { history: [], utxos: [
    utxo(1, { amount: '100', pending_spent_by: hash(10) }),
    utxo(2, { amount: '30', status: 'pending', block_height: null, confirmations: 0 }),
    utxo(3, { amount: '20', status: 'pending', block_height: null, confirmations: 0, pending_spent_by: hash(11) }),
    utxo(4, { amount: '40', coinbase: true, mature: false }),
  ] });
  const snapshot = addressSyncSnapshot(state, [{ address: addr, change: 0, index: 0 }]);
  assert.equal(snapshot.utxos.length, 4);
  assert.equal(snapshot.utxos[0].pending_spent_by, hash(10));
  assert.deepEqual(snapshot.totals, { confirmed: 140n, available: 0n, pending: -70n, immature: 40n });
});

test('empty delta advances confirmations and coinbase maturity without downloading historical rows', async () => {
  const state = await fixture();
  setAddressBaseline(state, addr, { history: [], utxos: [utxo(1, { block_height: 2, coinbase: true, mature: false, confirmations: 99 })] });
  const next = await updateAddressSync(state, { rpc: { request: async () => page([], { tip: { ...tip, height: 101, hash: hash(901) } }) }, check });
  const snapshot = addressSyncSnapshot(next, [{ address: addr, change: 0, index: 0 }]);
  assert.equal(snapshot.utxos[0].confirmations, 100);
  assert.equal(snapshot.utxos[0].mature, true);
  assert.equal(snapshot.totals.available, 100n);
  assert.equal(snapshot.history.get(hash(1)).confirmations, 12);
});

test('journal replays deletion, replacement, and pending-spend restoration at unchanged block hash', async () => {
  const state = await fixture();
  const newPending = history(2, { status: 'pending', block_height: null, block_hash: null, confirmations: 0 });
  const responses = [page([
    event(1, 'utxo', 'upsert', utxo(1, { pending_spent_by: hash(2) })),
    event(2, 'history', 'upsert', newPending),
  ], { next_cursor: 'middle', has_more: true }), page([
    event(3, 'history', 'remove', newPending),
    event(4, 'utxo', 'upsert', utxo(1)),
    event(5, 'utxo', 'upsert', utxo(3, { status: 'pending', block_height: null, confirmations: 0 })),
  ], { next_cursor: 'end' })];
  const calls = [];
  const next = await updateAddressSync(state, { rpc: { request: async (_, params) => { calls.push(params.cursor); return responses.shift(); } }, check });
  assert.deepEqual(calls, ['start', 'middle']);
  assert.equal(next.batches[0].cursor, 'end');
  assert.equal(next.addresses.get(addr).history.has(hash(2)), false);
  assert.equal(next.addresses.get(addr).utxos.get(`${hash(1)}:0`).pending_spent_by, null);
  assert.equal(next.addresses.get(addr).utxos.size, 2);
  assert.equal(state.batches[0].cursor, 'start');
  assert.equal(state.addresses.get(addr).utxos.size, 1);
});

test('malformed second delta page does not publish any first-page mutation or cursor', async () => {
  const state = await fixture(); let calls = 0;
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => ++calls === 1
    ? page([event(1, 'utxo', 'remove', utxo(1))], { next_cursor: 'middle', has_more: true })
    : page([event(1, 'history', 'remove', history(1))], { next_cursor: 'end' }) }, check }), /invalid address synchronization/);
  assert.equal(state.batches[0].cursor, 'start');
  assert.equal(state.addresses.get(addr).utxos.size, 1);
  assert.equal(state.addresses.get(addr).history.size, 1);
});

test('cancellation after response leaves cached rows and cursors untouched', async () => {
  const state = await fixture(); let cancelled = false;
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => { cancelled = true; return page([event(1, 'utxo', 'remove', utxo(1))]); } },
    check: () => { if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); } }), { name: 'AbortError' });
  assert.equal(state.batches[0].cursor, 'start'); assert.equal(state.addresses.get(addr).utxos.size, 1);
});

test('a later refresh cannot replay an earlier sequence or return changes without advancing its cursor', async () => {
  const state = await fixture();
  const next = await updateAddressSync(state, { rpc: { request: async () => page([event(7, 'utxo', 'upsert', utxo(1))]) }, check });
  await assert.rejects(updateAddressSync(next, { rpc: { request: async () => page([event(7, 'utxo', 'remove', utxo(1))], { next_cursor: 'cursor2' }) }, check }), /invalid address synchronization/);
  await assert.rejects(updateAddressSync(next, { rpc: { request: async () => page([event(8, 'utxo', 'remove', utxo(1))]) }, check }), /invalid address synchronization/);
  assert.equal(next.addresses.get(addr).utxos.size, 1);
});

for (const [name, result] of [
  ['wrong address', page([event(1, 'history', 'upsert', history(1), { address: 'foreignaddress' })])],
  ['mismatched row hash', page([event(1, 'history', 'upsert', history(1), { txid: hash(2) })])],
  ['mismatched outpoint', page([event(1, 'utxo', 'upsert', utxo(1), { vout: 2 })])],
  ['unsafe sequence', page([event(Number.MAX_SAFE_INTEGER + 1, 'utxo', 'remove', utxo(1))])],
  ['empty continuation', page([], { has_more: true })],
  ['unmoving continuation cursor', page([event(1, 'utxo', 'remove', utxo(1))], { has_more: true, next_cursor: 'start' })],
  ['remove carrying item', page([event(1, 'history', 'remove', history(1), { item: history(1) })])],
  ['wrong network', page([], { tip: { ...tip, chain: 'testnet4' } })],
]) test(`rejects ${name} without changing the cache`, async () => {
  const state = await fixture();
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => result }, check }));
  assert.equal(state.batches[0].cursor, 'start'); assert.equal(state.addresses.get(addr).utxos.size, 1);
});

test('reorg or expired cursor is forwarded to service for complete resync', async () => {
  const state = await fixture();
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => { throw Object.assign(new Error('stale'), { code: -32011 }); } }, check }), { code: -32011 });
  assert.equal(state.batches[0].cursor, 'start');
});

test('multi-page journal cannot silently switch its frozen chain tip', async () => {
  const state = await fixture(); let calls = 0;
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => ++calls === 1
    ? page([event(1, 'utxo', 'remove', utxo(1))], { next_cursor: 'middle', has_more: true })
    : page([], { tip: { ...tip, hash: hash(999) }, next_cursor: 'end' }) }, check }), { code: -32011 });
});

test('untrusted history amounts and UTXO markers are checked before caching', () => {
  for (const row of [history(1, { balance_delta: '99' }), history(1, { received: '-1' }), history(1, { block_height: -1 }), history(1, { block_hash: 'bad' }), history(1, { txid: [hash(1)] }), history(1, { block_hash: [hash(1)] })]) assert.throws(() => syncHistoryRow(row));
  for (const row of [utxo(1, { pending_spent_by: undefined }), utxo(1, { pending_spent_by: 'bad' }), utxo(1, { pending_spent_by: [hash(1)] }), utxo(1, { vout: -1 }), utxo(1, { coinbase: 'false' }), utxo(1, { amount: '1000000000000000001' })]) assert.throws(() => syncUtxoRow(row));
});

test('mixed confirmation state for one transaction across addresses requires resync', async () => {
  const other = `${addr}other`;
  const state = await beginAddressSync({ rpc: { request: async () => page() }, network: 'main', addresses: [addr, other], check });
  setAddressBaseline(state, addr, { history: [history(1)], utxos: [] });
  setAddressBaseline(state, other, { history: [history(1, { status: 'pending', block_hash: null, block_height: null, confirmations: 0 })], utxos: [] });
  assert.throws(() => addressSyncSnapshot(state, [{ address: addr, change: 0, index: 0 }, { address: other, change: 1, index: 0 }]), { code: -32011 });
});

async function largeFixture() {
  const addresses = Array.from({ length: 101 }, (_, i) => `address${String(i).padStart(3, '0')}`);
  const state = await beginAddressSync({ rpc: { request: async () => page([], { next_cursor: 'start', through_sequence: 0 }) }, network: 'main', addresses, check });
  return { state, addresses, accounts: addresses.map((address, index) => ({ address, index, change: 0 })) };
}

test('ordinary block advancement between address batches converges with deltas, not a baseline reset', async () => {
  const { state } = await largeFixture(); let calls = 0;
  const nextTip = { ...tip, height: tip.height + 1, hash: hash(101) };
  const next = await updateAddressSync(state, { rpc: { request: async () => page([], { tip: ++calls === 1 ? tip : nextTip, through_sequence: 0, next_cursor: `cursor${calls}` }) }, check });
  assert.equal(calls, 3); assert.equal(next.tip.hash, nextTip.hash);
  assert.ok(next.batches.every(batch => batch.tip.hash === nextTip.hash));
});

test('same-tip mempool transfer across address batches cannot inflate wallet funds', async () => {
  const { state, addresses, accounts } = await largeFixture();
  const source = addresses[0], destination = addresses[100];
  setAddressBaseline(state, source, { history: [], utxos: [utxo(1)] });
  let calls = 0;
  const next = await updateAddressSync(state, { rpc: { request: async () => {
    calls++;
    if (calls === 1) return page([], { through_sequence: 0, next_cursor: 'source-before-spend' });
    if (calls === 2) return page([event(2, 'utxo', 'upsert', utxo(2, { amount: '90', status: 'pending', block_height: null, confirmations: 0 }), { address: destination })], { through_sequence: 2, next_cursor: 'destination-after-spend' });
    return page([event(1, 'utxo', 'upsert', utxo(1, { pending_spent_by: hash(2) }), { address: source })], { through_sequence: 2, next_cursor: 'source-after-spend' });
  } }, check });
  assert.equal(calls, 3);
  assert.deepEqual(addressSyncSnapshot(next, accounts).totals, { confirmed: 100n, available: 0n, pending: -10n, immature: 0n });
  assert.ok(next.batches.every(batch => batch.throughSequence === 2));
  assert.equal(state.addresses.get(source).utxos.get(`${hash(1)}:0`).pending_spent_by, null);
});

test('continuous view drift has bounded work and retains a private candidate for delta-only retry', async () => {
  const { state } = await largeFixture(); let calls = 0, pending;
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => page([], { through_sequence: ++calls, next_cursor: `drift${calls}` }) }, check }), error => {
    assert.equal(error.code, 'ADDRESS_SYNC_BUSY'); pending = error.candidate; return true;
  });
  assert.equal(calls, 4); assert.ok(pending); assert.equal(state.batches[0].cursor, 'start');
  const next = await updateAddressSync(pending, { rpc: { request: async () => page([], { through_sequence: calls, next_cursor: 'stable' }) }, check });
  assert.ok(next.batches.every(batch => batch.throughSequence === 4));
});

test('journal epoch mismatch is a genuine resync, even with equal tip and sequence', async () => {
  const state = await fixture();
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => page([], { through_sequence: 0, journal_epoch: 2 }) }, check }), { code: -32011 });
});

test('a matching hash cannot conceal contradictory height or median time in a delta', async () => {
  for (const patch of [{ height: tip.height + 1 }, { mediantime: tip.mediantime + 1 }]) {
    const state = await fixture();
    await assert.rejects(updateAddressSync(state, { rpc: { request: async () => page([], { tip: { ...tip, ...patch } }) }, check }));
    assert.equal(state.batches[0].cursor, 'start');
  }
});

test('copy-on-write shares an untouched outer map while all journal metadata advances privately', async () => {
  const state = await fixture();
  const next = await updateAddressSync(state, { rpc: { request: async () => page([], { next_cursor: 'new', through_sequence: 3 }) }, check });
  assert.notEqual(next, state); assert.equal(next.addresses, state.addresses);
  assert.notEqual(next.batches[0], state.batches[0]);
  assert.equal(next.addresses.get(addr).history, state.addresses.get(addr).history);
  assert.equal(next.addresses.get(addr).utxos, state.addresses.get(addr).utxos);
  assert.equal(state.batches[0].cursor, 'start'); assert.equal(next.batches[0].cursor, 'new');
  assert.equal(next.batches[0].throughSequence, 3);
});

test('only the mutated address and row kind are copied, including disjoint sibling updates', async () => {
  const other = addr + '-other';
  const state = await beginAddressSync({ rpc: { request: async () => page([], { next_cursor: 'start', through_sequence: 0 }) },
    network: 'main', addresses: [addr, other], check });
  for (const address of [addr, other]) setAddressBaseline(state, address, { history: [history(1)], utxos: [utxo(1)] });
  const left = await updateAddressSync(state, { rpc: { request: async () => page([event(1, 'history', 'upsert', history(2))]) }, check });
  const right = await updateAddressSync(state, { rpc: { request: async () => page([
    event(1, 'utxo', 'remove', utxo(1), { address: other }),
  ]) }, check });
  assert.notEqual(left.addresses, state.addresses); assert.notEqual(right.addresses, state.addresses);
  assert.notEqual(left.addresses, right.addresses);
  assert.notEqual(left.addresses.get(addr).history, state.addresses.get(addr).history);
  assert.equal(left.addresses.get(addr).utxos, state.addresses.get(addr).utxos);
  assert.equal(left.addresses.get(other), state.addresses.get(other));
  assert.notEqual(right.addresses.get(other).utxos, state.addresses.get(other).utxos);
  assert.equal(right.addresses.get(other).history, state.addresses.get(other).history);
  assert.equal(right.addresses.get(addr), state.addresses.get(addr));
  assert.equal(state.addresses.get(addr).history.size, 1); assert.equal(right.addresses.get(addr).history.size, 1);
  assert.equal(left.addresses.get(other).utxos.size, 1); assert.equal(right.addresses.get(other).utxos.size, 0);
});

test('baseline writers detach shared maps without mutating earlier journal siblings', async () => {
  const state = await fixture();
  const shallow = { ...state };
  const next = await updateAddressSync(state, { rpc: { request: async () => page() }, check });
  setAddressBaseline(state, addr, { history: [history(2)], utxos: [] });
  assert.equal(state.addresses.get(addr).history.size, 2); assert.equal(next.addresses.get(addr).history.size, 1);
  assert.equal(shallow.addresses.get(addr).history.size, 1); assert.notEqual(state.addresses, shallow.addresses);
  setAddressBaseline(next, addr, { history: [], utxos: [utxo(2)] });
  assert.equal(next.addresses.get(addr).utxos.size, 2); assert.equal(state.addresses.get(addr).utxos.size, 1);
  const before = next.addresses.get(addr);
  assert.throws(() => setAddressBaseline(next, addr, { history: [history(3), history(4, { balance_delta: '99' })], utxos: [] }));
  assert.equal(next.addresses.get(addr), before); assert.equal(before.history.has(hash(3)), false);
});

test('a baseline replacement during an awaited delta cannot change ownership of its borrowed snapshot', async () => {
  const state = await fixture(), borrowed = state.addresses, sibling = { ...state };
  let release;
  const responseReady = new Promise(resolve => { release = resolve; });
  const operation = updateAddressSync(state, { rpc: { request: async () => responseReady }, check });
  setAddressBaseline(state, addr, { history: [history(3)], utxos: [utxo(3)] });
  release(page([event(1, 'history', 'upsert', history(2)), event(2, 'utxo', 'remove', utxo(1))]));
  const next = await operation;
  assert.notEqual(next.addresses, borrowed); assert.notEqual(next.addresses, state.addresses);
  assert.deepEqual([...next.addresses.get(addr).history.keys()], [hash(1), hash(2)]);
  assert.equal(next.addresses.get(addr).utxos.size, 0);
  assert.deepEqual([...state.addresses.get(addr).history.keys()], [hash(1), hash(3)]);
  assert.deepEqual([...state.addresses.get(addr).utxos.keys()], [`${hash(1)}:0`, `${hash(3)}:0`]);
  assert.equal(sibling.addresses, borrowed); assert.equal(borrowed.get(addr).history.size, 1);
  assert.equal(borrowed.get(addr).utxos.size, 1); assert.equal(state.batches[0].cursor, 'start');
});

test('a dirty busy candidate owns its maps and a later delta retry detaches from that candidate', async () => {
  const { state, addresses } = await largeFixture(); let calls = 0, candidate;
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => {
    calls++;
    return page(calls === 1 ? [event(1, 'history', 'upsert', history(1), { address: addresses[0] })] : [],
      { through_sequence: calls, next_cursor: `busy${calls}` });
  } }, check }), error => { candidate = error.candidate; return error.code === 'ADDRESS_SYNC_BUSY'; });
  assert.equal(calls, 4); assert.notEqual(candidate.addresses, state.addresses);
  assert.equal(state.addresses.get(addresses[0]).history.size, 0);
  const next = await updateAddressSync(candidate, { rpc: { request: async (_, params) => page(
    params.addresses.includes(addresses[0]) ? [event(5, 'history', 'upsert', history(2), { address: addresses[0] })] : [],
    { through_sequence: 5, next_cursor: 'stable' }) }, check });
  assert.ok(next.batches.every(batch => batch.throughSequence === 5));
  assert.notEqual(next.addresses, candidate.addresses);
  assert.deepEqual([...candidate.addresses.get(addresses[0]).history.keys()], [hash(1)]);
  assert.deepEqual([...next.addresses.get(addresses[0]).history.keys()], [hash(1), hash(2)]);
  assert.equal(state.batches[0].cursor, 'start'); assert.notEqual(candidate.batches[0].cursor, 'stable');
});

test('an unchanged outer map still receives all per-address and aggregate resource checks', async () => {
  const over = new Map(Array.from({ length: 20001 }, (_, index) => [index, null]));
  const exact = new Map([...over].slice(0, 20000));
  for (const [historyRows, utxoRows, extras] of [[over, new Map(), 0], [new Map(), over, 0], [exact, exact, 5]]) {
    const state = await fixture();
    state.addresses.set(addr, { history: historyRows, utxos: utxoRows });
    for (let index = 0; index < extras; index++) state.addresses.set(`extra${index}`, { history: exact, utxos: exact });
    const before = state.addresses;
    await assert.rejects(updateAddressSync(state, { rpc: { request: async () => page() }, check }), /local resource limit/);
    assert.equal(state.addresses, before); assert.equal(state.batches[0].cursor, 'start');
  }
});

test('baseline capacity rejection cannot publish maps or mutate a borrowed outer map', async () => {
  const state = await fixture(), addresses = state.addresses, before = addresses.get(addr);
  assert.throws(() => setAddressBaseline(state, addr, {
    history: Array.from({ length: 20000 }, (_, index) => history(index + 2)), utxos: [],
  }), /local resource limit/);
  assert.equal(state.addresses, addresses); assert.equal(addresses.get(addr), before);
  assert.equal(before.history.size, 1);
});

test('an absent removal validates and advances the cursor without copying unrelated rows', async () => {
  const state = await fixture();
  const next = await updateAddressSync(state, { rpc: { request: async () => page([event(1, 'history', 'remove', history(99))]) }, check });
  assert.equal(next.addresses.get(addr).history, state.addresses.get(addr).history);
  assert.equal(next.batches[0].throughSequence, 100);
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => page([
    event(1, 'history', 'remove', history(99), { item: history(99) }),
  ]) }, check }));
});


test('identical normalized upserts and absent removals reuse rows across pages while advancing metadata', async () => {
  const state = await fixture(), before = state.addresses.get(addr);
  const pages = [
    page([event(1, 'history', 'upsert', history(1, { received: '000100', spent: '00', balance_delta: '000100' })),
      event(2, 'utxo', 'remove', utxo(99))], { next_cursor: 'noop-middle', has_more: true }),
    page([event(3, 'utxo', 'upsert', utxo(1, { amount: '000100' })),
      event(4, 'history', 'remove', history(99)),
      event(5, 'history', 'upsert', history(1))], { next_cursor: 'noop-end' }),
  ];
  const next = await updateAddressSync(state, { rpc: { request: async () => pages.shift() }, check });
  assert.equal(pages.length, 0);
  assert.equal(next.addresses, state.addresses);
  assert.equal(next.addresses.get(addr), before);
  assert.equal(next.addresses.get(addr).history.get(hash(1)), before.history.get(hash(1)));
  assert.equal(next.addresses.get(addr).utxos.get(hash(1) + ':0'), before.utxos.get(hash(1) + ':0'));
  assert.equal(next.batches[0].cursor, 'noop-end');
  assert.equal(next.batches[0].throughSequence, 100);
  assert.equal(state.batches[0].cursor, 'start');
  assert.equal(state.batches[0].throughSequence, 0);
});

test('every changed canonical field still detaches and updates its history or UTXO map', async () => {
  const cases = [
    ['history', history(1, { confirmations: 12 })],
    ['history', history(1, { block_height: 89 })],
    ['history', history(1, { block_hash: hash(901) })],
    ['history', history(1, { received: '101', balance_delta: '101' })],
    ['history', history(1, { spent: '1', balance_delta: '99' })],
    ['history', history(1, { status: 'pending', block_height: null, block_hash: null, confirmations: 0 })],
    ['history', history(2)],
    ['utxo', utxo(1, { confirmations: 12 })],
    ['utxo', utxo(1, { block_height: 89 })],
    ['utxo', utxo(1, { amount: '101' })],
    ['utxo', utxo(1, { coinbase: true })],
    ['utxo', utxo(1, { mature: false })],
    ['utxo', utxo(1, { pending_spent_by: hash(2) })],
    ['utxo', utxo(1, { status: 'pending', block_height: null, confirmations: 0 })],
    ['utxo', utxo(1, { vout: 1 })],
    ['utxo', utxo(2)],
  ];
  for (const [kind, item] of cases) {
    const state = await fixture(), before = state.addresses.get(addr);
    const next = await updateAddressSync(state, { rpc: { request: async () => page([
      event(1, kind, 'upsert', item), event(2, kind, 'upsert', { ...item }),
    ]) }, check });
    const key = kind === 'history' ? item.txid : item.txid + ':' + item.vout;
    const map = kind === 'history' ? 'history' : 'utxos';
    const other = kind === 'history' ? 'utxos' : 'history';
    assert.notEqual(next.addresses.get(addr)[map], before[map]);
    assert.equal(next.addresses.get(addr)[other], before[other]);
    assert.deepEqual(next.addresses.get(addr)[map].get(key), kind === 'history' ? syncHistoryRow(item) : syncUtxoRow(item));
    assert.deepEqual(before.history.get(hash(1)), syncHistoryRow(history(1)));
    assert.deepEqual(before.utxos.get(hash(1) + ':0'), syncUtxoRow(utxo(1)));
  }
});

test('apparently repeated rows and absent removals never bypass item or event validation', async () => {
  const cases = [
    event(1, 'history', 'upsert', history(1, { confirmations: -1 })),
    event(1, 'history', 'upsert', history(1, { received: 100 })),
    event(1, 'history', 'upsert', history(1, { balance_delta: '99' })),
    event(1, 'history', 'upsert', history(1, { block_hash: [hash(900)] })),
    event(1, 'history', 'upsert', history(1), { txid: hash(2) }),
    event(1, 'utxo', 'upsert', utxo(1, { amount: 100 })),
    event(1, 'utxo', 'upsert', utxo(1, { pending_spent_by: undefined })),
    event(1, 'utxo', 'upsert', utxo(1, { mature: 'true' })),
    event(1, 'utxo', 'upsert', utxo(1), { vout: 2 }),
    event(1, 'history', 'remove', history(99), { item: history(99) }),
    event(1, 'utxo', 'remove', utxo(99), { vout: -1 }),
    event(1, 'history', 'upsert', history(1), { address: 'foreign' }),
  ];
  for (const item of cases) {
    const state = await fixture(), before = state.addresses;
    await assert.rejects(updateAddressSync(state, { rpc: { request: async () => page([item]) }, check }), /invalid address synchronization/);
    assert.equal(state.addresses, before);
    assert.equal(state.batches[0].cursor, 'start');
  }
});

test('no-op pages followed by an invalid page do not publish a cursor or alter shared rows', async () => {
  const state = await fixture(), before = state.addresses; let calls = 0;
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => ++calls === 1
    ? page([event(1, 'history', 'upsert', history(1))], { next_cursor: 'noop-middle', has_more: true })
    : page([event(1, 'utxo', 'upsert', utxo(1))], { next_cursor: 'noop-end' }) }, check }), /invalid address synchronization/);
  assert.equal(calls, 2); assert.equal(state.addresses, before);
  assert.equal(state.batches[0].cursor, 'start');
  assert.equal(state.batches[0].throughSequence, 0);
});

test('no-op rows do not conceal journal epoch or same-hash tip contradictions', async () => {
  for (const extra of [{ journal_epoch: 2 }, { tip: { ...tip, height: 101 } }, { tip: { ...tip, mediantime: tip.mediantime + 1 } }]) {
    const state = await fixture();
    await assert.rejects(updateAddressSync(state, { rpc: { request: async () => page([
      event(1, 'history', 'upsert', history(1)), event(2, 'utxo', 'upsert', utxo(1)),
    ], extra) }, check }));
    assert.equal(state.batches[0].cursor, 'start');
  }
});

test('no-op events at a new tip still recompute coinbase maturity from the complete tip', async () => {
  const state = await fixture(), coinbase = utxo(1, { block_height: 2, coinbase: true, mature: false, confirmations: 99 });
  setAddressBaseline(state, addr, { history: [], utxos: [coinbase] });
  const before = state.addresses.get(addr);
  const next = await updateAddressSync(state, { rpc: { request: async () => page([
    event(1, 'utxo', 'upsert', coinbase), event(2, 'history', 'upsert', history(1)),
  ], { tip: { ...tip, height: 101, hash: hash(101) } }) }, check });
  assert.equal(next.addresses.get(addr), before);
  const snapshot = addressSyncSnapshot(next, [{ address: addr, index: 0, change: 0 }]);
  assert.equal(snapshot.utxos[0].mature, true); assert.equal(snapshot.utxos[0].confirmations, 100);
  assert.equal(snapshot.totals.available, 100n);
  assert.equal(before.utxos.get(hash(1) + ':0').mature, false);
});

test('no-op events still consume the event work budget without publishing their cursors', async () => {
  const state = await fixture(), before = state.addresses; let sequence = 0, calls = 0;
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => {
    calls++;
    const count = Math.min(500, 100001 - sequence);
    const changes = Array.from({ length: count }, () => event(++sequence, 'utxo', 'remove', utxo(99)));
    return page(changes, { next_cursor: 'budget-' + calls, through_sequence: 100001, has_more: sequence < 100001 });
  } }, check }), /local resource limit/);
  assert.equal(sequence, 100001); assert.equal(calls, 201);
  assert.equal(state.addresses, before); assert.equal(state.batches[0].cursor, 'start');
});

test('no-op replay still checks cancellation after its response', async () => {
  const state = await fixture(); let cancelled = false;
  await assert.rejects(updateAddressSync(state, { rpc: { request: async () => {
    cancelled = true; return page([event(1, 'history', 'upsert', history(1))]);
  } }, check: () => { if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); } }), { name: 'AbortError' });
  assert.equal(state.batches[0].cursor, 'start'); assert.equal(state.batches[0].throughSequence, 0);
});
