import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverBounties, readBountyBlock } from '../src/core/bounty-discovery.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';
import { StatePublisher } from '../src/core/state-publisher.mjs';
import { serializeTransaction, transactionId } from '../src/core/transaction.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';

const hash = index => index.toString(16).padStart(64, '0');
const tip = height => ({ chain: 'testnet4', genesis_hash: GENESIS.testnet4, height, hash: hash(height + 1), mediantime: 1800000000 });
const window = height => ({ window: 600, tip: tip(height), blocks: Array.from({ length: Math.min(600, height + 1) }, (_, index) => ({ height: height - index, hash: hash(height - index + 1) })) });
const row = (height = 1, delta = {}) => ({ txid: hash(900), vout: 0, amount: '1000000000', domain: 'example.com', connection_work_target: 'f'.repeat(64), root_certificates_version: 1, signature_algorithms_mask: 7, block_height: height, block_hash: hash(height + 1), coinbase: false, confirmations: 1, status: 'available', spending_txid: null, ...delta });
const page = (cursor, changes = [], has_more = false, height = 1) => ({ tip: tip(height), changes, next_cursor: cursor, has_more });

function fixture({ height = 1, changes = () => page('c0', [], false, height), windows = () => window(height), rows = new Map([[hash(2), [row()]]]) } = {}) {
  const calls = [], invalidated = [];
  let resets = 0, currentHeight = height;
  const rpc = { async request(method, params = {}, options = {}) {
    calls.push({ method, ...params });
    if (method === 'getbountychanges') return changes(params, calls);
    if (method === 'getrecentblockhashes') { const value = windows(calls); currentHeight = value.tip.height; return value; }
    if (method === 'getblockbounties') {
      const values = structuredClone(rows.get(params.block_hash) ?? []).map(value => ({ ...value, confirmations: currentHeight - value.block_height + 1 }));
      options.onChunk({ type: 'snapshot', tip: tip(currentHeight), block_hash: params.block_hash, unit: 'connects', cursor: 'stream-start' });
      options.onChunk({ type: 'bounties', tip: tip(currentHeight), items: values });
      options.onChunk({ type: 'state', tip: tip(currentHeight), cursor: 'stream-end' });
      return { chunks: 3, records: values.length };
    }
    throw new Error(`Unexpected method ${method}`);
  } };
  return { rpc, rows, calls, invalidated, get resets() { return resets; },
    run(extra = {}) { return discoverBounties({ rpc, network: 'testnet4', onInvalidate: value => invalidated.push(value), onReset: async () => { resets++; }, readBlock: (blockHash, options) => readBountyBlock({ rpc, network: 'testnet4', hash: blockHash, ...options }), ...extra }); } };
}

test('bounty discovery requests complete streams including empty blocks and publishes only after journal replay', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.blocks.size, 2);
  assert.equal(result.blocks.get(hash(2)).length, 1);
  assert.equal(result.blocks.get(hash(1)).length, 0);
  assert.equal(result.cursor, 'c0');
  assert.equal(f.calls[0].method, 'getbountychanges');
});

for (const lookback of [600, 7]) test(`discovery reads the oldest of the selected ${lookback} blocks first`, async () => {
  const f = fixture({ height: 620, rows: new Map() });
  const result = await f.run({ lookback });
  const reads = f.calls.filter(call => call.method === 'getblockbounties').map(call => call.block_hash);
  assert.deepEqual(reads, Array.from({ length: lookback }, (_, index) => hash(622 - lookback + index)));
  assert.equal(result.blocks.size, lookback);
  assert.equal(result.tip.height, 620);
  assert.equal(f.resets, 1);
});

test('advancing a full recent window during discovery does not discard and reread the scan', async () => {
  let height = 620, requests = 0, expired = 0;
  const f = fixture({ rows: new Map(), windows: () => window(height), changes: () => page('c0', [], false, height) });
  const request = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (method, params, options) => {
    if (method === 'getblockbounties') {
      // Two advances while scanning: newest-first would reach the expired
      // oldest blocks last and restart; oldest-first has already read them.
      requests++;
      if (requests === 100 || requests === 450) height += 4;
      const blockHeight = Number.parseInt(params.block_hash, 16) - 1;
      if (blockHeight < height - 599) {
        expired++;
        throw Object.assign(new Error('Block left the recent window'), { code: -32004 });
      }
    }
    return request(method, params, options);
  };
  const result = await f.run();
  assert.equal(expired, 0);
  assert.equal(f.resets, 1, 'only the initial snapshot reset is needed');
  assert.equal(requests, 608, 'read the initial window once, then only the eight new blocks');
  const reads = f.calls.filter(call => call.method === 'getblockbounties').map(call => call.block_hash);
  assert.equal(new Set(reads).size, reads.length, 'completed blocks are not fetched again');
  assert.equal(result.tip.height, 628);
  assert.equal(result.blocks.size, 600);
  assert.deepEqual([...result.blocks.keys()].sort(), window(628).blocks.map(block => block.hash).sort());
});

test('incremental discovery reads only dirty and missing blocks, oldest first', async () => {
  let journalCalls = 0;
  const changes = [2, 7].map((height, index) => ({ sequence: index + 1, type: 'available_again', txid: hash(900 + index), vout: 0, block_hash: hash(height + 1) }));
  const f = fixture({ height: 10, rows: new Map(), changes: () => page('c2', ++journalCalls === 1 ? changes : [], false, 10) });
  const previous = new Map(window(9).blocks.map(block => [block.hash, []]));
  const result = await f.run({ previous, cursor: 'c0' });
  assert.deepEqual(f.calls.filter(call => call.method === 'getblockbounties').map(call => call.block_hash), [hash(3), hash(8), hash(11)]);
  assert.equal(result.blocks.size, 11);
  assert.equal(result.cursor, 'c2');
  assert.equal(f.resets, 0);
  assert.equal(previous.size, 10, 'discovery must not mutate the caller cache');
});

test('spend events without block_hash refresh their original cached block; no resurrection', async () => {
  let requests = 0;
  const f = fixture({ changes() {
    if (++requests === 2) { f.rows.set(hash(2), [row(1, { status: 'spent', spending_txid: hash(950) })]); return page('c1', [{ sequence: 1, type: 'spent', txid: hash(900), vout: 0, spending_txid: hash(950) }]); }
    return page(requests > 1 ? 'c1' : 'c0');
  } });
  const result = await f.run();
  assert.equal(result.blocks.get(hash(2))[0].status, 'spent');
  assert.equal(f.calls.filter(call => call.method === 'getblockbounties' && call.block_hash === hash(2)).length, 2);
  assert.ok(f.invalidated.some(value => value.txid === hash(900)));
});

test('all initial journal pages are consumed, including matured and available_again without block_hash', async () => {
  let calls = 0;
  const f = fixture({ changes() {
    calls++;
    if (calls === 1) return page('c1', [{ sequence: 1, type: 'pending_spend', txid: hash(900), vout: 0 }], true);
    if (calls === 2) return page('c2', [{ sequence: 2, type: 'available_again', txid: hash(900), vout: 0 }], true);
    if (calls === 3) return page('c3', [{ sequence: 3, type: 'matured', txid: hash(900), vout: 0 }]);
    return page('c3');
  } });
  const result = await f.run({ previous: new Map([[hash(2), [row(1, { status: 'immature', coinbase: true })]], [hash(1), []]]), cursor: 'c0' });
  assert.deepEqual(f.calls.filter(call => call.method === 'getbountychanges').map(call => call.cursor).slice(0, 4), ['c0', 'c1', 'c2', 'c3']);
  assert.equal(result.blocks.get(hash(2))[0].status, 'available');
  assert.equal(result.cursor, 'c3');
  assert.equal(f.resets, 0);
});

for (const mode of ['expired cursor', 'explicit resync']) test(`a ${mode} during catch-up triggers a full new snapshot`, async () => {
  let calls = 0;
  const f = fixture({ changes() {
    calls++;
    if (calls === 2) {
      f.rows.set(hash(2), [row(1, { status: 'pending_spend', spending_txid: hash(951) })]);
      if (mode === 'expired cursor') throw Object.assign(new Error('expired'), { code: -32011 });
      return page('c1', [{ sequence: 1, type: 'resync_required' }]);
    }
    return page(calls > 2 ? 'c2' : 'c0');
  } });
  const result = await f.run();
  assert.equal(result.blocks.size, 2);
  assert.equal(result.blocks.get(hash(2))[0].status, 'pending_spend');
  assert.ok(f.resets >= 2);
  assert.equal(f.calls.filter(call => call.method === 'getblockbounties' && call.block_hash === hash(2)).length, 2);
});

test('new blocks appearing during scan are incorporated before completion', async () => {
  let windows = 0;
  const f = fixture({ windows: () => window(++windows === 1 ? 1 : 2), changes: () => page('c0', [], false, 2) });
  f.rows.set(hash(3), [row(2, { txid: hash(901) })]);
  const result = await f.run();
  assert.equal(result.tip.height, 2);
  assert.equal(result.blocks.size, 3);
  assert.equal(result.blocks.get(hash(3))[0].txid, hash(901));
});

test('window exits remove queued outpoints even when they have no journal block hash', async () => {
  const obsolete = row(0, { block_hash: hash(1) });
  const f = fixture({ height: 600, rows: new Map(), changes: () => page('c1', [], false, 600) });
  const result = await f.run({ previous: new Map([[hash(1), [obsolete]]]), cursor: 'c0' });
  assert.equal(result.blocks.size, 600);
  assert.equal(result.blocks.has(hash(1)), false);
  assert.ok(f.invalidated.some(value => value.txid === obsolete.txid));
});

test('shared row budget rejects oversized streams before allocating a full flattened snapshot', async () => {
  const f = fixture(); f.rows.set(hash(2), [row(), row(1, { vout: 1 })]);
  const budget = { count: 0, limit: 1 };
  await assert.rejects(readBountyBlock({ rpc: f.rpc, network: 'testnet4', hash: hash(2), height: 1, budget }), /resource limit/);
  assert.equal(budget.count, 1);
});

test('incomplete streams, duplicate bounties and malformed cursors cannot be published', async () => {
  const f = fixture(); f.rows.set(hash(2), [row(), row()]);
  await assert.rejects(f.run(), /Duplicate bounty/);
  const rpc = { async request(method, params, { onChunk }) {
    onChunk({ type: 'snapshot', tip: tip(1), block_hash: hash(2), unit: 'connects', cursor: 'c0' });
    return { chunks: 1, records: 0 };
  } };
  await assert.rejects(readBountyBlock({ rpc, network: 'testnet4', hash: hash(2) }), /Incomplete/);
  await assert.rejects(fixture({ changes: () => page('', []) }).run(), /journal/);
  await assert.rejects(fixture({ changes: () => page('c1', [], true) }).run(), /journal/);
});

test('epoch cancellation prevents partial block data escaping discovery', async () => {
  let current = true;
  const f = fixture({ changes() { current = false; return page('c0'); } });
  await assert.rejects(f.run({ check: () => { if (!current) throw new Error('Wallet locked'); } }), /locked/);
  assert.equal(f.calls.filter(call => call.method === 'getblockbounties').length, 0);
});

test('real discovery of thousands of mostly spent bounties publishes bounded snapshots across repeated refreshes', async () => {
  const rows = new Map([100, 101, 102].map(height => [hash(height + 1), Array.from({ length: 1000 }, (_, vout) => row(height, {
    txid: hash(900 + height), vout, status: vout < 990 ? 'spent' : 'available',
    spending_txid: vout < 990 ? hash(950) : null,
  }))]));
  const f = fixture({ height: 620, rows });
  const service = new WalletService({ directory: '/unused-unit-test', proofRunner: async () => '020100' });
  service.config = structuredClone(DEFAULT_CONFIG);
  service.walletExists = true; service.session = { data: { name: 'Fixture', receiveIndex: 0 } }; service.epoch = 1;
  service.rpc = f.rpc;
  service.createEngine(); service.engine.enabled = true;
  // Exercise discovery and the real queue, but never start an external TLS proof.
  let kicks = 0, notifications = 0, snapshots = 0, time = 0;
  service.engine.kick = () => { kicks++; };
  const onState = service.engine.onState;
  service.engine.onState = value => { notifications++; onState(value); };
  const getState = service.getState.bind(service);
  service.getState = () => { snapshots++; return getState(); };
  const timers = new Map(), states = [];
  service.statePublisher.close();
  service.statePublisher = new StatePublisher({ publish: () => service.emit('state', service.getState()), now: () => time,
    setTimer: callback => { const timer = { unref() {} }; timers.set(timer, callback); return timer; },
    clearTimer: timer => timers.delete(timer) });
  service.on('state', value => states.push(value));
  const flush = () => { time += 200; for (const [timer, callback] of [...timers]) if (timers.delete(timer)) callback(); };
  try {
    await service.syncBounties();
    assert.equal(service.claimOutpoints.size, 3000);
    assert.equal(service.engine.queue.size, 30);
    assert.equal(notifications, 3, 'initial pool suspension, reset and thirty new queue entries; no notifications for 2,970 absent spent entries');
    assert.equal(snapshots, 1, 'snapshot construction is coalesced before serialization');
    assert.equal(timers.size, 1);
    flush();
    assert.equal(snapshots, 2);
    assert.equal(states.at(-1).claims.queued, 30);
    assert.equal(states.at(-1).claims.scanning, false);
    const reads = f.calls.filter(call => call.method === 'getblockbounties').length;
    for (let i = 0; i < 20; i++) await service.syncBounties();
    assert.equal(notifications, 3, 'repeated cached scans neither remove absent entries nor re-enqueue unchanged entries');
    assert.equal(service.engine.queue.size, 30);
    assert.equal(f.calls.filter(call => call.method === 'getblockbounties').length, reads);
    assert.equal(snapshots, 2);
    assert.equal(timers.size, 1);
    flush();
    assert.equal(snapshots, 3);
    assert.equal(states.at(-1).claims.queued, 30);
    assert.equal(states.at(-1).claims.scanning, false);
    assert.ok(kicks >= 21, 'unchanged scans still allow waiting claim work to resume');
  } finally {
    service.statePublisher.close();
    await service.engine.stop();
  }
});

function serviceFixture() {
  const account = deriveAccount('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  account.privateKey.fill(0);
  const funding = { version: 2, locktime: 0, inputs: [{ txid: hash(999), vout: 0, sequence: 0xffffffff, scriptSig: '', witness: [] }], outputs: [{ type: 2, amount: '1000000000', domain: 'example.com', target: 'f'.repeat(64), rootVersion: 1, mask: 7 }] };
  const raw = serializeTransaction(funding).toString('hex');
  const bounty = row(1, { txid: transactionId(funding) });
  const service = new WalletService({ directory: '/unused-unit-test' });
  service.config = structuredClone(DEFAULT_CONFIG);
  service.session = { data: {} }; service.epoch = 7;
  // This fixture is memory-only. Real durable safety stops are exercised by
  // claims-preferences.test.mjs using an isolated temporary profile.
  service.queueSettings = async operation => operation();
  service.applyConfig = async input => { Object.assign(service.config.claims, input.claims); };
  service.tip = tip(1);
  service.engine = { enabled: true, stopped: 0, async stop() { this.enabled = false; this.stopped++; } };
  service.claimBlocks.set(hash(2), [bounty]); service.claimOutpoints = new Map([[`${bounty.txid}:0`, bounty]]);
  service.getState = () => ({ wallet: { address: account.address } });
  service.emitState = () => {};
  service.funding = async () => raw;
  service.rpc = { async request(method) { if (method === 'getchaintip') return tip(1); throw new Error('unexpected request'); } };
  return { service, bounty };
}
function structuralProof(prepared) {
  // Only submit/cancellation is under test; full TLS authentication is tested by
  // the offline Python helper suite, and is mandatory before this method runs.
  const hello = Buffer.concat([Buffer.from('010000220303', 'hex'), Buffer.from(prepared.challenge, 'hex')]);
  return Buffer.concat([Buffer.from([2]), hello, ...[2, 8, 11, 15].map(type => Buffer.from([type, 0, 0, 0]))]).toString('hex');
}

test('prepared claims bind a spending txid and reject RPC metadata differing from funding bytes', async () => {
  const { service, bounty } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  assert.notEqual(prepared.context.txid, bounty.txid);
  assert.equal(prepared.context.txid, prepared.txid);
  assert.equal(prepared.context.validation_time, tip(1).mediantime);
  service.claimOutpoints.get(`${bounty.txid}:0`).domain = 'attacker.example';
  await assert.rejects(service.prepareAutomaticClaim(bounty), /domain differs/);
});

test('lock during funding lookup aborts claim preparation before opening any TLS connection', async () => {
  const { service, bounty } = serviceFixture();
  const funding = service.funding;
  service.funding = async () => { service.epoch++; service.session = null; return funding(); };
  await assert.rejects(service.prepareAutomaticClaim(bounty), /locked|changed/i);
});

test('unknown broadcast outcomes stop claims without awaiting the running engine itself', async () => {
  const { service, bounty } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  service.rpc.request = async method => { if (method === 'getchaintip') return tip(1); throw new Error('connection lost'); };
  await assert.rejects(service.submitAutomaticClaim(prepared, structuralProof(prepared)), /broadcast was not confirmed/);
  await Promise.resolve();
  assert.equal(service.engine.enabled, false);
  assert.equal(service.reserved.has(`${bounty.txid}:0`), true);
  assert.match(service.error, new RegExp(prepared.txid));
});

test('an explicit consensus rejection does not masquerade as an unknown broadcast', async () => {
  const { service, bounty } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  service.rpc.request = async method => { if (method === 'getchaintip') return tip(1); throw Object.assign(new Error('node rejected'), { code: -32020, data: { node_code: -26 } }); };
  await assert.rejects(service.submitAutomaticClaim(prepared, structuralProof(prepared)), /node rejected/i);
  assert.equal(service.engine.enabled, true);
  assert.equal(service.reserved.has(`${bounty.txid}:0`), false);
});

test('unrecognized or uncertain node rejection replies keep reservations and stop claims', async () => {
  const errors = [
    ...[-27, -99, undefined, '-26'].map(node_code => ({ code: -32020, data: { node_code } })),
    { code: -32020, data: { node_code: -26 }, unknownOutcome: true },
  ];
  for (const fields of errors) {
    const { service, bounty } = serviceFixture();
    const prepared = await service.prepareAutomaticClaim(bounty);
    service.rpc.request = async () => { throw Object.assign(new Error('node reply'), fields); };
    await assert.rejects(service.submitAutomaticClaim(prepared, structuralProof(prepared)), error =>
      error.unknownOutcome === true && /broadcast was not confirmed/.test(error.message));
    await Promise.resolve();
    assert.equal(service.engine.enabled, false);
    assert.equal(service.reserved.has(`${bounty.txid}:0`), true);
    assert.match(service.error, /broadcast was not confirmed/);
  }
});

test('late responses from a replaced wallet cannot stop or unreserve the new wallet', async () => {
  const { service, bounty } = serviceFixture();
  const prepared = await service.prepareAutomaticClaim(bounty);
  service.rpc.request = async method => {
    if (method === 'getchaintip') return tip(1);
    service.epoch++;
    service.walletGeneration++;
    throw new Error('old connection closed after locking');
  };
  await assert.rejects(service.submitAutomaticClaim(prepared, structuralProof(prepared)), /broadcast was not confirmed/);
  await Promise.resolve();
  assert.equal(service.engine.enabled, true);
  assert.equal(service.error, null);
  assert.equal(service.reserved.has(`${bounty.txid}:0`), true);
});
