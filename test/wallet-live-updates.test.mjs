import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { WalletService } from '../src/core/wallet-service.mjs';
import { GENESIS } from '../src/core/config.mjs';

const mnemonic = `${'abandon '.repeat(11)}about`;
const tip = { chain: 'testnet4', genesis_hash: GENESIS.testnet4, height: 0,
  hash: GENESIS.testnet4, mediantime: 1800000000 };
const data = () => ({ name: 'Live update fixture', mnemonic, network: 'testnet4', passphrase: '',
  receiveIndex: 0, changeIndex: 0, lastUsedReceive: -1, lastUsedChange: -1, needsRecovery: false });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(predicate, message = 'Mocked live updates did not settle') {
  for (let n = 0; n < 800; n++) { if (predicate()) return; await delay(5); }
  throw new Error(message);
}

class Backend extends EventEmitter {
  constructor() { super(); this.socket = null; this.calls = []; this.subscriptions = new Map(); this.generation = 0; this.sequence = 0; }
  async connect() {
    if (!this.socket) { this.socket = {}; this.generation++; this.emit('connected'); }
    return this.socket;
  }
  async request(method, params = {}, options = {}) {
    await this.connect();
    this.calls.push({ method, params });
    if (method.startsWith('subscribe')) {
      const kind = { subscribetip: 'tip', subscribebounties: 'bounties', subscribeaddress: 'address' }[method];
      assert.ok(kind, `Unexpected subscription ${method}`);
      const key = `${kind}:${params.address ?? ''}`;
      if (!this.subscriptions.has(key)) this.subscriptions.set(key, { kind, address: params.address,
        subscription_id: `sub-${this.generation}-${this.subscriptions.size}` });
      return { ...this.subscriptions.get(key), tip, cursor: 'journal-0' };
    }
    if (method === 'unsubscribe') {
      const entry = [...this.subscriptions].find(([, value]) => value.subscription_id === params.subscription_id);
      return { removed: Boolean(entry && this.subscriptions.delete(entry[0])) };
    }
    if (method === 'getchaintip') return tip;
    if (method === 'getaddressbalance') return { tip, address: params.address, unit: 'connects',
      confirmed: '0', available_confirmed: '0', immature: '0', pending_delta: '0' };
    if (['getaddresshistory', 'getaddressutxos'].includes(method)) return {
      tip, address: params.address, unit: 'connects', items: [], next_cursor: null,
    };
    if (method === 'getrecentblockhashes') return { tip, window: 600, blocks: [{ height: 0, hash: tip.hash }] };
    if (method === 'getbountychanges') {
      await this.beforeJournal?.();
      return { tip, changes: [], next_cursor: 'journal-0', has_more: false };
    }
    if (method === 'getblockbounties') {
      options.onChunk({ type: 'snapshot', tip, block_hash: params.block_hash, unit: 'connects', cursor: 'journal-0' });
      options.onChunk({ type: 'state', tip, cursor: 'journal-0' });
      return { records: 0, chunks: 2 };
    }
    throw new Error(`Unexpected isolated request ${method}`);
  }
  notice(kind, extra = {}) {
    const sub = [...this.subscriptions.values()].find(value => value.kind === kind && (!extra.address || value.address === extra.address));
    assert.ok(sub, `The wallet must subscribe to ${kind} before notifications can arrive`);
    const base = kind === 'address' ? { refresh: true, reorg: false } : kind === 'tip' ? { reorg: false } : {
      cursor: `journal-${++this.sequence}`, changes: [{ sequence: this.sequence, type: 'added',
        txid: 'a'.repeat(64), vout: 0, block_hash: tip.hash }],
    };
    this.emit('notification', { ...sub, tip, ...base, ...extra });
  }
  disconnect() { this.socket = null; this.subscriptions.clear(); this.emit('disconnected'); }
  close() { this.socket = null; this.subscriptions.clear(); }
}

function idleEngine() {
  return {
    enabled: false, suspends: 0, resumes: 0, stops: 0, queue: new Map(),
    async stop() { this.stops++; this.enabled = false; },
    async suspend() { this.suspends++; },
    start() { this.enabled = true; }, resume() { this.resumes++; }, clear() {},
    setOptions() {}, notify() {}, activeKeys() { return []; },
    hasActive() { return false; }, retainCatalog() {}, enqueue() {}, remove() {}, retire() {},
  };
}
async function settled(service) {
  await until(() => service.rpc.subscriptions.size === service.accounts.length + 2 &&
    !service.refreshing && !service.bountySync && !service.walletUpdates.timer && !service.walletUpdates.running &&
    !service.bountyUpdates.timer && !service.bountyUpdates.running);
}
async function fixture(t, { beforeOpen, waitForSettle = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-live-updates-test-'));
  const clients = [], releases = [];
  const service = new WalletService({ directory,
    clientFactory: () => { const client = new Backend(); clients.push(client); return client; },
    proofRunner: async () => { throw new Error('Live update tests must never perform TLS work'); },
  });
  t.after(async () => {
    for (const release of releases) release();
    await service.close();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('connectwallet-live-updates-test-'));
    await rm(absolute, { recursive: true, force: true });
  });
  await service.initialize();
  service.engine = idleEngine();
  service.persist = async () => {};
  await beforeOpen?.(service, releases);
  await service.openSession(data(), 'public-live-update-test-password');
  if (waitForSettle) await settled(service);
  return { service, clients, releases };
}

test('a bounty push schedules discovery without waiting for a blocked address refresh', async t => {
  const { service: s, releases } = await fixture(t);
  const gate = deferred(); releases.push(gate.resolve);
  let refreshing = false, scans = 0;
  s.refreshInternal = async () => { refreshing = true; await gate.promise; };
  s.engine.enabled = true;
  s.syncBounties = async () => { scans++; };
  s.rpc.notice('address');
  await until(() => refreshing);
  s.rpc.notice('bounties');
  await until(() => scans === 1, 'Bounty push was blocked behind the address refresh');
  assert.ok(s.refreshing, 'The address read must still be blocked when discovery runs');
  gate.resolve();
});

test('bounty push bursts coalesce and an event during discovery schedules a fresh follow-up', async t => {
  const { service: s, releases } = await fixture(t);
  const gate = deferred(); releases.push(gate.resolve);
  let scans = 0;
  s.engine.enabled = true;
  s.syncBounties = async () => { if (++scans === 1) await gate.promise; };
  for (let i = 0; i < 50; i++) s.rpc.notice('bounties');
  await until(() => scans === 1);
  for (let i = 0; i < 50; i++) s.rpc.notice('bounties');
  gate.resolve();
  await until(() => scans === 2);
  await delay(100);
  assert.equal(scans, 2, 'A burst must not become one snapshot request per event');
});

test('a reorg push invalidates an in-flight snapshot before it can resume claims', async t => {
  const { service: s, releases } = await fixture(t);
  const gate = deferred(); releases.push(gate.resolve);
  let waiting = false;
  s.rpc.beforeJournal = async () => {
    s.rpc.beforeJournal = null;
    waiting = true; await gate.promise;
  };
  s.engine.enabled = true;
  s.claimCursor = 'old-journal';
  const revision = s.claimRevision;
  const pending = s.syncBounties();
  const cancelled = assert.rejects(pending, error => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  await until(() => waiting);
  s.rpc.notice('bounties', { resync_required: true, changes: undefined });
  assert.ok(s.claimRevision > revision);
  assert.equal(s.claimCursor, null);
  assert.ok(s.engine.suspends > 0);
  assert.equal(s.engine.resumes, 0);
  gate.resolve(); await cancelled;
  await until(() => s.engine.resumes === 1, 'A fresh validated snapshot must recover after the reorg');
  assert.equal(s.claimCursor, 'journal-0');
});

test('disconnect reconnects and resubscribes, while lock rejects old pushes and reopening starts new watches', async t => {
  const { service: s } = await fixture(t);
  s.config.claims.enabled = true;
  s.engine.enabled = true;
  const rpc = s.rpc;
  const oldId = [...rpc.subscriptions.values()].find(sub => sub.kind === 'bounties').subscription_id;
  rpc.disconnect();
  assert.equal(s.engine.enabled, false);
  await until(() => rpc.calls.filter(call => call.method === 'subscribetip').length === 2);
  await settled(s);
  await until(() => s.engine.enabled, 'Saved claim intent must resume after subscription recovery');
  await s.lock();
  let scans = 0;
  const original = s.syncBounties.bind(s);
  s.syncBounties = async () => { scans++; return original(); };
  rpc.emit('notification', { subscription_id: oldId, kind: 'bounties', tip, resync_required: true, cursor: 'old' });
  await delay(70);
  assert.equal(scans, 0);
  assert.equal(s.session, null);
  assert.notEqual(s.rpc, rpc);
  assert.equal(s.rpc.calls.length, 0, 'Locked wallet must not reconnect or query');
  await s.openSession(data(), 'public-live-update-test-password');
  await settled(s);
  await until(() => s.engine.enabled);
  assert.ok(s.rpc.calls.some(call => call.method === 'subscribebounties'));
});

test('security housekeeping no longer polls at 20 seconds but still auto-locks', async t => {
  const timers = [], original = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (fn, interval, ...args) => {
    timers.push({ fn, interval });
    return original(fn, interval, ...args);
  });
  const { service: s } = await fixture(t);
  const housekeeping = timers.find(timer => timer.interval === 1000);
  assert.ok(housekeeping, 'Keep security housekeeping independent from RPC refresh');
  assert.ok(!timers.some(timer => timer.interval === 20000));
  let refreshes = 0;
  s.refresh = async () => { refreshes++; };
  const calls = s.rpc.calls.length, initial = s.lastActivity;
  let now = initial;
  t.mock.method(Date, 'now', () => now);
  for (let second = 1; second <= 30; second++) { now = initial + second * 1000; housekeeping.fn(); }
  assert.equal(refreshes, 0);
  assert.equal(s.rpc.calls.length, calls);
  now = initial + s.config.autoLockMinutes * 60000 + 1;
  housekeeping.fn();
  await until(() => !s.session);
  assert.equal(s.engine.enabled, false);
  assert.equal(refreshes, 0);
});

test('transient claim startup failures retry without another push or a periodic refresh', async t => {
  const { service: s } = await fixture(t);
  s.config.claims.enabled = true;
  s.bountyUpdates.delayMs = 0;
  s.bountyUpdates.retryMs = 5;
  s.bountyUpdates.maxRetryMs = 20;
  const original = s.rpc.request.bind(s.rpc);
  let tipAttempts = 0, notifications = 0;
  s.rpc.on('notification', () => { notifications++; });
  s.rpc.request = async (method, ...args) => {
    if (method === 'getchaintip' && ++tipAttempts <= 2) {
      throw Object.assign(new Error('Index is temporarily synchronizing'), { code: -32001 });
    }
    return original(method, ...args);
  };
  // Initial/direct startup schedules the first retry; failure within that event
  // queue must also retry instead of being swallowed as a successful idle pass.
  await s.resumeClaims();
  assert.equal(tipAttempts, 1);
  assert.equal(s.engine.enabled, false);
  assert.equal(s.claimsResumePending, true);
  await until(() => s.engine.enabled && s.engine.resumes === 1,
    'Transient startup failure left Automatic Claims idle without a new notification');
  assert.equal(tipAttempts, 3);
  assert.equal(notifications, 0);
  assert.equal(s.claimsResumePending, false);
  assert.equal(s.claimCursor, 'journal-0');
});

test('address subscription capacity warning survives refresh and clears after successful reconnection', async t => {
  const { service: s } = await fixture(t);
  const rpc = s.rpc, original = rpc.request.bind(rpc);
  let limited = true;
  rpc.request = async (method, params, options) => {
    if (limited && method === 'subscribeaddress' && !rpc.subscriptions.has(`address:${params.address}`)) {
      throw Object.assign(new Error('Subscription capacity reached'), { code: -32005 });
    }
    return original(method, params, options);
  };
  s.session.data.receiveIndex = 1;
  s.buildAccounts();
  const current = s.accounts.find(account => account.change === 0 && account.index === 1).address;
  assert.equal(s.liveUpdates.getAddresses()[0], current, 'Current receive address should have first subscription priority');
  await until(() => Boolean(s.liveUpdateWarning));
  const warning = s.getState().error;
  assert.match(warning, /subscription capacity/i);
  await s.refresh();
  assert.equal(s.error, null, 'The independent wallet refresh succeeds');
  assert.equal(s.getState().error, warning, 'Successful balance refresh must not hide missing live address watches');
  limited = false;
  rpc.disconnect();
  await until(() => rpc.calls.filter(call => call.method === 'subscribetip').length === 2);
  await settled(s);
  assert.equal(s.getState().error, null, 'Successful re-subscription must clear a stale capacity warning');
});

test('a same-tip address push during the initial read forces a fresh wallet pass', async t => {
  const gate = deferred();
  let held = false, target, reads = 0, arrived = false;
  const payment = { txid: 'b'.repeat(64), status: 'pending', block_height: null,
    confirmations: 0, received: '10000000000', spent: '0', balance_delta: '10000000000' };
  const { service: s } = await fixture(t, { waitForSettle: false, beforeOpen(service, releases) {
    releases.push(gate.resolve);
    const original = service.rpc.request.bind(service.rpc);
    service.rpc.request = async (method, params, options) => {
      const result = await original(method, params, options);
      if (method !== 'getaddresshistory') return result;
      target ??= params.address;
      if (params.address !== target) return result;
      reads++;
      if (reads === 1) { held = true; await gate.promise; return result; }
      return { ...result, items: arrived ? [payment] : [] };
    };
  } });
  await until(() => held);
  const originalHash = s.tip.hash;
  arrived = true;
  s.rpc.notice('address', { address: target });
  gate.resolve();
  await until(() => s.history.some(row => row.txid === payment.txid),
    'The same-tip payment push was lost while the initial history request was active');
  assert.ok(reads >= 2);
  assert.equal(s.tip.hash, originalHash, 'No new block is required to see the payment');
  const requests = s.rpc.calls;
  const subscription = requests.findIndex(call => call.method === 'subscribeaddress' && call.params.address === target);
  const history = requests.findIndex(call => call.method === 'getaddresshistory' && call.params.address === target);
  assert.ok(subscription >= 0 && subscription < history, 'Subscribe before reading to close the notification gap');
});

test('lookahead addresses discovered after a wallet pass are read by a follow-up without another push', async t => {
  const { service: s } = await fixture(t);
  s.session.data.scanLookahead = true;
  s.buildAccounts();
  await settled(s);
  const edge = s.accounts.find(account => account.change === 0 && account.index === 19).address;
  const original = s.rpc.request.bind(s.rpc);
  s.rpc.request = async (method, params, options) => {
    const result = await original(method, params, options);
    if (method === 'getaddresshistory' && params.address === edge) return { ...result, items: [{
      txid: 'c'.repeat(64), status: 'confirmed', block_height: 0, confirmations: 1,
      received: '10000000000', spent: '0', balance_delta: '10000000000',
    }] };
    return result;
  };
  const before = s.rpc.calls.length;
  await s.refresh();
  assert.equal(s.session.data.lastUsedReceive, 19);
  const expanded = s.accounts.find(account => account.change === 0 && account.index === 39).address;
  await until(() => s.rpc.calls.slice(before).some(call => call.method === 'getaddresshistory' && call.params.address === expanded),
    'Newly subscribed lookahead was never read after the current pass had already finished its address loop');
  const calls = s.rpc.calls.slice(before);
  assert.ok(calls.findIndex(call => call.method === 'subscribeaddress' && call.params.address === expanded) <
    calls.findIndex(call => call.method === 'getaddresshistory' && call.params.address === expanded));
});

test('disconnect during a held refresh forces another read after reconnect even at the same tip', async t => {
  const { service: s, releases } = await fixture(t);
  const rpc = s.rpc, gate = deferred(); releases.push(gate.resolve);
  const first = s.accounts[0].address, last = s.accounts.at(-1).address;
  let held = false, changedWhileDisconnected = false;
  const original = rpc.request.bind(rpc);
  rpc.request = async (method, params, options) => {
    const result = await original(method, params, options);
    if (method === 'getaddressbalance' && params.address === first && changedWhileDisconnected) {
      return { ...result, confirmed: '10000000000', available_confirmed: '10000000000' };
    }
    if (method === 'getaddressutxos' && params.address === last && !held) {
      held = true; await gate.promise;
    }
    return result;
  };
  const pending = s.refresh();
  await until(() => held);
  s.liveUpdates.retryDelay = 5;
  s.liveUpdates.retryMinMs = 5;
  rpc.disconnect();
  changedWhileDisconnected = true;
  await until(() => rpc.generation === 2 && rpc.subscriptions.size === s.accounts.length + 2);
  // Complete an old address snapshot only after the reconnect catch-up signal.
  // Its old revision must not acknowledge changes which happened in the gap.
  gate.resolve(); await pending;
  await until(() => s.balance?.confirmed === '1', 'Reconnect catch-up was incorrectly consumed by the stale held refresh');
  assert.equal(s.tip.hash, tip.hash);
});
