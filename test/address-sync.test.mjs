import test from 'node:test';
import assert from 'node:assert/strict';
import { GENESIS } from '../src/core/config.mjs';
import { beginAddressSync, setAddressBaseline, updateAddressSync, addressSyncSnapshot, syncHistoryRow, syncUtxoRow } from '../src/core/address-sync.mjs';

const tip = { chain: 'testnet4', height: 100, hash: 'a'.repeat(64), mediantime: 1789500000, genesis_hash: GENESIS.testnet4 };
const addr = 'tcc1publicfixtureaddress';
const hash = i => i.toString(16).padStart(64, '0');
const history = (i, extra = {}) => ({ txid: hash(i), status: 'confirmed', block_height: 90, block_hash: hash(900), confirmations: 11, received: '100', spent: '0', balance_delta: '100', ...extra });
const utxo = (i, extra = {}) => ({ txid: hash(i), vout: 0, amount: '100', block_height: 90, status: 'confirmed', confirmations: 11, coinbase: false, mature: true, pending_spent_by: null, ...extra });
const page = (changes = [], extra = {}) => ({ tip, unit: 'connects', changes, next_cursor: 'cursor1', has_more: false, through_sequence: 100, journal_epoch: 1, ...extra });
const event = (sequence, kind, action, item, extra = {}) => ({ sequence, address: addr, kind, action, txid: item.txid,
  ...(kind === 'utxo' ? { vout: item.vout } : {}), ...(action === 'upsert' ? { item } : {}), ...extra });
const check = () => {};
async function fixture() {
  const state = await beginAddressSync({ rpc: { request: async () => page([], { next_cursor: 'start', through_sequence: 0 }) }, network: 'testnet4', addresses: [addr], check });
  setAddressBaseline(state, addr, { history: [history(1)], utxos: [utxo(1)] });
  return state;
}

test('watermarks bind canonical address batches before baseline reads', async () => {
  const calls = [], addresses = Array.from({ length: 101 }, (_, i) => `address${String(i).padStart(3, '0')}`).reverse();
  const state = await beginAddressSync({ rpc: { request: async (method, params) => { calls.push({ method, params }); return page([], { next_cursor: `cursor${calls.length}` }); } }, network: 'testnet4', addresses, check });
  assert.deepEqual(calls.map(call => call.params.addresses.length), [100, 1]);
  assert.equal(calls[0].params.addresses[0], 'address000');
  assert.ok(calls.every(call => call.method === 'getaddresschanges' && !('cursor' in call.params)));
  assert.equal(state.addresses.size, 101);
  await assert.rejects(beginAddressSync({ rpc: {}, network: 'testnet4', addresses: [addr, addr], check }), /invalid address synchronization/);
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
  ['wrong network', page([], { tip: { ...tip, chain: 'main' } })],
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
  const state = await beginAddressSync({ rpc: { request: async () => page() }, network: 'testnet4', addresses: [addr, other], check });
  setAddressBaseline(state, addr, { history: [history(1)], utxos: [] });
  setAddressBaseline(state, other, { history: [history(1, { status: 'pending', block_hash: null, block_height: null, confirmations: 0 })], utxos: [] });
  assert.throws(() => addressSyncSnapshot(state, [{ address: addr, change: 0, index: 0 }, { address: other, change: 1, index: 0 }]), { code: -32011 });
});

async function largeFixture() {
  const addresses = Array.from({ length: 101 }, (_, i) => `address${String(i).padStart(3, '0')}`);
  const state = await beginAddressSync({ rpc: { request: async () => page([], { next_cursor: 'start', through_sequence: 0 }) }, network: 'testnet4', addresses, check });
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
