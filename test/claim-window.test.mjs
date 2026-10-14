import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ClaimsEngine } from '../src/core/claims.mjs';
import { discoverBounties, bountyKey, BountyDiscoveryBusy } from '../src/core/bounty-discovery.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';
import { parseTransaction, serializeTransaction, transactionId, attachClaimProof } from '../src/core/transaction.mjs';

const hash = value => value.toString(16).padStart(64, '0');
const tip = height => ({ chain: 'testnet4', genesis_hash: GENESIS.testnet4, height, hash: hash(height + 1), mediantime: 1800000000 + height });
const window = height => ({ window: 600, tip: tip(height), blocks: Array.from({ length: Math.min(600, height + 1) }, (_, index) => ({ height: height - index, hash: hash(height - index + 1) })) });
const context = () => ({ domain: 'example.com', txid: hash(801), input_index: 0, connection_work_target: 'f'.repeat(64), root_certificates_version: 1, signature_algorithms_mask: 7, validation_time: 1800000000 });
const row = (height = 1, extra = {}) => ({ txid: hash(900), vout: 0, amount: '1000000000', domain: 'example.com', connection_work_target: 'f'.repeat(64), root_certificates_version: 1, signature_algorithms_mask: 7, block_height: height, block_hash: hash(height + 1), coinbase: false, confirmations: 1, status: 'available', spending_txid: null, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(predicate) {
  for (let attempt = 0; attempt < 500; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  throw new Error('Timed out waiting for the mocked claim worker');
}

function serviceFixture({ height = 600, bountyHeight = 1 } = {}) {
  // Public BIP39 test vector only. No real wallet directory is read or written.
  const account = deriveAccount('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  account.privateKey.fill(0);
  const funding = { version: 2, locktime: 0, inputs: [{ txid: hash(999), vout: 0, sequence: 0xffffffff, scriptSig: '', witness: [] }], outputs: [{ type: 2, amount: '1000000000', domain: 'example.com', target: 'f'.repeat(64), rootVersion: 1, mask: 7 }] };
  const raw = serializeTransaction(funding).toString('hex');
  const bounty = row(bountyHeight, { txid: transactionId(funding) });
  const calls = [];
  const rpc = new EventEmitter();
  rpc.close = () => {};
  rpc.request = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'sendrawtransaction') return { txid: transactionId(parseTransaction(params.transaction_hex)) };
    throw new Error(`Unexpected RPC request: ${method}`);
  };
  const service = new WalletService({ directory: '/unused-claim-window-unit-test', clientFactory: () => new EventEmitter() });
  service.config = { ...structuredClone(DEFAULT_CONFIG), network: 'testnet4' };
  service.config.claims.maxConcurrent = 1;
  // Never start the installed network helper from unit tests. The callback is
  // injected before createEngine; individual scenarios supply an offline result.
  service.proofRunner = (...args) => {
    if (!service.testProofRunner) throw new Error('Missing isolated proof fixture');
    return service.testProofRunner(...args);
  };
  service.session = { data: {} }; service.epoch = 7;
  service.tip = tip(height); service.rpc = rpc;
  service.engine = { enabled: true, async stop() { this.enabled = false; }, clear() {} };
  service.claimBlocks.set(bounty.block_hash, [bounty]);
  service.claimOutpoints = new Map([[bountyKey(bounty), bounty]]);
  service.claimCursor = 'c0';
  service.getState = () => ({ wallet: { address: account.address } });
  service.emitState = () => {};
  service.funding = async () => raw;
  return { service, bounty, calls, rpc, raw };
}

function structuralProof(prepared) {
  // TLS authentication belongs to the helper suite; these tests only exercise
  // claim scheduling and submission using a structurally valid witness.
  const hello = Buffer.concat([Buffer.from('010000220303', 'hex'), Buffer.from(prepared.challenge, 'hex')]);
  return Buffer.concat([Buffer.from([2]), hello, ...[2, 8, 11, 15].map(type => Buffer.from([type, 0, 0, 0]))]).toString('hex');
}

test('an old catalog row does not admit new captures outside 600 blocks', async () => {
  const { service, bounty, calls } = serviceFixture({ height: 800 });
  service.claimBlocks.clear();
  await assert.rejects(service.prepareAutomaticClaim(bounty), /outside the discovery window/);
  assert.equal(calls.length, 0);
});

test('retries reuse the fixed claim fee, payout and receiving address while refreshing certificate time', async () => {
  const { service, bounty, raw, calls } = serviceFixture({ bountyHeight: 2 });
  let fundingReads = 0;
  service.funding = async () => { fundingReads++; return raw; };
  const prepared = await service.prepareAutomaticClaim(bounty);
  const other = deriveAccount('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', { index: 1 });
  other.privateKey.fill(0);
  service.getState = () => ({ wallet: { address: other.address } });
  service.config.feeRate *= 2;
  service.tip = tip(601);
  const resumed = await service.prepareAutomaticClaim(bounty, { previous: prepared });
  assert.notEqual(other.address, prepared.rewardAddress);
  assert.equal(resumed.rewardAddress, prepared.rewardAddress);
  assert.equal(resumed.fee, prepared.fee); assert.equal(resumed.payout, prepared.payout);
  assert.equal(resumed.hex, prepared.hex); assert.equal(resumed.txid, prepared.txid);
  assert.equal(resumed.challenge, prepared.challenge);
  assert.equal(resumed.context.validation_time, tip(601).mediantime);
  assert.equal(fundingReads, 2, 'retained challenge still reauthenticates funding');
  assert.equal(calls.length, 0, 'unit preparation makes no RPC network request');
});

test('a proven-unsent claim failure releases its reservation without disabling claims', async () => {
  const { service, bounty, rpc } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  const failure = Object.assign(new Error('Connection failed before writing'), { notSent: true });
  rpc.request = async () => { throw failure; };
  await assert.rejects(service.submitAutomaticClaim(prepared, structuralProof(prepared)), error => error === failure);
  assert.equal(service.reserved.has(bountyKey(bounty)), false);
  assert.equal(service.engine.enabled, true);
});

test('a claim queued behind RPC capacity rechecks availability at the actual write fence', async () => {
  const { service, bounty, rpc } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  let writes = 0, fence;
  rpc.request = async (_method, _params, options) => {
    fence = options.beforeSend;
    service.claimOutpoints.delete(bountyKey(bounty));
    try { fence(); } catch (error) { throw Object.assign(error, { notSent: true }); }
    writes++; return { txid: prepared.txid };
  };
  await assert.rejects(service.submitAutomaticClaim(prepared, structuralProof(prepared)), /availability changed/);
  assert.equal(typeof fence, 'function'); assert.equal(writes, 0);
  assert.equal(service.reserved.has(bountyKey(bounty)), false);
  assert.equal(service.engine.enabled, true);
});

for (const boundary of ['epoch', 'RPC']) test(`a retained claim cannot reuse its proposal across a changed ${boundary}`, async () => {
  const { service, bounty } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  const other = deriveAccount('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', { index: 1 });
  other.privateKey.fill(0);
  service.getState = () => ({ wallet: { address: other.address } });
  service.config.feeRate *= 2;
  if (boundary === 'epoch') service.epoch++;
  else service.rpc = new EventEmitter();
  const renewed = await service.prepareAutomaticClaim(bounty, { previous: prepared });
  assert.equal(renewed.rewardAddress, other.address);
  assert.notEqual(renewed.fee, prepared.fee); assert.notEqual(renewed.txid, prepared.txid);
});

test('a cached fixed proposal never bypasses funding authentication on retry', async () => {
  const { service, bounty, raw } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  const tampered = parseTransaction(raw);
  tampered.outputs[0].amount = '2000000000';
  service.funding = async () => serializeTransaction(tampered).toString('hex');
  await assert.rejects(service.prepareAutomaticClaim(bounty, { previous: prepared }), /transaction|funding|match/i);
});

test('preparation crossing the RPC discovery boundary cannot start a new capture', async () => {
  const { service, bounty, calls, raw } = serviceFixture();
  const funding = deferred();
  service.funding = () => funding.promise;
  const preparation = service.prepareAutomaticClaim(bounty);
  service.tip = tip(601); service.claimBlocks.clear();
  funding.resolve(raw);
  await assert.rejects(preparation, /outside the discovery window/);
  assert.equal(calls.length, 0);
});

for (const cachedTip of [undefined, null, { ...tip(600), chain: 'main' }, { ...tip(600), genesis_hash: hash(404) }, { ...tip(600), mediantime: NaN }]) {
  test(`claim preparation refuses an absent or invalid cached network tip: ${String(cachedTip?.chain ?? cachedTip)} / ${String(cachedTip?.mediantime)}`, async () => {
    const { service, bounty, calls } = serviceFixture();
    service.tip = cachedTip;
    service.funding = async () => { throw new Error('Must validate the cached tip before fetching funding'); };
    await assert.rejects(service.prepareAutomaticClaim(bounty), /network|tip/i);
    assert.equal(calls.length, 0);
  });
}

test('availability gating retains reservation, cancellation and funding authentication safeguards', async () => {
  for (const state of ['missing', 'spent', 'pending_spend', 'reserved', 'cancelled', 'wrong-domain']) {
    const { service, bounty, calls } = serviceFixture();
    const signal = new AbortController();
    if (state === 'missing') service.claimOutpoints.clear();
    if (['spent', 'pending_spend'].includes(state)) bounty.status = state;
    if (state === 'reserved') service.reserved.add(bountyKey(bounty));
    if (state === 'cancelled') signal.abort();
    if (state === 'wrong-domain') bounty.domain = 'attacker.example';
    await assert.rejects(service.prepareAutomaticClaim(bounty, { signal: signal.signal }), /eligible|stopped|domain differs/i, state);
    assert.equal(calls.length, 0);
  }
  const { service, bounty, calls } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  service.claimOutpoints.clear();
  await assert.rejects(service.submitAutomaticClaim(prepared, structuralProof(prepared)), /eligible/i);
  assert.equal(calls.length, 0);
});

for (const transition of ['lock', 'new epoch', 'new RPC', 'aborted signal']) test(`claim preparation cannot cross ${transition} while funding is pending`, async () => {
  const { service, bounty, calls, raw } = serviceFixture();
  const funding = deferred(), controller = new AbortController();
  service.funding = () => funding.promise;
  const prepared = service.prepareAutomaticClaim(bounty, { signal: controller.signal });
  if (transition === 'lock') service.session = null;
  if (transition === 'new epoch') service.epoch++;
  if (transition === 'new RPC') service.rpc = {};
  if (transition === 'aborted signal') controller.abort();
  funding.resolve(raw);
  await assert.rejects(prepared, /locked|changed|stopped/i);
  assert.equal(calls.length, 0);
});

test('the shared validated tip and hash window are cleared on reconnect, current RPC disconnection and locking', async () => {
  const { service } = serviceFixture();
  const clients = [];
  service.clientFactory = () => {
    const client = new EventEmitter(); client.close = () => {};
    clients.push(client); return client;
  };
  service.claimWindow = window(600);
  service.connectClient(); assert.equal(service.tip, null); assert.equal(service.claimWindow, null);
  service.tip = tip(600); service.claimWindow = window(600);
  clients[0].emit('disconnected'); assert.equal(service.tip, null); assert.equal(service.claimWindow, null);
  service.connectClient(); service.tip = tip(601); service.claimWindow = window(601);
  clients[0].emit('disconnected');
  assert.equal(service.tip.height, 601, 'an obsolete connection must not clear a newer connection state');
  assert.equal(service.claimWindow.tip.height, 601);
  await service.lock();
  assert.equal(service.tip, null);
  assert.equal(service.claimWindow, null);
});

for (const stage of ['prepare', 'proof', 'submit']) test(`retirement during ${stage} preserves only work whose TCP attempt already started`, async t => {
  const gate = deferred(); let entered = false, submitted = 0;
  const engine = new ClaimsEngine({ isUnlocked: () => true, randomIndex: () => 0, options: { connectionsPerSecond: 256, concurrency: 1 },
    prepare: async () => { if (stage === 'prepare') { entered = true; await gate.promise; } return { context: context() }; },
    generateProof: async () => { if (stage === 'proof') { entered = true; await gate.promise; } return '020100'; },
    submit: async () => { if (stage === 'submit') { entered = true; await gate.promise; } submitted++; return context().txid; },
  });
  t.after(async () => { gate.resolve(); await engine.stop(); });
  const active = row(), queued = row(1, { vout: 1 });
  engine.enqueue([active]); engine.start();
  await until(() => entered);
  engine.enqueue([queued]);
  engine.retire(active.txid, active.vout); engine.retire(queued.txid, queued.vout);
  assert.equal(engine.controller.signal.aborted, false);
  assert.equal(engine.queue.size, 1);
  assert.equal(engine.queue.get(bountyKey(active)).retired, true);
  assert.equal(engine.enqueue([active]), 0, 'an in-flight retired job cannot be duplicated');
  gate.resolve();
  await until(() => !engine.running);
  assert.equal(submitted, stage === 'prepare' ? 0 : 1);
  assert.equal(engine.snapshot().completed, stage === 'prepare' ? 0 : 1);
  assert.equal(engine.queue.size, 0);
});

test('a retired failed attempt is discarded instead of retrying outside discovery', async t => {
  const gate = deferred(); let entered = false, attempts = 0;
  const engine = new ClaimsEngine({ isUnlocked: () => true, retryDelayMs: 1, options: { connectionsPerSecond: 256, concurrency: 1 },
    prepare: async () => { attempts++; return { context: context() }; },
    generateProof: async () => { entered = true; await gate.promise; throw new Error('Mocked TLS failure'); },
    submit: async () => { throw new Error('A failed proof must never be submitted'); },
  });
  t.after(async () => { gate.resolve(); await engine.stop(); });
  const bounty = row(); engine.enqueue([bounty]); engine.start(); await until(() => entered);
  engine.retire(bounty.txid, bounty.vout); gate.resolve();
  await until(() => !engine.running);
  engine.kick(); await tick();
  assert.equal(attempts, 1); assert.equal(engine.queue.size, 0); assert.equal(engine.timer, null);
});

for (const action of ['remove', 'clear', 'stop', 'suspend', 'lock']) test(`retirement does not override ${action} cancellation`, async t => {
  const gate = deferred(); let entered = false, submitted = false, unlocked = true;
  const engine = new ClaimsEngine({ isUnlocked: () => unlocked, options: { connectionsPerSecond: 256, concurrency: 1 },
    prepare: async () => ({ context: context() }),
    generateProof: async () => { entered = true; await gate.promise; return '020100'; },
    submit: async () => { submitted = true; },
  });
  t.after(async () => { gate.resolve(); await engine.stop(); });
  const bounty = row(); engine.enqueue([bounty]); engine.start(); await until(() => entered);
  engine.retire(bounty.txid, bounty.vout);
  let stopped;
  if (action === 'remove') engine.remove(bounty.txid, bounty.vout);
  else if (action === 'lock') unlocked = false;
  else stopped = engine[action]();
  gate.resolve(); await stopped; await until(() => !engine.running);
  assert.equal(submitted, false); assert.equal(engine.queue.size, 0);
});

function mockDiscovery(service, { height, reorg = false, event = null, rows = [], cursor = 'c1' }) {
  const previousRequest = service.rpc.request;
  let journalCalls = 0;
  const snapshot = window(height);
  if (reorg) {
    snapshot.blocks = snapshot.blocks.map(block => ({ ...block, hash: hash(block.height + 10001) }));
    snapshot.tip.hash = snapshot.blocks[0].hash;
  }
  service.rpc.request = async (method, params, options) => {
    if (method === 'getrecentblockhashes') return structuredClone(snapshot);
    if (method === 'getchaintip') return structuredClone(snapshot.tip);
    if (method === 'getbountychanges') return { tip: snapshot.tip, next_cursor: cursor, has_more: false, changes: ++journalCalls === 1 && event ? [event] : [] };
    return previousRequest(method, params, options);
  };
  service.blockBounties = async blockHash => rows.filter(value => value.block_hash === blockHash);
  return snapshot;
}

test('catalog reset preserves an active capture, native pool and winner while gating preparation and transmission', async t => {
  const { service, bounty, calls } = serviceFixture();
  const captureGate = deferred(), hashGate = deferred(); let prepared, entered = false, hashing = false;
  service.createEngine();
  const prepare = service.engine.prepare;
  service.engine.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  service.testProofRunner = async () => { entered = true; await captureGate.promise; return structuralProof(prepared); };
  t.after(async () => { captureGate.resolve(); hashGate.resolve(); await service.engine.stop(); service.releaseClaimCatalog(); });
  service.engine.enqueue([bounty]); service.engine.start(); await until(() => entered);
  const pool = service.engine.pool, generation = service.engine.generation;
  mockDiscovery(service, { height: 600, rows: [bounty], event: { type: 'resync_required' } });
  const request = service.rpc.request;
  service.rpc.request = async (method, ...rest) => {
    if (method === 'getrecentblockhashes') { hashing = true; await hashGate.promise; }
    return request(method, ...rest);
  };
  const sync = service.syncBounties(); await until(() => hashing);
  assert.ok(service.claimCatalogGate); assert.equal(service.engine.catalogBlocked, true);
  assert.strictEqual(service.engine.pool, pool); assert.equal(service.engine.generation, generation);
  let extraPrepared = false;
  const abort = new AbortController();
  const extra = service.prepareAutomaticClaim(bounty, { signal: abort.signal }).then(() => { extraPrepared = true; });
  const cancelled = assert.rejects(extra, error => error.name === 'AbortError');
  await tick(); assert.equal(extraPrepared, false); abort.abort(); await cancelled;
  captureGate.resolve(); await until(() => service.engine.pendingProofs.size === 1);
  assert.equal(service.engine.state.attempts, 1); assert.equal(service.engine.successCounts.get(bountyKey(bounty)), 1n);
  assert.equal(calls.filter(call => call.method === 'sendrawtransaction').length, 0);
  assert.strictEqual(service.engine.pool, pool);
  hashGate.resolve(); await sync; await until(() => service.engine.state.completed === 1);
  assert.equal(service.claimCatalogGate, null); assert.equal(service.engine.catalogBlocked, false);
  assert.strictEqual(service.engine.pool, pool); assert.equal(service.engine.generation, generation);
  assert.equal(service.engine.state.attempts, 1); assert.equal(calls.filter(call => call.method === 'sendrawtransaction').length, 1);
});

test('a resync beginning during RPC quota wait rejects the pre-write fence without losing the proof', async t => {
  const { service, bounty, rpc } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty); let writes = 0;
  rpc.request = async (_method, _params, { beforeSend }) => {
    service.blockClaimCatalog(); beforeSend(); writes++; return { txid: prepared.txid };
  };
  t.after(() => service.releaseClaimCatalog());
  await assert.rejects(service.submitAutomaticClaim(prepared, structuralProof(prepared)), error => error.name === 'AbortError' && error.notSent === true);
  assert.equal(writes, 0); assert.equal(service.reserved.has(bountyKey(bounty)), false);
  assert.equal(service.engine.enabled, true); assert.equal(service.claimsReviewRequired, false);
});

for (const reset of ['journal', 'push']) for (const phase of ['capture', 'winner']) test(`${reset} reset preserves ${phase} aging out during the replacement snapshot`, async t => {
  const { service, bounty, calls } = serviceFixture();
  service.claimWindow = window(600);
  const captureGate = deferred(), hashGate = deferred(); let prepared, entered = false, hashing = false;
  service.createEngine();
  const prepare = service.engine.prepare;
  service.engine.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  service.testProofRunner = async () => { entered = true; await captureGate.promise; return structuralProof(prepared); };
  t.after(async () => { captureGate.resolve(); hashGate.resolve(); await service.engine.stop(); service.releaseClaimCatalog(); });
  service.engine.enqueue([bounty]); service.engine.start(); await until(() => entered);
  const signal = service.engine.controller.signal, generation = service.engine.generation;
  mockDiscovery(service, { height: 601, event: reset === 'journal' ? { type: 'resync_required' } : null });
  const request = service.rpc.request;
  service.rpc.request = async (method, ...args) => {
    if (method === 'getrecentblockhashes') { hashing = true; await hashGate.promise; }
    return request(method, ...args);
  };
  if (reset === 'push') {
    service.claimRevision++; service.claimCursor = null; service.claimBlocks.clear(); service.blockClaimCatalog();
  }
  const sync = service.syncBounties(); await until(() => hashing);
  assert.equal(service.engine.catalogBlocked, true);
  if (phase === 'winner') { captureGate.resolve(); await until(() => service.engine.pendingProofs.size === 1); }
  assert.equal(calls.filter(call => call.method === 'sendrawtransaction').length, 0);
  hashGate.resolve(); await sync;
  assert.equal(signal.aborted, false); assert.equal(service.engine.generation, generation);
  if (phase === 'capture') { assert.equal(service.engine.queue.get(bountyKey(bounty))?.retired, true); captureGate.resolve(); }
  await until(() => service.engine.state.completed === 1);
  assert.equal(service.engine.state.attempts, 1); assert.equal(service.engine.successCounts.get(bountyKey(bounty)), 1n);
  assert.equal(calls.filter(call => call.method === 'sendrawtransaction').length, 1);
  assert.equal(calls.at(-1).params.transaction_hex, attachClaimProof(prepared, structuralProof(prepared)).hex);
});

for (const reset of ['journal', 'push']) test(`${reset} reset still cancels a proof whose funding block was explicitly replaced`, async t => {
  const { service, bounty } = serviceFixture(); service.claimWindow = window(600);
  service.createEngine(); service.engine.enabled = true; service.engine.kick = () => {};
  service.engine.enqueue([bounty]); const key = bountyKey(bounty);
  service.engine.queue.get(key).winner = true;
  service.engine.pendingProofs.set(key, { proof: '020100', due: 0 });
  t.after(async () => { await service.engine.stop(); service.releaseClaimCatalog(); });
  mockDiscovery(service, { height: 600, reorg: true, event: reset === 'journal' ? { type: 'resync_required' } : null });
  if (reset === 'push') { service.claimRevision++; service.claimCursor = null; service.claimBlocks.clear(); service.blockClaimCatalog(); }
  await service.syncBountiesInternal(service.epoch);
  assert.equal(service.engine.pendingProofs.has(key), false);
  assert.equal(service.claimOutpoints.has(key), false); assert.equal(service.retiredClaims.has(key), false);
});

for (const reset of ['journal', 'push']) for (const height of [602, 1202]) test(`${reset} reset preserves an already-retired proof after ${height === 602 ? 'one block' : 'a pause over 600 blocks without a shared anchor'}`, async t => {
  const { service, bounty } = serviceFixture(); service.claimWindow = window(600);
  service.createEngine(); service.engine.enabled = true; service.engine.kick = () => {};
  service.engine.enqueue([bounty]); const key = bountyKey(bounty);
  service.engine.queue.get(key).winner = true;
  const winner = { proof: '020100', due: 0 }; service.engine.pendingProofs.set(key, winner);
  t.after(async () => { await service.engine.stop(); service.releaseClaimCatalog(); });
  mockDiscovery(service, { height: 601 }); await service.syncBountiesInternal(service.epoch);
  assert.equal(service.engine.queue.get(key)?.retired, true); assert.strictEqual(service.engine.pendingProofs.get(key), winner);
  mockDiscovery(service, { height, cursor: 'c2', event: reset === 'journal' ? { type: 'resync_required' } : null });
  if (reset === 'push') { service.claimRevision++; service.claimCursor = null; service.claimBlocks.clear(); service.blockClaimCatalog(); }
  await service.syncBountiesInternal(service.epoch);
  assert.equal(service.engine.pendingProofs.has(key), true);
  assert.equal(service.claimOutpoints.has(key), true); assert.equal(service.retiredClaims.has(key), true);
  assert.strictEqual(service.engine.pendingProofs.get(key), winner, 'No capture or proof replacement is needed');
  assert.equal(service.engine.state.attempts, 0, 'Discovery does not invent a capture or admit new work outside the window');
});

for (const code of [-32001, -32029, -32030]) test(`production discovery wrapper preserves work behind a closed gate after transient resync read ${code}`, async t => {
  const { service, bounty } = serviceFixture();
  service.createEngine(); service.engine.enabled = true; service.engine.kick = () => {};
  service.engine.enqueue([bounty]);
  const job = service.engine.queue.get(bountyKey(bounty));
  service.engine.pendingProofs.set(bountyKey(bounty), { proof: '020100', due: 0 });
  let retries = 0; service.bountyUpdates = { request() { retries++; } };
  mockDiscovery(service, { height: 600, rows: [bounty], event: { type: 'resync_required' } });
  const request = service.rpc.request;
  service.rpc.request = async (method, ...rest) => {
    if (method === 'getrecentblockhashes') throw Object.assign(new Error('Read backend unavailable'), { code });
    return request(method, ...rest);
  };
  t.after(async () => { await service.engine.stop(); service.releaseClaimCatalog(); });
  await assert.rejects(service.syncBounties(), /backend unavailable/);
  assert.equal(service.engine.enabled, true); assert.equal(service.engine.catalogBlocked, true);
  assert.strictEqual(service.engine.queue.get(bountyKey(bounty)), job);
  assert.equal(service.engine.pendingProofs.size, 1); assert.equal(retries, 1);
  service.rpc.request = request; await service.syncBounties();
  assert.equal(service.engine.catalogBlocked, false); assert.equal(service.engine.pendingProofs.size, 1);
});

test('actual journal budget exhaustion preserves a winner and retries from a fresh watermark', async t => {
  const { service, bounty } = serviceFixture();
  service.createEngine(); service.engine.enabled = true; service.engine.kick = () => {};
  service.engine.enqueue([bounty]);
  const key = bountyKey(bounty), job = service.engine.queue.get(key);
  job.winner = true;
  const winner = { proof: '020100', due: 0 }; service.engine.pendingProofs.set(key, winner);
  const generation = service.engine.generation, attempts = service.engine.state.attempts;
  let retries = 0; service.bountyUpdates = { request() { retries++; } };
  service.rpc.socket = { destroyed: false };
  mockDiscovery(service, { height: 600, rows: [bounty] });
  const request = service.rpc.request;
  let sequence = 0;
  service.rpc.request = async (method, params, options) => {
    if (method !== 'getbountychanges') return request(method, params, options);
    if (!params.cursor) return { tip: tip(600), changes: [], next_cursor: String(sequence), has_more: false };
    return { tip: tip(600), next_cursor: String(++sequence), has_more: true,
      changes: [{ sequence, type: 'available_again', txid: hash(8800), vout: 0 }] };
  };
  t.after(async () => { await service.engine.stop(); service.releaseClaimCatalog(); });
  await assert.rejects(service.syncBounties(), BountyDiscoveryBusy);
  assert.equal(service.engine.enabled, true);
  assert.equal(service.engine.catalogBlocked, true);
  assert.equal(service.claimCursor, null, 'No intermediate cursor or the oversized old backlog survives the yield.');
  assert.strictEqual(service.engine.queue.get(key), job);
  assert.strictEqual(service.engine.pendingProofs.get(key), winner);
  assert.equal(service.engine.generation, generation);
  assert.equal(service.engine.state.attempts, attempts);
  assert.equal(retries, 1, 'Retry is queued through EventRefresh rather than spinning in discovery.');
  let watermark = false;
  service.rpc.request = async (method, params, options) => {
    if (method === 'getbountychanges' && !watermark) {
      watermark = true; assert.equal(params.cursor, undefined);
    }
    return request(method, params, options);
  };
  await service.syncBounties();
  assert.equal(watermark, true);
  assert.equal(service.engine.catalogBlocked, false);
  assert.strictEqual(service.engine.pendingProofs.get(key), winner);
  assert.equal(service.engine.generation, generation);
  assert.equal(service.engine.state.attempts, attempts);
});

test('server capacity failure outside resync queues a restart without waiting for another notification', async t => {
  const { service } = serviceFixture();
  service.createEngine(); service.engine.enabled = true; service.engine.kick = () => {};
  service.rpc.socket = { destroyed: false };
  let retries = 0; service.bountyUpdates = { request() { retries++; } };
  service.syncBountiesInternal = async () => { throw Object.assign(new Error('Server busy'), { code: -32030 }); };
  t.after(() => service.engine.stop());
  await assert.rejects(service.syncBounties(), { code: -32030 });
  assert.equal(service.engine.enabled, false);
  assert.equal(service.claimsResumePending, true);
  assert.equal(retries, 1, 'The initial/manual failure must schedule its own recovery');
});

for (const { code, retryAfterMs } of [-32001, -32029, -32030].flatMap(code =>
  [0, 120000, 600000, Number.MAX_SAFE_INTEGER].map(retryAfterMs => ({ code, retryAfterMs })))) {
test(`pre-submission RPC refusal ${code}/${retryAfterMs} preserves the exact winner and full backoff without another capture`, async t => {
  const { service, bounty, rpc } = serviceFixture();
  let prepared, captures = 0, refusedAt = 0; const payloads = [];
  service.createEngine();
  const prepare = service.engine.prepare;
  service.engine.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  service.testProofRunner = async () => { captures++; return structuralProof(prepared); };
  mockDiscovery(service, { height: 600, rows: [bounty] });
  const request = rpc.request;
  rpc.request = async (method, params, options) => {
    if (method !== 'sendrawtransaction') return request(method, params, options);
    options.beforeSend(); payloads.push(params.transaction_hex);
    if (payloads.length === 1) {
      refusedAt = Date.now();
      // notForwarded is normally attached by the validated RPC reply parser.
      throw Object.assign(new Error('Private RPC text must not reach the UI'), {
        code, notForwarded: true, data: { retry_after_ms: retryAfterMs },
      });
    }
    return { txid: transactionId(parseTransaction(params.transaction_hex)) };
  };
  t.after(() => service.engine.stop());
  service.engine.enqueue([bounty]); service.engine.start();
  const key = bountyKey(bounty);
  await until(() => service.engine.pendingProofs.get(key)?.failures === 1);
  const job = service.engine.queue.get(key), winner = service.engine.pendingProofs.get(key);
  assert.equal(service.engine.enabled, true); assert.equal(service.claimsReviewRequired, false);
  assert.equal(service.reserved.has(key), false, 'An explicit refusal must not leave an ambiguous reservation');
  assert.equal(job.winner, true); assert.ok(winner.due >= Math.min(Number.MAX_SAFE_INTEGER, refusedAt + retryAfterMs));
  assert.ok(winner.due >= refusedAt + service.engine.retryDelayMs, 'Explicit zero does not remove the ordinary exponential backoff');
  assert.equal(captures, 1); assert.equal(service.engine.state.attempts, 1); assert.equal(service.engine.state.completed, 0);
  assert.doesNotMatch(service.engine.state.lastError, /Private RPC text/);
  await service.syncBountiesInternal(service.epoch);
  assert.strictEqual(service.engine.pendingProofs.get(key), winner);
  assert.equal(payloads.length, 1, 'Discovery must neither discard the winner nor skip its backoff');
  // Advance this one stored retry deadline, without a minute-long test sleep.
  job.due = 0; winner.due = 0; service.engine.kick();
  await until(() => service.engine.state.completed === 1);
  assert.equal(payloads.length, 2); assert.equal(payloads[0], payloads[1]);
  assert.equal(payloads[0], attachClaimProof(prepared, structuralProof(prepared)).hex);
  assert.equal(captures, 1); assert.equal(service.engine.state.attempts, 1);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.pendingProofs.size, 0);
});
}

test('claims retry timers split safe-integer cooldowns instead of overflowing to 1 ms', async () => {
  const engine = new ClaimsEngine({ prepare: async () => ({}), submit: async () => {}, isUnlocked: () => true });
  engine.enabled = true;
  engine.schedule(Number.MAX_SAFE_INTEGER);
  assert.equal(engine.timer._idleTimeout, 2_147_483_647);
  await engine.stop();
});

for (const transition of ['stop', 'lock', 'RPC replacement']) test(`catalog waiting is cancellable on ${transition}`, async t => {
  const { service, bounty } = serviceFixture();
  service.createEngine(); service.engine.enabled = true; service.blockClaimCatalog();
  t.after(() => service.releaseClaimCatalog());
  const controller = new AbortController();
  const waiting = service.prepareAutomaticClaim(bounty, { signal: controller.signal });
  const rejected = assert.rejects(waiting, /stopped|locked|cancelled|changed/i);
  await tick();
  if (transition === 'stop') { await service.engine.stop(); controller.abort(); }
  if (transition === 'lock') { service.session = null; service.releaseClaimCatalog(); }
  if (transition === 'RPC replacement') { service.rpc = new EventEmitter(); service.releaseClaimCatalog(); }
  await rejected;
});

test('retained winners share four RPC submission slots without repeating captures', async t => {
  const submitted = [], gates = Array.from({ length: 6 }, deferred);
  const engine = new ClaimsEngine({ isUnlocked: () => true, randomIndex: () => 0,
    options: { connectionsPerSecond: 256, concurrency: 8 },
    prepare: async bounty => ({ context: { ...context(), txid: bounty.txid } }),
    generateProof: async () => '020100',
    submit: async prepared => {
      const index = submitted.length; submitted.push(prepared.context.txid);
      await gates[index].promise; return prepared.context.txid;
    },
  });
  t.after(async () => { gates.forEach(gate => gate.resolve()); await engine.stop(); });
  const old = Array.from({ length: 6 }, (_, i) => row(1, { txid: hash(3000 + i) }));
  engine.enqueue(old); engine.start(); await until(() => engine.pendingProofs.size === 6);
  for (const bounty of old) engine.retire(bounty.txid, bounty.vout);
  assert.equal([...engine.queue.values()].every(job => job.retired), true);
  assert.equal(engine.submitting.size, 4); assert.equal(submitted.length, 4);
  gates[0].resolve(); await until(() => submitted.length === 5);
  assert.equal(engine.submitting.size, 4);
  gates[1].resolve(); await until(() => submitted.length === 6);
  assert.equal(engine.submitting.size, 4);
  gates.forEach(gate => gate.resolve()); await until(() => engine.state.completed === 6);
  assert.equal(engine.state.attempts, 6, 'sending retained winners does not repeat TLS or capture accounting');
  assert.equal(engine.pendingProofs.size, 0);
  assert.equal(new Set(submitted).size, 6);
});

for (const [field, value] of [['domain', 'other.example'], ['amount', '999999999'],
  ['connection_work_target', '7'.repeat(64)], ['root_certificates_version', 2], ['signature_algorithms_mask', 6], ['coinbase', true]]) {
  test(`resync rejects changed immutable ${field} before publication`, async t => {
    const { service, bounty } = serviceFixture(); service.createEngine(); service.engine.enabled = true;
    service.engine.kick = () => {}; t.after(async () => { await service.engine.stop(); service.releaseClaimCatalog(); });
    const oldRows = service.claimOutpoints, oldBlocks = service.claimBlocks, oldCursor = service.claimCursor;
    mockDiscovery(service, { height: 600, rows: [{ ...bounty, [field]: value }], event: { type: 'resync_required' } });
    await assert.rejects(service.syncBounties(), /metadata changed/);
    assert.strictEqual(service.claimOutpoints, oldRows); assert.strictEqual(service.claimBlocks, oldBlocks);
    assert.equal(service.claimCursor, oldCursor); assert.equal(service.engine.enabled, false);
  });
}

test('discovery preserves a verified automatic winner reserved while waiting for RPC capacity', async t => {
  const { service, bounty, rpc } = serviceFixture();
  const gate = deferred(); let prepared, signal, entered = false, writes = 0, captures = 0;
  service.createEngine();
  const prepare = service.engine.prepare;
  service.engine.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  service.testProofRunner = async () => { captures++; return structuralProof(prepared); };
  mockDiscovery(service, { height: 600, rows: [bounty] });
  const discoveryRequest = rpc.request;
  rpc.request = async (method, params, options) => {
    if (method !== 'sendrawtransaction') return discoveryRequest(method, params, options);
    entered = true; signal = options.signal;
    await new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('Unsent request cancelled'), { name: 'AbortError', notSent: true }));
      signal.addEventListener('abort', abort, { once: true });
      gate.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      if (signal.aborted) abort();
    });
    options.beforeSend(); writes++;
    return { txid: transactionId(parseTransaction(params.transaction_hex)) };
  };
  t.after(async () => { gate.resolve(); await service.engine.stop(); });
  service.engine.enqueue([bounty]); service.engine.start(); await until(() => entered);
  const key = bountyKey(bounty);
  assert.equal(service.reserved.has(key), true);
  assert.equal(service.engine.pendingProofs.has(key), true);
  for (let repeat = 0; repeat < 3; repeat++) await service.syncBountiesInternal(service.epoch);
  assert.equal(signal.aborted, false, 'a local reservation must not cancel its own unsent winner');
  assert.equal(service.engine.pendingProofs.has(key), true);
  assert.equal(service.engine.queue.get(key).submitting, true);
  assert.equal(writes, 0); assert.equal(captures, 1, 'discovery must not duplicate the reserved work');
  gate.resolve(); await until(() => service.engine.snapshot().completed === 1);
  assert.equal(writes, 1); assert.equal(service.engine.pendingProofs.has(key), false);
});

test('discovery still removes a bounty reserved outside its active automatic submission', async t => {
  const { service, bounty } = serviceFixture();
  service.createEngine(); service.engine.enabled = true; service.engine.kick = () => {};
  t.after(() => service.engine.stop());
  const key = bountyKey(bounty);
  service.engine.enqueue([bounty]); service.reserved.add(key);
  // A pending proof alone cannot bypass a reservation owned by another flow.
  service.engine.pendingProofs.set(key, { proof: '020100', due: 0, failures: 0 });
  mockDiscovery(service, { height: 600, rows: [bounty] });
  await service.syncBountiesInternal(service.epoch);
  assert.equal(service.engine.queue.has(key), false);
  assert.equal(service.engine.pendingProofs.has(key), false);
  assert.equal(service.reserved.has(key), true, 'discovery must not release another flow\'s reservation');
});

test('a complete discovery rescan keeps each surviving bounty factor and domain history', async t => {
  const { service, bounty } = serviceFixture();
  service.createEngine();
  t.after(() => service.engine.stop());
  service.engine.enabled = true;
  service.engine.kick = () => {}; // Exercise discovery only, never launch the TLS helper.
  let draws = 0;
  service.engine.randomIndex = () => ++draws;
  service.engine.enqueue([bounty]);
  const job = service.engine.queue.get(bountyKey(bounty)), factor = job.factor;
  service.engine.recordAttemptStats(job, { validation: 'certificate-proof-v1', completed: 1, recent: [[true, 0.1]] }, 0);
  service.claimCursor = null; // An expired cursor requires the same full-rescan path.
  mockDiscovery(service, { height: 600, rows: [bounty] });
  await service.syncBountiesInternal(service.epoch);
  assert.equal(service.engine.queue.get(bountyKey(bounty)).factor, factor);
  assert.equal(service.engine.domainStats.get('example.com:7').completed, 1);
  assert.equal(draws, 1, 'resynchronizing discovery must not reroll a surviving bounty');
});

for (const result of ['success', 'failure']) test(`window rollover retains only active metadata and preserves a winner: ${result}`, async t => {
  const { service, bounty, calls } = serviceFixture();
  const bounties = Array.from({ length: 1000 }, (_, vout) => ({ ...bounty, vout }));
  service.claimBlocks.set(bounty.block_hash, bounties);
  service.claimOutpoints = new Map(bounties.map(value => [bountyKey(value), value]));
  const gate = deferred(); let prepared, entered = false;
  service.createEngine();
  service.engine.randomIndex = () => 0;
  const prepare = service.engine.prepare;
  service.engine.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  service.testProofRunner = async () => { entered = true; await gate.promise; if (result === 'failure') throw new Error('Mocked TLS failure'); return structuralProof(prepared); };
  t.after(async () => { gate.resolve(); await service.engine.stop(); });
  service.engine.enqueue(bounties); service.engine.start(); await until(() => entered);
  mockDiscovery(service, { height: 601 });
  await service.syncBountiesInternal(service.epoch);
  assert.equal(service.claimBlocks.has(bounty.block_hash), false);
  assert.equal(service.claimOutpoints.size, 1, 'only one in-flight row survives, not the entire old block');
  assert.equal(service.engine.queue.size, 1);
  assert.equal(service.engine.controller.signal.aborted, false);
  assert.equal(service.tip.height, 601, 'discovery refreshes the shared tip before resuming claims');
  gate.resolve(); await until(() => !service.engine.running && !service.engine.submitting.size);
  assert.equal(service.claimOutpoints.size, 0, 'finished work releases its retained metadata');
  assert.equal(service.engine.queue.size, 0);
  assert.equal(service.retiredClaims.size, 0);
  assert.equal(service.engine.pendingProofs.size, 0);
  assert.equal(service.engine.state.completed, result === 'success' ? 1 : 0);
  assert.equal(service.engine.enabled, true);
  assert.equal(calls.filter(call => call.method === 'getchaintip').length, 0);
  assert.equal(calls.filter(call => call.method === 'sendrawtransaction').length, result === 'success' ? 1 : 0);
});

for (const reason of ['spent', 'pending_spend', 'reorg']) test(`${reason} cancels an active proof instead of treating it as an ordinary window exit`, async t => {
  const { service, bounty, calls } = serviceFixture();
  const gate = deferred(); let prepared, entered = false;
  service.createEngine();
  const prepare = service.engine.prepare;
  service.engine.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  service.testProofRunner = async () => { entered = true; await gate.promise; return structuralProof(prepared); };
  t.after(async () => { gate.resolve(); await service.engine.stop(); });
  service.engine.enqueue([bounty]); service.engine.start(); await until(() => entered);
  const signal = service.engine.controller.signal;
  mockDiscovery(service, { height: 600, reorg: reason === 'reorg',
    event: reason === 'reorg' ? null : { sequence: 1, type: reason, txid: bounty.txid, vout: bounty.vout, spending_txid: hash(950) },
    rows: reason === 'reorg' ? [] : [{ ...bounty, status: reason, spending_txid: hash(950) }],
  });
  await service.syncBountiesInternal(service.epoch);
  assert.equal(signal.aborted, true);
  gate.resolve(); await until(() => !service.engine.running);
  assert.equal(calls.filter(call => call.method === 'sendrawtransaction').length, 0);
});

test('discovery reports a reorg, not expiry, when a canonical block is replaced outside the selected lookback', async () => {
  const bounty = row(599), previous = new Map([[bounty.block_hash, [bounty]]]), invalidations = [];
  const snapshot = window(600);
  snapshot.blocks[1].hash = hash(12000);
  const rpc = { async request(method) {
    if (method === 'getrecentblockhashes') return snapshot;
    if (method === 'getchaintip') return structuredClone(snapshot.tip);
    if (method === 'getbountychanges') return { tip: snapshot.tip, next_cursor: 'c1', has_more: false, changes: [] };
    throw new Error(`Unexpected request ${method}`);
  } };
  await discoverBounties({ rpc, network: 'testnet4', lookback: 1, previous, cursor: 'c0',
    readBlock: async () => [], onInvalidate: (value, reason) => invalidations.push({ value, reason }) });
  assert.equal(invalidations[0]?.reason, 'reorg');
});

for (const when of ['later scan', 'same scan']) test(`a retired in-flight claim is cancelled by a reorg seen in the ${when}`, async t => {
  const { service, bounty, calls } = serviceFixture({ height: 599, bountyHeight: 599 });
  service.config.claims.lookbackBlocks = 1;
  const gate = deferred(); let prepared, entered = false;
  service.createEngine();
  const prepare = service.engine.prepare;
  service.engine.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  service.testProofRunner = async () => { entered = true; await gate.promise; return structuralProof(prepared); };
  t.after(async () => { gate.resolve(); await service.engine.stop(); });
  service.engine.enqueue([bounty]); service.engine.start(); await until(() => entered);
  const signal = service.engine.controller.signal;
  const snapshot = mockDiscovery(service, { height: 600 });
  const request = service.rpc.request;
  let fences = 0, replace = false;
  service.rpc.request = async (method, params) => {
    if (replace || method === 'getchaintip' && ++fences === 1 && when === 'same scan') {
      // Replacing an ancestor also changes the descendant tip: a block hash
      // cannot identify two conflicting ancestral chains.
      snapshot.blocks.find(block => block.height === 599).hash = hash(15000);
      snapshot.blocks[0].hash = snapshot.tip.hash = hash(15001);
    }
    return request(method, params);
  };
  await service.syncBountiesInternal(service.epoch);
  assert.equal(service.claimBlocks.has(bounty.block_hash), false);
  if (when === 'later scan') {
    assert.equal(signal.aborted, false);
    assert.equal(service.claimOutpoints.has(bountyKey(bounty)), true);
    replace = true;
    await service.syncBountiesInternal(service.epoch);
  }
  assert.equal(signal.aborted, true, 'leaving the selected lookback must not make the active claim invisible to reorg checks');
  gate.resolve(); await until(() => !service.engine.running);
  assert.equal(calls.filter(call => call.method === 'sendrawtransaction').length, 0);
  assert.equal(service.claimOutpoints.has(bountyKey(bounty)), false);
});

test('a journal window_exit sends the retained winner without catalog reentry or extra availability RPC', async t => {
  const { service, bounty, calls } = serviceFixture();
  const gate = deferred(); let prepared, entered = false;
  service.createEngine();
  const prepare = service.engine.prepare;
  service.engine.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  service.testProofRunner = async () => { entered = true; await gate.promise; return structuralProof(prepared); };
  t.after(async () => { gate.resolve(); await service.engine.stop(); });
  service.engine.enqueue([bounty]); service.engine.start(); await until(() => entered);
  const signal = service.engine.controller.signal;
  mockDiscovery(service, { height: 601, event: { sequence: 1, type: 'window_exit', txid: bounty.txid, vout: bounty.vout } });
  await service.syncBountiesInternal(service.epoch);
  assert.equal(signal.aborted, false);
  assert.equal(service.engine.queue.get(bountyKey(bounty)).retired, true);
  const afterDiscovery = calls.length;
  gate.resolve();
  await until(() => service.engine.state.completed === 1);
  assert.equal(service.engine.state.attempts, 1, 'normal aging reuses the proof without another capture');
  assert.equal(calls.filter(call => call.method === 'sendrawtransaction').length, 1);
  assert.deepEqual(calls.slice(afterDiscovery).map(call => call.method), ['sendrawtransaction']);
  assert.equal(calls.at(-1).params.transaction_hex, attachClaimProof(prepared, structuralProof(prepared)).hex);
  assert.equal(service.claimOutpoints.size, 0); assert.equal(service.retiredClaims.size, 0);
  assert.equal(service.engine.pendingProofs.size, 0);
});

for (const failure of ['proven-unsent', 'node-rejection']) test(`aging during RPC queue preserves the exact winner after ${failure}`, async t => {
  const { service, bounty, rpc } = serviceFixture();
  const gate = deferred(), payloads = []; let prepared, entered = false, writes = 0, captures = 0;
  service.createEngine(); service.engine.retryDelayMs = 1;
  const prepare = service.engine.prepare;
  service.engine.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  service.testProofRunner = async () => { captures++; return structuralProof(prepared); };
  mockDiscovery(service, { height: 601, event: { sequence: 1, type: 'window_exit', txid: bounty.txid, vout: bounty.vout } });
  const request = rpc.request;
  rpc.request = async (method, params, options) => {
    if (method !== 'sendrawtransaction') return request(method, params, options);
    payloads.push(params.transaction_hex);
    if (payloads.length === 1) {
      entered = true; await gate.promise;
      if (failure === 'proven-unsent') throw Object.assign(new Error('No bytes written'), { notSent: true });
      options.beforeSend(); writes++;
      throw Object.assign(new Error('Node rejected'), { code: -32020, data: { node_code: -26 } });
    }
    options.beforeSend(); writes++;
    return { txid: transactionId(parseTransaction(params.transaction_hex)) };
  };
  t.after(async () => { gate.resolve(); await service.engine.stop(); });
  service.engine.enqueue([bounty]); service.engine.start(); await until(() => entered);
  const key = bountyKey(bounty), saved = service.engine.pendingProofs.get(key);
  await service.syncBountiesInternal(service.epoch);
  assert.equal(service.engine.queue.get(key).retired, true);
  assert.equal(service.reserved.has(key), true);
  assert.strictEqual(service.engine.pendingProofs.get(key), saved);
  assert.equal(service.engine.state.completed, 0);
  gate.resolve(); await until(() => service.engine.state.completed === 1);
  assert.equal(payloads.length, 2); assert.equal(payloads[0], payloads[1]);
  assert.equal(payloads[0], attachClaimProof(prepared, saved.proof).hex);
  assert.equal(writes, failure === 'proven-unsent' ? 1 : 2);
  assert.equal(captures, 1); assert.equal(service.engine.state.attempts, 1);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.enabled, true);
  assert.equal(service.engine.pendingProofs.size, 0); assert.equal(service.retiredClaims.size, 0);
});

for (const invalidation of ['spent', 'pending_spend']) test(`a ${invalidation} event after aging still cancels the retained capture`, async t => {
  const { service, bounty, calls } = serviceFixture();
  const gate = deferred(); let prepared, entered = false;
  service.createEngine();
  const prepare = service.engine.prepare;
  service.engine.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  service.testProofRunner = async () => { entered = true; await gate.promise; return structuralProof(prepared); };
  t.after(async () => { gate.resolve(); await service.engine.stop(); });
  service.engine.enqueue([bounty]); service.engine.start(); await until(() => entered);
  const signal = service.engine.controller.signal;
  mockDiscovery(service, { height: 601, event: { sequence: 1, type: 'window_exit', txid: bounty.txid, vout: bounty.vout } });
  await service.syncBountiesInternal(service.epoch);
  assert.equal(service.claimBlocks.has(bounty.block_hash), false); assert.equal(signal.aborted, false);
  service.claimCursor = 'c0';
  mockDiscovery(service, { height: 602, event: { sequence: 2, type: invalidation, txid: bounty.txid, vout: bounty.vout, spending_txid: hash(950) } });
  await service.syncBountiesInternal(service.epoch);
  assert.equal(signal.aborted, true);
  gate.resolve(); await until(() => !service.engine.running);
  assert.equal(calls.filter(call => call.method === 'sendrawtransaction').length, 0);
  assert.equal(service.engine.pendingProofs.size, 0); assert.equal(service.retiredClaims.size, 0);
});

test('an unknown broadcast outcome for an aged winner still stops claims without automatic retransmission', async t => {
  const { service, bounty, rpc } = serviceFixture();
  service.queueSettings = async () => {}; // Safety flags are checked below; never write a wallet fixture.
  const gate = deferred(); let prepared, entered = false, sends = 0;
  service.createEngine();
  const prepare = service.engine.prepare;
  service.engine.prepare = async (...args) => { prepared = await prepare(...args); return prepared; };
  service.testProofRunner = async () => { entered = true; await gate.promise; return structuralProof(prepared); };
  const request = rpc.request;
  rpc.request = async (method, params, options) => {
    if (method !== 'sendrawtransaction') return request(method, params, options);
    options.beforeSend(); sends++; throw new Error('Connection lost after writing');
  };
  t.after(async () => { gate.resolve(); await service.engine.stop(); });
  service.engine.enqueue([bounty]); service.engine.start(); await until(() => entered);
  mockDiscovery(service, { height: 601 }); await service.syncBountiesInternal(service.epoch);
  gate.resolve(); await until(() => !service.engine.enabled && !service.engine.running);
  assert.equal(sends, 1); assert.equal(service.engine.state.completed, 0);
  assert.equal(service.reserved.has(bountyKey(bounty)), true);
  assert.equal(service.claimsReviewRequired, true);
  assert.match(service.error, /broadcast was not confirmed/i);
  service.engine.kick(); await tick(); assert.equal(sends, 1);
});
