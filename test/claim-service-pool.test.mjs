import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WalletService } from '../src/core/wallet-service.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { bountyKey } from '../src/core/bounty-discovery.mjs';
import { serializeTransaction, transactionId } from '../src/core/transaction.mjs';

const hash = n => n.toString(16).padStart(64, '0');
const tip = height => ({ chain: 'testnet4', genesis_hash: GENESIS.testnet4, height, hash: hash(height + 1), mediantime: 1800000000 });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const service = new WalletService({ directory: '/unused-service-pool-unit-test' });
  service.config = { ...structuredClone(DEFAULT_CONFIG), network: 'testnet4' };
  service.session = { data: {} }; service.epoch = 5; service.tip = tip(600);
  service.emitState = () => {};
  const rpc = new EventEmitter(); rpc.close = () => {};
  service.rpc = rpc;
  const tx = { version: 2, locktime: 0,
    inputs: [{ txid: hash(101), vout: 0, scriptSig: '', sequence: 0xffffffff, witness: [] }],
    outputs: [{ type: 2, amount: '1000000000', domain: 'example.com', target: 'f'.repeat(64), rootVersion: 1, mask: 7 }],
  };
  const raw = serializeTransaction(tx).toString('hex'), txid = transactionId(tx);
  return { service, rpc, raw, txid };
}

test('simultaneous claim preparations share one authenticated funding RPC request', async () => {
  const { service, rpc, raw, txid } = fixture(), gate = deferred();
  let calls = 0;
  rpc.request = async (method, params) => { assert.equal(method, 'gettransaction'); assert.equal(params.txid, txid); calls++; return gate.promise; };
  const results = Array.from({ length: 20 }, () => service.funding(txid));
  await tick(); assert.equal(calls, 1); assert.equal(service.fundingPending.size, 1);
  gate.resolve({ tip: tip(600), transaction: { hex: raw } });
  assert.deepEqual(await Promise.all(results), Array(20).fill(raw));
  assert.equal(service.fundingPending.size, 0);
  assert.equal(await service.funding(txid), raw); assert.equal(calls, 1);
});

test('failed shared funding fetch is released and a later preparation can retry', async () => {
  const { service, rpc, raw, txid } = fixture(); let calls = 0;
  rpc.request = async () => { if (++calls === 1) throw new Error('isolated mock RPC failure'); return { tip: tip(600), transaction: { hex: raw } }; };
  const results = await Promise.allSettled([service.funding(txid), service.funding(txid)]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(calls, 1); assert.equal(service.fundingPending.size, 0); assert.equal(service.fundingCache.size, 0);
  assert.equal(await service.funding(txid), raw); assert.equal(calls, 2);
});

for (const transition of ['lock', 'epoch', 'rpc']) test(`an in-flight funding reply cannot repopulate cache after ${transition}`, async () => {
  const { service, rpc, raw, txid } = fixture(), gate = deferred();
  rpc.request = async () => gate.promise;
  const result = service.funding(txid); await tick();
  if (transition === 'lock') service.session = null;
  if (transition === 'epoch') service.epoch++;
  if (transition === 'rpc') service.rpc = new EventEmitter();
  gate.resolve({ tip: tip(600), transaction: { hex: raw } });
  await assert.rejects(result, /locked|changed/i);
  assert.equal(service.fundingCache.size, 0); assert.equal(service.fundingPending.size, 0);
});

function row(index, height = 1) {
  return { txid: hash(1000 + index), vout: 0, amount: '1000000000', domain: 'example.com',
    connection_work_target: 'f'.repeat(64), root_certificates_version: 1, signature_algorithms_mask: 7,
    block_height: height, block_hash: hash(height + 1), status: 'available' };
}

function discoveryFixture(rows) {
  const { service, rpc } = fixture();
  service.claimBlocks = new Map([[rows[0].block_hash, rows]]);
  service.claimOutpoints = new Map(rows.map(value => [bountyKey(value), value]));
  service.claimCursor = 'c0';
  service.createEngine();
  const stateCallback = service.engine.onState;
  const live = new Set(rows.slice(0, 2).map(bountyKey));
  const removals = [];
  const engine = {
    enabled: true, queue: new Map(rows.map(value => [bountyKey(value), { bounty: value }])),
    activeKeys: () => new Set(live), hasActive: key => live.has(key),
    retire(txid, vout) { const key = `${txid}:${vout}`; if (live.has(key)) this.queue.get(key).retired = true; else this.queue.delete(key); },
    remove(txid, vout) { const key = `${txid}:${vout}`; removals.push(key); this.queue.delete(key); live.delete(key); },
    retainCatalog() {}, enqueue() {}, resume() {},
  };
  service.engine = engine;
  let snapshot = { window: 600, tip: tip(601), blocks: Array.from({ length: 600 }, (_, i) => ({ height: 601 - i, hash: hash(602 - i) })) };
  rpc.request = async method => {
    if (method === 'getrecentblockhashes') return structuredClone(snapshot);
    if (method === 'getbountychanges') return { tip: snapshot.tip, next_cursor: 'c1', has_more: false, changes: [] };
    throw new Error('Unexpected mock discovery request');
  };
  service.blockBounties = async () => [];
  return { service, engine, live, removals, notify: () => stateCallback({}), setSnapshot: value => { snapshot = value; } };
}

test('multiple aged-out active outpoints retain only their own metadata until each drains', async () => {
  const rows = [row(0), row(1), row(2)];
  const { service, live, notify } = discoveryFixture(rows);
  await service.syncBountiesInternal(service.epoch);
  assert.equal(service.claimBlocks.size, 600);
  assert.deepEqual([...service.claimOutpoints.keys()], rows.slice(0, 2).map(bountyKey));
  assert.equal(service.retiredClaims.size, 2);
  live.delete(bountyKey(rows[0])); notify();
  assert.deepEqual([...service.claimOutpoints.keys()], [bountyKey(rows[1])]);
  assert.equal(service.retiredClaims.size, 1);
  live.delete(bountyKey(rows[1])); notify();
  assert.equal(service.claimOutpoints.size, 0); assert.equal(service.retiredClaims.size, 0);
});

test('reorg detection checks every retained active outpoint, not only one active claim', async () => {
  const rows = [row(0, 599), row(1, 599)];
  const { service, removals, setSnapshot } = discoveryFixture(rows);
  service.config.claims.lookbackBlocks = 1;
  await service.syncBountiesInternal(service.epoch);
  assert.equal(service.retiredClaims.size, 2);
  const snapshot = { window: 600, tip: tip(602), blocks: Array.from({ length: 600 }, (_, i) => ({ height: 602 - i, hash: hash(603 - i) })) };
  snapshot.blocks.find(block => block.height === 599).hash = hash(99000);
  setSnapshot(snapshot);
  await service.syncBountiesInternal(service.epoch);
  for (const value of rows) assert.ok(removals.includes(bountyKey(value)));
  assert.equal(service.claimOutpoints.size, 0);
});
