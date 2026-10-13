import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WalletService } from '../src/core/wallet-service.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';

const hash = value => value.toString(16).padStart(64, '0');
const initialTip = { chain: 'testnet4', genesis_hash: GENESIS.testnet4, height: 1000, hash: hash(1000), mediantime: 1800000000 };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate) {
  for (let pass = 0; pass < 1000; pass++) {
    if (predicate()) return;
    await delay(1);
  }
  assert.fail('The isolated wallet race did not settle.');
}

class Backend extends EventEmitter {
  constructor() {
    super(); this.socket = null; this.generation = 0; this.subscriptions = new Map(); this.calls = [];
    this.tip = initialTip; this.amount = '10000000000'; this.transaction = hash(1); this.blockHeight = 900;
  }
  async connect() {
    if (!this.socket) { this.socket = {}; this.generation++; this.emit('connected'); }
    return this.socket;
  }
  async request(method, params = {}) {
    await this.connect(); this.calls.push({ method, params });
    if (method.startsWith('subscribe')) {
      const kind = { subscribetip: 'tip', subscribebounties: 'bounties', subscribeaddress: 'address' }[method];
      assert.ok(kind);
      if (kind === 'address') assert.equal(params.changes_only, true);
      const subscription = { kind, address: params.address, subscription_id: `${this.generation}-${method}-${params.address ?? ''}` };
      this.subscriptions.set(`${kind}:${params.address ?? ''}`, subscription);
      return { ...subscription, tip: this.tip, cursor: 'fixture-cursor', ...(kind === 'address' ? { changes_only: true } : {}) };
    }
    if (method === 'getchaintip') return { ...this.tip };
    if (method === 'getaddresschanges') throw Object.assign(new Error('Legacy address data fixture'), { code: -32601 });
    if (method === 'getaddressbalance') return { tip: this.tip, address: params.address, unit: 'connects',
      confirmed: this.amount, available_confirmed: this.amount, pending_delta: '0', immature: '0' };
    if (method === 'getaddresshistory' || method === 'getaddressutxos') {
      if (method === 'getaddresshistory') await this.beforeHistory?.();
      const location = { txid: this.transaction, status: 'confirmed', block_height: this.blockHeight,
        block_hash: hash(this.blockHeight), confirmations: this.tip.height - this.blockHeight + 1 };
      const row = method === 'getaddresshistory' ? { ...location, balance_delta: this.amount, received: this.amount, spent: '0' }
        : { ...location, vout: 0, amount: this.amount, coinbase: false, mature: true, pending_spent_by: null };
      return { tip: this.tip, address: params.address, unit: 'connects', items: this.amount === '0' ? [] : [row], next_cursor: null };
    }
    assert.fail(`Unexpected isolated RPC: ${method}`);
  }
  notice(tip, { reorg = false } = {}) {
    const subscription = this.subscriptions.get('tip:');
    assert.ok(subscription, 'Tip subscription must be installed before a notification');
    this.tip = tip;
    this.emit('notification', { ...subscription, tip, reorg });
  }
  disconnect() { this.socket = null; this.subscriptions.clear(); this.emit('disconnected'); }
  close() { this.socket = null; this.subscriptions.clear(); }
}

async function settled(service) {
  await until(() => !service.refreshing && !service.liveUpdates.running && !service.liveUpdates.requested &&
    !service.liveUpdates.addressPending && !service.liveUpdates.addressTimer &&
    [service.walletUpdates, service.bountyUpdates].every(queue => !queue.running && !queue.timer && !queue.dirty));
}

async function fixture(t) {
  const rpc = new Backend(), releases = [];
  // No vault, filesystem mutation, real key material, proof helper or network.
  // Exercise the actual subscriptions, queues, pages and wallet publication.
  const service = new WalletService({ directory: process.cwd(), network: 'testnet4', clientFactory: () => rpc });
  service.config = { ...structuredClone(DEFAULT_CONFIG), network: 'testnet4' };
  service.config.claims.enabled = false;
  service.session = { data: { name: 'Tip race fixture', receiveIndex: 0, changeIndex: 0,
    lastUsedReceive: 0, lastUsedChange: -1, needsRecovery: false } };
  service.accounts = [{ address: 'syntheticaddress1', change: 0, index: 0 }];
  service.engine = { enabled: false, suspends: 0, async stop() {}, async suspend() { this.suspends++; } };
  service.persist = async () => {};
  service.buildAccounts = async () => {};
  service.connectClient();
  service.walletUpdates.delayMs = 0; service.bountyUpdates.delayMs = 0;
  t.after(() => {
    releases.forEach(release => release());
    service.closed = true; service.session = null; service.epoch++;
    service.stopLiveUpdates(); rpc.close(); service.statePublisher.close();
  });
  service.liveUpdates.start(); await service.refresh(); await settled(service);
  assert.equal(service.getState().history[0].confirmations, 101);
  return { service, rpc, releases };
}

test('reconnect tip cannot project old-chain history while wallet revalidation is held', async t => {
  const { service, rpc, releases } = await fixture(t);
  const entered = deferred(), release = deferred(); releases.push(release.resolve);
  rpc.beforeHistory = () => { entered.resolve(); return release.promise; };
  const revision = service.walletChainRevision;
  rpc.disconnect();
  assert.equal(service.walletChainRevision, revision + 1);
  // The old transaction was orphaned while the connection was offline.
  rpc.amount = '0'; rpc.tip = { ...initialTip, height: 1002, hash: hash(9002) };
  await rpc.connect(); await entered.promise;
  rpc.notice(rpc.tip);
  assert.equal(service.getState().network.height, 1002);
  assert.equal(service.confirmationsStale, true);
  assert.equal(service.getState().history[0].confirmations, 101, 'No 103-confirmation projection of unvalidated old-chain rows');
  release.resolve(); await settled(service);
  assert.equal(service.confirmationsStale, false);
  assert.deepEqual(service.getState().history, []);
  assert.equal(service.balance.confirmed, '0');
});

test('duplicate replacement and advancing new-branch tips do not invalidate a held rollback baseline', async t => {
  const { service, rpc, releases } = await fixture(t);
  const entered = deferred(), release = deferred(); releases.push(release.resolve);
  rpc.beforeHistory = () => { entered.resolve(); return release.promise; };
  const rollback = { ...initialTip, height: 990, hash: hash(9990) };
  rpc.notice(rollback, { reorg: true }); await entered.promise;
  const revision = service.walletChainRevision, suspends = service.engine.suspends;
  rpc.notice(rollback);
  rpc.notice({ ...rollback, height: 991, hash: hash(9991) });
  assert.equal(service.walletChainRevision, revision);
  assert.equal(service.engine.suspends, suspends);
  assert.equal(service.confirmationsStale, true);
  assert.equal(service.getState().network.height, 991);
  assert.equal(service.getState().history[0].confirmations, 101);
  const reads = rpc.calls.filter(call => call.method === 'getaddresshistory').length;
  release.resolve(); await settled(service);
  assert.equal(service.walletChainRevision, revision);
  assert.equal(service.confirmationsStale, false);
  assert.equal(service.getState().history[0].confirmations, 92);
  assert.equal(rpc.calls.filter(call => call.method === 'getaddresshistory').length, reads, 'The held new-branch baseline completes once');
});

test('reorg during legacy persistence cannot publish the abandoned wallet snapshot', async t => {
  const { service, rpc, releases } = await fixture(t);
  const entered = deferred(), release = deferred(), revalidationEntered = deferred(), revalidationRelease = deferred();
  releases.push(release.resolve, revalidationRelease.resolve);
  const balance = service.balance, history = service.history, utxos = service.utxos;
  // Simulate a newly discovered used account so the legacy refresh persists its
  // derivation metadata after reading the candidate, before publication.
  service.session.data.lastUsedReceive = -1;
  service.persist = () => { entered.resolve(); return release.promise; };
  rpc.amount = '20000000000'; rpc.transaction = hash(2);
  rpc.tip = { ...initialTip, height: 1001, hash: hash(1001) };
  const pending = service.refresh();
  const rejected = assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
  await entered.promise;
  assert.equal(service.balance, balance); assert.equal(service.history, history); assert.equal(service.utxos, utxos);
  rpc.beforeHistory = () => { revalidationEntered.resolve(); return revalidationRelease.promise; };
  rpc.amount = '0';
  rpc.notice({ ...rpc.tip, hash: hash(9101) }, { reorg: true });
  release.resolve(); await rejected; await revalidationEntered.promise;
  assert.equal(service.balance, balance); assert.equal(service.history, history); assert.equal(service.utxos, utxos);
  assert.equal(service.getState().wallet.balance.confirmed, '1', 'The rejected two-coin snapshot must never be published');
  assert.equal(service.confirmationsStale, true);
  revalidationRelease.resolve(); await settled(service);
  assert.equal(service.balance.confirmed, '0'); assert.deepEqual(service.history, []);
  assert.equal(service.confirmationsStale, false);
});
