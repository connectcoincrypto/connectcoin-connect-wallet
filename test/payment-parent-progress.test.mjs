import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { WalletService } from '../src/core/wallet-service.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { MAX_PAYMENT_INPUTS, MAX_PAYMENT_PARENT_HEX_BYTES, serializeTransaction, transactionId } from '../src/core/transaction.mjs';

// Public transaction bytes and local promises only. Never sign or broadcast.
const publicKey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const tip = { chain: 'main', genesis_hash: GENESIS.main, height: 100, hash: 'ab'.repeat(32), mediantime: 1800000000 };
function parents(count) {
  return Array.from({ length: count }, (_, index) => {
    const transaction = { version: 2, locktime: index + 1,
      inputs: [{ txid: '99'.repeat(32), vout: 0, scriptSig: '', sequence: 0xffffffff, witness: [] }],
      outputs: Array.from({ length: 4 }, () => ({ type: 1, publicKey, amount: '1000000000' })) };
    return { txid: transactionId(transaction), hex: serializeTransaction(transaction).toString('hex') };
  });
}
function fixture(t, rows) {
  const service = new WalletService({ directory: '/unused-parent-progress-test' });
  service.config = structuredClone(DEFAULT_CONFIG); service.session = { data: {} };
  const calls = [], byId = new Map(rows.map(row => [row.txid, row.hex]));
  service.rpc = { request: async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'gettransactions') return { tip, transactions: params.txids.map(txid => ({ txid, hex: byId.get(txid) })), remaining: [] };
    if (method === 'gettransaction') return { tip, transaction: { hex: byId.get(params.txid) } };
    assert.fail(`Unexpected RPC ${method}`);
  } };
  t.after(() => service.statePublisher.close());
  return { service, calls };
}
function selectedFrom(rows, counts) {
  return Object.freeze(rows.flatMap((row, index) => Array.from({ length: counts[index] }, (_, vout) => Object.freeze({ txid: row.txid, vout }))));
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('payment parent progress counts every selected output once across cached and partial batches', async t => {
  const rows = parents(5), selected = selectedFrom(rows, [3, 1, 4, 2, 1]);
  const { service, calls } = fixture(t, rows), updates = [];
  service.fundingCache.set(rows[0].txid, rows[0].hex); service.fundingCache.set(rows[2].txid, rows[2].hex);
  service.rpc.request = async (method, params) => {
    assert.equal(method, 'gettransactions'); calls.push([...params.txids]);
    const row = rows.find(row => row.txid === params.txids[0]);
    return { tip, transactions: [row], remaining: params.txids.slice(1) };
  };
  const result = await service.paymentParents(selected, new AbortController().signal, count => updates.push(count));
  assert.deepEqual(updates, [7, 8, 10, 11]);
  assert.deepEqual(calls, [[rows[1].txid, rows[3].txid, rows[4].txid], [rows[3].txid, rows[4].txid], [rows[4].txid]]);
  assert.equal(result.size, rows.length);
  for (const row of rows) assert.equal(result.get(row.txid), row.hex);
  calls.length = 0; updates.length = 0;
  await service.paymentParents(selected, new AbortController().signal, count => updates.push(count));
  assert.deepEqual(updates, [selected.length]); assert.deepEqual(calls, []);
});

test('legacy parent responses completing out of order retain input-weighted progress and one lookup per txid', async t => {
  const rows = parents(4), selected = selectedFrom(rows, [2, 4, 1, 3]);
  const { service, calls } = fixture(t, rows), gates = new Map(rows.slice(1).map(row => [row.txid, deferred()])), updates = [];
  service.fundingCache.set(rows[0].txid, rows[0].hex);
  service.rpc.request = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'gettransactions') throw Object.assign(new Error('Unsupported batch'), { code: -32601 });
    assert.equal(method, 'gettransaction');
    return gates.get(params.txid).promise;
  };
  const work = service.paymentParents(selected, new AbortController().signal, count => updates.push(count));
  await tick(); assert.equal(calls.length, 4); assert.deepEqual(updates, [2]);
  for (const index of [3, 1, 2]) {
    gates.get(rows[index].txid).resolve({ tip, transaction: { hex: rows[index].hex } }); await tick();
  }
  const result = await work;
  assert.deepEqual(updates, [2, 5, 9, 10]); assert.equal(result.size, 4);
  assert.deepEqual(calls.filter(call => call.method === 'gettransaction').map(call => call.params.txid), rows.slice(1).map(row => row.txid));
  assert.equal(service.batchFundingSupported, false);
});

test('maximum-size legacy parent progress reads selected identities once rather than once per completion', async t => {
  const rows = parents(MAX_PAYMENT_INPUTS), { service, calls } = fixture(t, rows);
  service.batchFundingSupported = false;
  let identityReads = 0;
  const selected = Object.freeze(rows.map(row => Object.freeze({ get txid() { identityReads++; return row.txid; }, vout: 0 })));
  const updates = [];
  const result = await service.paymentParents(selected, new AbortController().signal, count => updates.push(count));
  assert.equal(identityReads, selected.length);
  assert.deepEqual(updates, Array.from({ length: selected.length + 1 }, (_, index) => index));
  assert.equal(result.size, selected.length);
  assert.equal(calls.length, selected.length);
  assert.ok(calls.every(call => call.method === 'gettransaction' && call.params.raw_only === true));
});

test('oversized batch-parent fallback advances weighted progress only after validated individual bytes', async t => {
  const rows = parents(2), selected = selectedFrom(rows, [3, 2]), { service } = fixture(t, rows);
  const request = service.rpc.request, updates = []; let batches = 0;
  service.rpc.request = async (method, params) => {
    if (method === 'gettransactions' && batches++ === 0) {
      throw Object.assign(new Error('Parent too large for batch'), { code: -32021, data: { txid: params.txids[0] } });
    }
    return request(method, params);
  };
  const result = await service.paymentParents(selected, new AbortController().signal, count => updates.push(count));
  assert.deepEqual(updates, [0, 3, 5]); assert.equal(result.size, 2);
});

test('invalid parent bytes and cancelled replies never advance progress for their selected outputs', async t => {
  for (const mode of ['bytes', 'cancel', 'epoch', 'cache-generation']) {
    const rows = parents(2), selected = selectedFrom(rows, [2, 3]), { service } = fixture(t, rows), updates = [];
    const controller = new AbortController();
    service.fundingCache.set(rows[0].txid, rows[0].hex);
    service.rpc.request = async () => {
      if (mode === 'cancel') controller.abort();
      if (mode === 'epoch') service.epoch++;
      if (mode === 'cache-generation') service.clearFundingCache();
      return { tip, transactions: [{ txid: rows[1].txid, hex: mode === 'bytes' ? rows[0].hex : rows[1].hex }], remaining: [] };
    };
    await assert.rejects(service.paymentParents(selected, controller.signal, count => updates.push(count)),
      /do not match|cancelled|locked or changed/);
    assert.deepEqual(updates, [2], mode);
  }
});

test('the existing parent memory limit rejects retention before reporting cached progress', async t => {
  const rows = parents(2), { service } = fixture(t, rows), updates = [];
  // A synthetic cache models an oversized immutable hex entry without allocating
  // 64 MiB solely to exercise the existing length guard.
  service.fundingCache = new Map([[rows[0].txid, rows[0].hex], [rows[1].txid, { length: MAX_PAYMENT_PARENT_HEX_BYTES }]]);
  await assert.rejects(service.paymentParents(selectedFrom(rows, [2, 3]), new AbortController().signal, count => updates.push(count)), /memory safety limit/);
  assert.deepEqual(updates, []);
});
