import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { FundingBytesCache } from '../src/core/funding-cache.mjs';
import { FundingTransactionCache, parseTransaction, serializeTransaction, transactionId } from '../src/core/transaction.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';
import { encodeAddress } from '../src/core/crypto.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const publicKey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
function fixture(t) {
  const service = new WalletService({ directory: '/unused-funding-cache-test' });
  service.config = { ...structuredClone(DEFAULT_CONFIG), network: 'testnet4' };
  service.session = { data: {} }; service.epoch = 7; service.engine = { enabled: true };
  const rpc = new EventEmitter(); rpc.close = () => {}; service.rpc = rpc;
  service.tip = { height: 600, hash: 'ab'.repeat(32), chain: 'testnet4', genesis_hash: GENESIS.testnet4, mediantime: 1800000000 };
  const tx = { version: 2, locktime: 0,
    inputs: [{ txid: '99'.repeat(32), vout: 0, scriptSig: '', sequence: 0xffffffff, witness: [] }],
    outputs: [0, 1].map(() => ({ type: 2, amount: '1000000000', domain: 'example.com', target: 'f'.repeat(64), rootVersion: 1, mask: 7 })) };
  const raw = serializeTransaction(tx).toString('hex'), txid = transactionId(tx);
  const bounties = [0, 1].map(vout => ({ txid, vout, amount: '1000000000', status: 'available', domain: 'example.com',
    block_height: 1, block_hash: 'ac'.repeat(32),
    connection_work_target: 'f'.repeat(64), root_certificates_version: 1, signature_algorithms_mask: 7 }));
  service.claimOutpoints = new Map(bounties.map(row => [`${row.txid}:${row.vout}`, row]));
  service.getState = () => ({ wallet: { address: encodeAddress(publicKey, 'testnet4') } });
  const response = { tip: service.tip, transaction: { hex: raw } };
  rpc.request = async () => response;
  t.after(() => service.statePublisher.close());
  return { service, rpc, raw, txid, bounties, response };
}

test('raw funding LRU accounts replacements, byte/entry bounds, oversize and clear', () => {
  const cache = new FundingBytesCache({ maxEntries: 2, maxBytes: 1024 });
  cache.set('a', 'aa').set('b', 'bb'); const retained = cache.retainedBytes;
  assert.equal(cache.get('a'), 'aa'); cache.set('c', 'cc');
  assert.equal(cache.has('b'), false); assert.equal(cache.size, 2); assert.equal(cache.retainedBytes, retained);
  cache.set('a', 'abcd'); assert.equal(cache.retainedBytes, retained + 4);
  cache.set('a', 'x'.repeat(1024)); assert.equal(cache.has('a'), false); assert.equal(cache.size, 1);
  const limited = new FundingBytesCache({ maxBytes: 300 }); limited.set('a', 'a').set('b', 'b');
  assert.equal(limited.size, 1); assert.ok(limited.retainedBytes <= 300);
  cache.clear(); assert.equal(cache.size, 0); assert.equal(cache.retainedBytes, 0);
  assert.throws(() => cache.set('a', {}));
  for (const options of [{ maxEntries: 0 }, { maxEntries: 257 }, { maxBytes: Infinity }, { maxBytes: 0 }]) assert.throws(() => new FundingBytesCache(options));
});

for (const transition of ['epoch', 'rpc', 'wallet-generation', 'clear']) test(`claim parents are parsed once across outputs but validated anew after ${transition}`, async t => {
  const { service, raw, bounties, response } = fixture(t);
  let parses = 0; const from = Buffer.from;
  t.mock.method(Buffer, 'from', function(value, ...args) {
    if (value === raw && args[0] === 'hex') parses++;
    return from(value, ...args);
  });
  service.fundingCache.set(bounties[0].txid, raw);
  const first = await service.prepareAutomaticClaim(bounties[0]);
  const second = await service.prepareAutomaticClaim(bounties[1]);
  assert.notEqual(first.challenge, second.challenge); assert.equal(parses, 1);
  first.bounty.domain = 'tampered.example';
  assert.equal((await service.prepareAutomaticClaim(bounties[0])).bounty.domain, 'example.com');
  if (transition === 'epoch') service.epoch++;
  else if (transition === 'rpc') service.rpc = { request: async () => response };
  else if (transition === 'wallet-generation') service.walletGeneration++;
  else service.clearFundingCache();
  service.fundingCache.set(bounties[0].txid, raw);
  await service.prepareAutomaticClaim(bounties[0]); assert.equal(parses, 2);
});

test('cache invalidation on the same RPC fences old reads without deleting their replacement', async t => {
  const { service, rpc, txid, response } = fixture(t), old = deferred(), fresh = deferred();
  let requests = 0; rpc.request = () => (++requests === 1 ? old.promise : fresh.promise);
  const first = service.funding(txid); const rejected = assert.rejects(first, /context changed/); await tick();
  service.clearFundingCache(); const next = service.funding(txid); await tick();
  old.resolve(response); await rejected;
  assert.equal(service.fundingCache.size, 0); assert.equal(service.fundingPending.size, 1);
  fresh.resolve(response); assert.equal(await next, response.transaction.hex); assert.equal(service.fundingPending.size, 0);
});

test('aborted claim preparation does not enter the validated cache or discard shared raw funding', async t => {
  const { service, rpc, txid, bounties, response } = fixture(t), gate = deferred(), controller = new AbortController();
  rpc.request = () => gate.promise;
  const cacheCalls = t.mock.method(FundingTransactionCache.prototype, 'prepareClaim');
  const rejected = assert.rejects(service.prepareAutomaticClaim(bounties[0], { signal: controller.signal }), { name: 'AbortError' });
  const other = service.funding(txid); await tick(); controller.abort(); await rejected;
  gate.resolve(response); await other;
  assert.equal(cacheCalls.mock.callCount(), 0); assert.equal(service.fundingCache.get(txid), response.transaction.hex);
  await service.prepareAutomaticClaim(bounties[0]); assert.equal(cacheCalls.mock.callCount(), 1);
});

test('real disconnected event invalidates outstanding funding on the same client', async t => {
  const { service, rpc, txid, response } = fixture(t), gate = deferred();
  service.engine.stop = async () => {}; service.clientFactory = () => rpc;
  service.connectClient(); t.after(() => service.stopLiveUpdates());
  rpc.request = () => gate.promise;
  const result = service.funding(txid), rejected = assert.rejects(result, /context changed/);
  await tick(); rpc.emit('disconnected'); gate.resolve(response); await rejected;
  assert.equal(service.rpc, rpc); assert.equal(service.fundingCache.size, 0); assert.equal(service.fundingPending.size, 0);
});

for (const stage of ['response', 'yield']) test(`payment batch invalidation during ${stage} cannot repopulate the raw cache`, async t => {
  const { service, rpc, raw, response } = fixture(t), gate = deferred(), controller = new AbortController();
  const parent = parseTransaction(raw), rows = Array.from({ length: 8 }, (_, locktime) => {
    const tx = { ...parent, locktime }; return { txid: transactionId(tx), hex: serializeTransaction(tx).toString('hex') };
  });
  const batch = { tip: response.tip, transactions: rows, remaining: [] };
  rpc.request = async () => {
    if (stage === 'response') return gate.promise;
    setImmediate(() => service.clearFundingCache());
    return batch;
  };
  const pending = service.paymentParents(rows.map(row => ({ txid: row.txid })), controller.signal, () => {});
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  if (stage === 'response') { await tick(); service.clearFundingCache(); gate.resolve(batch); }
  await rejected;
  assert.equal(service.fundingCache.size, 0); assert.equal(service.fundingCache.retainedBytes, 0);
});
