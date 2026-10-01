import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ClaimsEngine } from '../src/core/claims.mjs';
import { discoverBounties, bountyKey } from '../src/core/bounty-discovery.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';
import { parseTransaction, serializeTransaction, transactionId } from '../src/core/transaction.mjs';

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

test('an available bounty older than 600 blocks can prepare and submit without per-claim getchaintip', async () => {
  const { service, bounty, calls } = serviceFixture({ height: 800 });
  service.claimBlocks.clear();
  const prepared = await service.prepareAutomaticClaim(bounty);
  assert.equal(prepared.context.validation_time, tip(800).mediantime);
  const result = await service.submitAutomaticClaim(prepared, structuralProof(prepared));
  assert.equal(result.txid, prepared.txid);
  assert.deepEqual(calls.map(call => call.method), ['sendrawtransaction']);
});

test('retries reuse the fixed claim fee, payout and receiving address while refreshing certificate time', async () => {
  const { service, bounty, raw, calls } = serviceFixture();
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

test('a claim crossing the discovery boundary during preparation and proof generation still submits', async () => {
  const { service, bounty, calls, raw } = serviceFixture();
  const funding = deferred();
  service.funding = () => funding.promise;
  const preparation = service.prepareAutomaticClaim(bounty);
  service.tip = tip(601); service.claimBlocks.clear();
  funding.resolve(raw);
  const prepared = await preparation;
  service.tip = tip(1000);
  assert.equal(prepared.context.validation_time, tip(600).mediantime, 'the prepared certificate time remains immutable');
  await service.submitAutomaticClaim(prepared, structuralProof(prepared));
  assert.equal(calls.filter(call => call.method === 'getchaintip').length, 0);
  assert.equal(calls.filter(call => call.method === 'sendrawtransaction').length, 1);
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

test('removing the window check retains availability, reservation, cancellation and funding authentication safeguards', async () => {
  for (const state of ['missing', 'spent', 'pending_spend', 'reserved', 'cancelled', 'wrong-domain']) {
    const { service, bounty, calls } = serviceFixture({ height: 900 });
    const signal = new AbortController();
    if (state === 'missing') service.claimOutpoints.clear();
    if (['spent', 'pending_spend'].includes(state)) bounty.status = state;
    if (state === 'reserved') service.reserved.add(bountyKey(bounty));
    if (state === 'cancelled') signal.abort();
    if (state === 'wrong-domain') bounty.domain = 'attacker.example';
    await assert.rejects(service.prepareAutomaticClaim(bounty, { signal: signal.signal }), /eligible|stopped|domain differs/i, state);
    assert.equal(calls.length, 0);
  }
  const { service, bounty, calls } = serviceFixture({ height: 900 });
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

test('the shared validated tip is cleared on reconnect, current RPC disconnection and locking', async () => {
  const { service } = serviceFixture();
  const clients = [];
  service.clientFactory = () => {
    const client = new EventEmitter(); client.close = () => {};
    clients.push(client); return client;
  };
  service.connectClient(); assert.equal(service.tip, null);
  service.tip = tip(600);
  clients[0].emit('disconnected'); assert.equal(service.tip, null);
  service.connectClient(); service.tip = tip(601);
  clients[0].emit('disconnected');
  assert.equal(service.tip.height, 601, 'an obsolete connection must not clear a newer connection state');
  await service.lock();
  assert.equal(service.tip, null);
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

function mockDiscovery(service, { height, reorg = false, event = null, rows = [] }) {
  const previousRequest = service.rpc.request;
  let journalCalls = 0;
  const snapshot = window(height);
  if (reorg) {
    snapshot.blocks = snapshot.blocks.map(block => ({ ...block, hash: hash(block.height + 10001) }));
    snapshot.tip.hash = snapshot.blocks[0].hash;
  }
  service.rpc.request = async (method, params) => {
    if (method === 'getrecentblockhashes') return structuredClone(snapshot);
    if (method === 'getbountychanges') return { tip: snapshot.tip, next_cursor: 'c1', has_more: false, changes: ++journalCalls === 1 && event ? [event] : [] };
    return previousRequest(method, params);
  };
  service.blockBounties = async blockHash => rows.filter(value => value.block_hash === blockHash);
}

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

for (const result of ['success', 'failure']) test(`window rollover retains only active local metadata and releases it after ${result}`, async t => {
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
  gate.resolve(); await until(() => !service.engine.running);
  assert.equal(service.claimOutpoints.size, 0, 'settled retired metadata must not accumulate');
  assert.equal(service.engine.queue.size, 0);
  assert.equal(service.retiredClaims.size, 0);
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
  mockDiscovery(service, { height: 600 });
  const request = service.rpc.request;
  let reads = 0, replace = false;
  service.rpc.request = async (method, params) => {
    const value = await request(method, params);
    if (method === 'getrecentblockhashes' && (++reads >= 2 && when === 'same scan' || replace)) {
      value.blocks.find(block => block.height === 599).hash = hash(15000);
    }
    return value;
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

test('a journal window_exit retires an active proof without aborting its submission', async t => {
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
  gate.resolve(); await until(() => !service.engine.running);
  assert.equal(calls.filter(call => call.method === 'sendrawtransaction').length, 1);
  assert.equal(service.claimOutpoints.has(bountyKey(bounty)), false);
});
