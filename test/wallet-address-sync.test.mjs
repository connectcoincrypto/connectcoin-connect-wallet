import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WalletService } from '../src/core/wallet-service.mjs';
import { GENESIS } from '../src/core/config.mjs';
import { RpcClient } from '../src/core/rpc.mjs';

const hash = i => i.toString(16).padStart(64, '0');
const initialTip = { chain: 'testnet4', height: 999, hash: hash(999), mediantime: 1789500000, genesis_hash: GENESIS.testnet4 };
const row = i => ({ txid: hash(i), status: 'confirmed', block_height: 998, block_hash: hash(998), confirmations: 2, received: '1', spent: '0', balance_delta: '1' });
const coin = (extra = {}) => ({ txid: hash(1), vout: 0, amount: '201', block_height: 998, status: 'confirmed', confirmations: 2, coinbase: false, mature: true, pending_spent_by: null, ...extra });
class Backend extends EventEmitter {
  constructor() { super(); this.socket = {}; this.tip = initialTip; this.calls = []; this.serial = 0; this.legacy = false; }
  async connect() { return this.socket; }
  async request(method, params = {}, options = {}) {
    this.calls.push({ method, params, options });
    if (method === 'getaddresschanges') {
      if (this.legacy) throw Object.assign(new Error('Method not found'), { code: -32601 });
      return await this.delta?.(params) ?? { tip: this.tip, unit: 'connects', changes: [], next_cursor: `journal-${++this.serial}`, has_more: false, through_sequence: 0, journal_epoch: 1 };
    }
    if (['subscribetip', 'subscribebounties', 'subscribeaddress'].includes(method)) return { subscription_id: `${method}-${params.address ?? 'global'}`, tip: this.tip, cursor: 'journal-start', ...(method === 'subscribeaddress' ? { changes_only: true } : {}) };
    if (method === 'getchaintip') return this.tip;
    if (method === 'getaddresshistory') {
      await this.beforeHistory?.(params, options);
      const start = params.cursor ? Number(params.cursor) : 0, rows = params.address === this.used ? Array.from({ length: 201 }, (_, i) => row(i + 1)) : [];
      return { tip: this.tip, unit: 'connects', address: params.address, items: rows.slice(start, start + 100), next_cursor: start + 100 < rows.length ? String(start + 100) : null };
    }
    if (method === 'getaddressutxos') return { tip: this.tip, unit: 'connects', address: params.address, items: params.address === this.used ? [coin()] : [], next_cursor: null };
    if (method === 'getaddressbalance') return { tip: this.tip, unit: 'connects', address: params.address, confirmed: params.address === this.used ? '201' : '0', available_confirmed: params.address === this.used ? '201' : '0', immature: '0', pending_delta: '0' };
    throw new Error(`Unexpected isolated RPC ${method}`);
  }
  close() { this.socket = null; }
}
async function fixture(t, { legacy = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-address-sync-'));
  const rpc = new Backend(); rpc.legacy = legacy;
  const service = new WalletService({ directory, network: 'testnet4', clientFactory: () => rpc, proofRunner: async () => '020100' });
  await service.initialize(); clearInterval(service.timer); service.config.claims.enabled = false;
  service.persist = async () => {};
  service.session = { password: 'public-fixture-only', data: { name: 'Incremental fixture', mnemonic: `${'abandon '.repeat(11)}about`, network: 'testnet4', passphrase: '',
    receiveIndex: 1, changeIndex: 0, lastUsedReceive: 0, lastUsedChange: -1, needsRecovery: false, scanLookahead: true } };
  await service.buildAccounts(); rpc.used = service.accounts[0].address;
  t.after(async () => { await service.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('connectwallet-address-sync-')); await rm(directory, { recursive: true, force: true }); });
  return { service, rpc };
}
const counts = rpc => Object.fromEntries([...new Set(rpc.calls.map(c => c.method))].map(method => [method, rpc.calls.filter(c => c.method === method).length]));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function settled(service) {
  for (let pass = 0; pass < 800; pass++) {
    const live = service.liveUpdates;
    if (!service.refreshing && !live.running && !live.requested && !live.addressPending && !live.addressTimer && [service.walletUpdates, service.bountyUpdates].every(q => !q.running && !q.timer && !q.dirty)) return;
    await sleep(5);
  }
  assert.fail('Isolated synchronization did not settle');
}

test('201-row/41-address wallet handles 100 new tips locally; only an address push fetches a delta', async t => {
  const { service, rpc } = await fixture(t);
  service.liveUpdates.start(); await service.refresh(); await settled(service);
  assert.equal(counts(rpc).getaddresshistory, 43);
  assert.equal(counts(rpc).getaddresschanges, 2);
  assert.equal(counts(rpc).getaddressbalance, undefined);
  assert.ok(rpc.calls.filter(c => c.method === 'getaddressutxos').every(c => c.params.include_pending_spent === true));
  assert.equal(service.history.length, 201);
  assert.equal(service.balance.confirmed, '0.0000000201');
  const startupMethods = rpc.calls.filter(c => !c.method.startsWith('subscribe')).map(c => c.method);
  assert.ok(startupMethods.indexOf('getaddresschanges') < startupMethods.indexOf('getaddresshistory'));
  const cache = service.addressSync, balance = service.balance, utxos = service.utxos;
  for (let index = 0; index < 100; index++) {
    rpc.calls = []; rpc.tip = { ...rpc.tip, height: rpc.tip.height + 1, hash: hash(rpc.tip.height + 1) };
    const sub = service.liveUpdates.registrations.get('tip');
    rpc.emit('notification', { subscription_id: sub.id, kind: 'tip', tip: rpc.tip, reorg: false });
    await settled(service);
    assert.deepEqual(counts(rpc), {});
    assert.equal(service.getState().history[0].confirmations, 3 + index);
    assert.equal(service.getState().network.height, rpc.tip.height);
    assert.equal(service.addressSync, cache); assert.equal(service.addressSync.tip.height, 999);
    assert.equal(service.balance, balance); assert.equal(service.utxos, utxos);
  }
  for (const kind of ['address']) {
    rpc.calls = []; rpc.tip = { ...rpc.tip, height: rpc.tip.height + 1, hash: hash(rpc.tip.height + 1) };
    const sub = service.liveUpdates.registrations.get(kind === 'tip' ? 'tip' : `address:${rpc.used}`);
    rpc.emit('notification', { subscription_id: sub.id, kind, tip: rpc.tip, ...(kind === 'address' ? { address: rpc.used, refresh: true } : {}) });
    await settled(service);
    assert.deepEqual(counts(rpc), { getaddresschanges: 1 });
    assert.equal(service.history.length, 201);
  }
});

test('pending transactions remain unconfirmed on a tip push and legacy data reads are not repeated', async t => {
  const { service, rpc } = await fixture(t, { legacy: true });
  service.liveUpdates.start(); await service.refresh(); await settled(service);
  service.history.push({ txid: hash(2001), status: 'pending', blockHeight: null, confirmations: 0, amount: '1' });
  const balance = service.balance;
  rpc.calls = []; rpc.tip = { ...rpc.tip, height: 1000, hash: hash(1000) };
  const sub = service.liveUpdates.registrations.get('tip');
  rpc.emit('notification', { subscription_id: sub.id, kind: 'tip', tip: rpc.tip });
  await settled(service);
  assert.deepEqual(counts(rpc), {});
  assert.equal(service.getState().history[0].confirmations, 3);
  assert.equal(service.getState().history.at(-1).confirmations, 0);
  assert.equal(service.getState().history.at(-1).status, 'pending');
  assert.equal(service.balance, balance);
});

test('a tip arriving during a delta read updates display without invalidating its cursor or queuing another read', async t => {
  const { service, rpc } = await fixture(t);
  service.liveUpdates.start(); await service.refresh(); await settled(service);
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  rpc.delta = async () => {
    const result = { tip: rpc.tip, unit: 'connects', changes: [], next_cursor: 'held-cursor', has_more: false, through_sequence: 0, journal_epoch: 1 };
    entered.resolve(); await release.promise; return result;
  };
  rpc.calls = [];
  const pending = service.refresh(); await entered.promise;
  rpc.tip = { ...rpc.tip, height: 1000, hash: hash(1000) };
  rpc.emit('notification', { subscription_id: service.liveUpdates.registrations.get('tip').id, kind: 'tip', tip: rpc.tip });
  assert.equal(service.getState().history[0].confirmations, 3);
  release.resolve(); await pending; await settled(service);
  assert.deepEqual(counts(rpc), { getaddresschanges: 1 });
  assert.equal(service.addressSync.tip.height, 999);
  assert.equal(service.addressSync.batches[0].cursor, 'held-cursor');
  assert.equal(service.getState().history[0].confirmations, 3);
  assert.equal(service.getState().network.height, 1000);
});

test('same-height replacement or rollback triggers revalidation even without a reorg flag', async t => {
  const { service, rpc } = await fixture(t);
  service.liveUpdates.start(); await service.refresh(); await settled(service);
  for (const next of [{ ...rpc.tip, hash: hash(9000) }, { ...rpc.tip, height: 998, hash: hash(998) }]) {
    rpc.calls = []; rpc.tip = next;
    rpc.emit('notification', { subscription_id: service.liveUpdates.registrations.get('tip').id, kind: 'tip', tip: rpc.tip });
    await settled(service);
    assert.equal(counts(rpc).getaddresshistory, 43);
    assert.equal(service.getState().history[0].confirmations, rpc.tip.height - 998 + 1);
    assert.equal(service.confirmationsStale, false);
  }
});

test('a reorg rejects an already-running old-chain delta instead of publishing it after the reset', async t => {
  const { service, rpc } = await fixture(t);
  service.liveUpdates.start(); await service.refresh(); await settled(service);
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  rpc.delta = async () => {
    rpc.delta = null;
    const result = { tip: rpc.tip, unit: 'connects', changes: [], next_cursor: 'obsolete', has_more: false, through_sequence: 0, journal_epoch: 1 };
    entered.resolve(); await release.promise; return result;
  };
  const pending = service.refresh();
  const rejected = assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
  await entered.promise;
  rpc.tip = { ...rpc.tip, hash: hash(9001) };
  rpc.emit('notification', { subscription_id: service.liveUpdates.registrations.get('tip').id, kind: 'tip', tip: rpc.tip, reorg: true });
  release.resolve(); await rejected; await settled(service);
  assert.notEqual(service.addressSync.batches[0].cursor, 'obsolete');
  assert.equal(service.addressSync.tip.hash, hash(9001));
});

test('baseline race is closed by journal replay before first publication', async t => {
  const { service, rpc } = await fixture(t);
  let watermark = false;
  rpc.delta = params => {
    if (!params.cursor) { watermark = true; return { tip: rpc.tip, unit: 'connects', changes: [], next_cursor: 'watermark', has_more: false, through_sequence: 0, journal_epoch: 1 }; }
    return { tip: rpc.tip, unit: 'connects', changes: [{ sequence: 1, address: rpc.used, kind: 'utxo', action: 'upsert', txid: hash(1), vout: 0, item: coin({ pending_spent_by: hash(9999) }) }], next_cursor: 'caught-up', has_more: false, through_sequence: 1, journal_epoch: 1 };
  };
  rpc.beforeHistory = () => { assert.equal(watermark, true); assert.equal(service.balance, null); assert.equal(service.history.length, 0); };
  await service.refresh();
  assert.equal(service.utxos[0].pending_spent_by, hash(9999));
  assert.equal(service.balance.available, '0');
  assert.equal(service.balance.pending, '-0.0000000201');
  assert.equal(service.addressSync.batches[0].cursor, 'caught-up');
});

test('expired/reorg cursor causes bounded baseline resync and then returns to delta-only', async t => {
  const { service, rpc } = await fixture(t); await service.refresh(); rpc.calls = [];
  let stale = true;
  rpc.delta = params => { if (params.cursor && stale) { stale = false; throw Object.assign(new Error('expired'), { code: -32011 }); } };
  await service.refresh();
  assert.equal(counts(rpc).getaddresschanges, 3); assert.equal(counts(rpc).getaddresshistory, 43);
  rpc.calls = []; await service.refresh();
  assert.deepEqual(counts(rpc), { getaddresschanges: 1 });
});

test('address-set growth establishes a new watermark instead of reusing a bound cursor', async t => {
  const { service, rpc } = await fixture(t); await service.refresh(); rpc.calls = [];
  service.session.data.receiveIndex = 21; await service.buildAccounts();
  assert.equal(service.accounts.length, 42);
  await service.refresh();
  const calls = rpc.calls.filter(c => c.method === 'getaddresschanges');
  assert.equal(calls.length, 2); assert.equal(calls[0].params.cursor, undefined); assert.equal(calls[0].params.addresses.length, 42);
  assert.equal(counts(rpc).getaddresshistory, 44);
});

test('invalid delta cannot replace a published balance, history, or cursor', async t => {
  const { service, rpc } = await fixture(t); await service.refresh();
  const cache = service.addressSync, balance = service.balance, history = service.history;
  rpc.delta = () => ({ tip: rpc.tip, unit: 'connects', changes: [{ sequence: 1, address: 'foreignaddress', kind: 'history', action: 'remove', txid: hash(1) }], next_cursor: 'invalid', has_more: false, through_sequence: 1, journal_epoch: 1 });
  await assert.rejects(service.refresh(), /invalid address synchronization/);
  assert.equal(service.addressSync, cache); assert.equal(service.balance, balance); assert.equal(service.history, history);
});

test('method-not-found falls back once to legacy reads, while other failures do not downgrade', async t => {
  const { service, rpc } = await fixture(t, { legacy: true }); await service.refresh();
  assert.equal(service.addressChangesSupported, false); assert.equal(counts(rpc).getaddresschanges, 1);
  rpc.calls = []; await service.refresh(); assert.equal(counts(rpc).getaddresschanges, undefined); assert.equal(counts(rpc).getaddresshistory, 43);
  service.addressChangesSupported = undefined; rpc.legacy = false;
  rpc.delta = () => { throw Object.assign(new Error('limited'), { code: -32029 }); };
  await assert.rejects(service.refresh(), { code: -32029 }); assert.notEqual(service.addressChangesSupported, false);
});

test('locking discards all session cursors and cached address rows', async t => {
  const { service } = await fixture(t); await service.refresh(); assert.ok(service.addressSync);
  await service.lock(); assert.equal(service.addressSync, null); assert.equal(service.addressChangesSupported, undefined); assert.deepEqual(service.history, []);
});

test('multi-batch drift retries deltas from a private candidate without another baseline', async t => {
  const { service, rpc } = await fixture(t);
  service.accounts = Array.from({ length: 101 }, (_, index) => ({ address: `fixtureaddress${String(index).padStart(3, '0')}`, index, change: 0 }));
  let sequence = 0, stable = false;
  rpc.delta = params => ({ tip: rpc.tip, unit: 'connects', changes: [], next_cursor: `cursor-${++rpc.serial}`, has_more: false,
    through_sequence: params.cursor && !stable ? ++sequence : sequence, journal_epoch: 1 });
  await assert.rejects(service.refresh(), { code: 'ADDRESS_SYNC_BUSY' });
  assert.equal(counts(rpc).getaddresshistory, 101); assert.equal(service.addressSync, null); assert.ok(service.addressSyncPending); assert.equal(service.balance, null);
  stable = true; rpc.calls = [];
  await service.refresh();
  assert.equal(counts(rpc).getaddresshistory, undefined); assert.equal(counts(rpc).getaddressutxos, undefined); assert.equal(counts(rpc).getaddresschanges, 2);
  assert.ok(service.addressSync); assert.equal(service.addressSyncPending, null);
});

test('initial baseline pipelines at most four reads, preserving watermark, subscriptions and atomic publication', async t => {
  const { service, rpc } = await fixture(t);
  const request = rpc.request.bind(rpc);
  let active = 0, peak = 0, watermark = false;
  const subscribed = new Set();
  rpc.request = async (method, params = {}, options = {}) => {
    if (method === 'getaddresschanges' && !params.cursor) watermark = true;
    if (!['getaddresshistory', 'getaddressutxos'].includes(method)) return request(method, params, options);
    assert.equal(watermark, true);
    assert.ok(subscribed.has(params.address));
    assert.equal(service.balance, null); assert.equal(service.addressSync, null); assert.deepEqual(service.history, []);
    active++; peak = Math.max(peak, active);
    try { await sleep(2); return await request(method, params, options); }
    finally { active--; }
  };
  // Exercise the baseline's subscribe-before-read contract independently of
  // the shared LiveUpdates worker's own concurrency/capacity tests.
  service.liveUpdates.started = true;
  service.liveUpdates.updateAddresses = () => {};
  service.liveUpdates.watchAddress = async address => { await sleep(1); subscribed.add(address); };
  await service.refresh();
  assert.equal(peak, 4); assert.equal(active, 0);
  assert.equal(subscribed.size, 41);
  assert.equal(counts(rpc).getaddresshistory, 43); assert.equal(counts(rpc).getaddressutxos, 3);
  assert.equal(service.history.length, 201); assert.equal(service.balance.confirmed, '0.0000000201');
  rpc.calls = []; await service.refresh();
  assert.deepEqual(counts(rpc), { getaddresschanges: 1 });
});

test('failed baseline stops scheduling siblings and drains sent reads before returning the original failure', async t => {
  const { service, rpc } = await fixture(t);
  const ready = deferred(), replies = Array.from({ length: 4 }, deferred);
  let entered = 0, finished = false;
  rpc.beforeHistory = async () => {
    const index = entered++;
    assert.ok(index < 4, 'No new page/address may start after the failure');
    if (entered === 4) ready.resolve();
    await replies[index].promise;
  };
  const failure = Object.assign(new Error('limited fixture'), { code: -32029 });
  const refresh = service.refresh();
  const rejected = assert.rejects(refresh, error => error === failure).then(() => { finished = true; });
  await ready.promise;
  replies[0].reject(failure);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'Already-sent replies must be observed before retry');
  assert.ok(rpc.calls.filter(c => c.method === 'getaddresshistory').every(c => c.options.signal.aborted));
  for (const reply of replies.slice(1)) reply.resolve();
  await rejected;
  assert.equal(counts(rpc).getaddresshistory, 4); assert.equal(counts(rpc).getaddressutxos, undefined);
  assert.equal(counts(rpc).getaddresschanges, 1, 'Never replay/publish an incomplete baseline');
  assert.equal(service.addressSync, null); assert.equal(service.balance, null); assert.deepEqual(service.history, []);
  rpc.calls = []; rpc.beforeHistory = null;
  await service.refresh();
  assert.equal(counts(rpc).getaddresshistory, 43); assert.equal(counts(rpc).getaddresschanges, 2);
  assert.equal(service.history.length, 201);
});

test('locking during four in-flight baseline reads discards every late result without scheduling more pages', async t => {
  const { service, rpc } = await fixture(t);
  const ready = deferred(), reply = deferred(); let entered = 0;
  rpc.beforeHistory = async () => { if (++entered === 4) ready.resolve(); await reply.promise; };
  const rejected = assert.rejects(service.refresh(), /Wallet locked or changed/);
  await ready.promise; await service.lock(); reply.resolve(); await rejected;
  assert.equal(entered, 4);
  assert.equal(counts(rpc).getaddressutxos, undefined); assert.equal(counts(rpc).getaddresschanges, 1);
  assert.equal(service.session, null); assert.equal(service.addressSync, null); assert.equal(service.balance, null); assert.deepEqual(service.history, []);
});

test('parallel baseline uses the shared TCP client pacing across multiple 48-request windows', async t => {
  const { service, rpc: backend } = await fixture(t);
  service.accounts.push(...Array.from({ length: 60 }, (_, index) => ({ address: `publicfixtureaddress${index}`, index: index + 100, change: 0 })));
  const sockets = new Set(), historyTimes = [], errors = [];
  let active = 0, peak = 0;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.setNoDelay(true); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8'); let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (request.method === 'getaddresshistory') historyTimes.push(performance.now());
        active++; peak = Math.max(peak, active);
        void (async () => {
          try {
            await sleep(2);
            const result = await backend.request(request.method, request.params);
            socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
          } catch (error) { errors.push(error); socket.destroy(); }
          finally { active--; }
        })();
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  // Same production quota, shortened window only to keep this regression fast.
  const client = new RpcClient({ host: '127.0.0.1', port: server.address().port, quota: 48, windowMs: 200, timeoutMs: 5000 });
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  service.clientFactory = () => client; service.connectClient();
  await service.refresh();
  assert.deepEqual(errors, []); assert.equal(active, 0); assert.equal(peak, 4);
  assert.equal(historyTimes.length, 103);
  for (let index = 48; index < historyTimes.length; index++) {
    assert.ok(historyTimes[index] - historyTimes[index - 48] >= 180, 'Baseline must wait for per-method quota instead of bypassing it');
  }
  assert.equal(client.queuedRequests, 0); assert.equal(client.pending.size, 0);
  assert.equal(service.history.length, 201); assert.equal(service.balance.confirmed, '0.0000000201');
  backend.calls = []; await service.refresh();
  assert.deepEqual(counts(backend), { getaddresschanges: 2 });
});

test('validated address responses establish the network without a separate tip preflight', async t => {
  const { service, rpc } = await fixture(t);
  const request = rpc.request.bind(rpc);
  rpc.request = (method, ...args) => {
    assert.notEqual(method, 'getchaintip');
    return request(method, ...args);
  };
  await service.refresh();
  assert.equal(service.network.status, 'online');
  assert.equal(service.tip.hash, initialTip.hash);
  rpc.calls = []; await service.refresh();
  assert.deepEqual(counts(rpc), { getaddresschanges: 1 });
});

test('empty same-tip deltas advance cursors without rebuilding the published projection', async t => {
  const { service, rpc } = await fixture(t); await service.refresh();
  const cache = service.addressSync, balance = service.balance, history = service.history, utxos = service.utxos;
  rpc.calls = [];
  await service.refresh();
  assert.notEqual(service.addressSync.batches[0].cursor, cache.batches[0].cursor);
  assert.equal(service.addressSync.addresses, cache.addresses);
  assert.equal(service.balance, balance); assert.equal(service.history, history); assert.equal(service.utxos, utxos);
  assert.deepEqual(counts(rpc), { getaddresschanges: 1 });
});

test('empty deltas at a newer tip still recalculate coinbase maturity and confirmations', async t => {
  const { service, rpc } = await fixture(t);
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, params, options) => {
    const response = await request(method, params, options);
    if (method === 'getaddressutxos') response.items = response.items.map(item => ({ ...item, coinbase: true, mature: false, block_height: 901, confirmations: 99 }));
    return response;
  };
  await service.refresh();
  const previous = service.balance, rows = service.addressSync.addresses;
  assert.equal(service.balance.available, '0');
  assert.equal(service.balance.immature, '0.0000000201');
  rpc.tip = { ...rpc.tip, height: 1000, hash: hash(1000) };
  rpc.calls = []; await service.refresh();
  assert.equal(service.addressSync.addresses, rows);
  assert.notEqual(service.balance, previous);
  assert.equal(service.balance.available, '0.0000000201');
  assert.equal(service.balance.immature, '0');
  assert.equal(service.utxos[0].confirmations, 100);
  assert.equal(service.utxos[0].mature, true);
  assert.deepEqual(counts(rpc), { getaddresschanges: 1 });
});

test('validated duplicate rows advance the journal without rebuilding unchanged funds or history', async t => {
  const { service, rpc } = await fixture(t); await service.refresh();
  const cache = service.addressSync, balance = service.balance, history = service.history, utxos = service.utxos;
  rpc.delta = () => ({ tip: rpc.tip, unit: 'connects', changes: [
    { sequence: 1, address: rpc.used, kind: 'history', action: 'upsert', txid: hash(1), item: row(1) },
    { sequence: 2, address: rpc.used, kind: 'utxo', action: 'upsert', txid: hash(1), vout: 0, item: coin() },
    { sequence: 3, address: rpc.used, kind: 'utxo', action: 'remove', txid: hash(700), vout: 0 },
  ], next_cursor: 'duplicate-rows-3', has_more: false, through_sequence: 3, journal_epoch: 1 });
  await service.refresh();
  assert.equal(service.addressSync.addresses, cache.addresses);
  assert.equal(service.balance, balance); assert.equal(service.history, history); assert.equal(service.utxos, utxos);
  assert.equal(service.addressSync.batches[0].throughSequence, 3);
  assert.equal(service.addressSync.batches[0].cursor, 'duplicate-rows-3');
  rpc.delta = () => ({ tip: rpc.tip, unit: 'connects', changes: [
    { sequence: 4, address: rpc.used, kind: 'utxo', action: 'upsert', txid: hash(1), vout: 0, item: coin({ pending_spent_by: hash(600) }) },
  ], next_cursor: 'real-change-4', has_more: false, through_sequence: 4, journal_epoch: 1 });
  await service.refresh();
  assert.notEqual(service.addressSync.addresses, cache.addresses);
  assert.notEqual(service.balance, balance); assert.equal(service.balance.available, '0');
});

test('invalid network in an empty delta cannot reuse or replace an existing projection', async t => {
  const { service, rpc } = await fixture(t); await service.refresh();
  const cache = service.addressSync, balance = service.balance, history = service.history;
  rpc.delta = () => ({ tip: { ...rpc.tip, chain: 'main' }, unit: 'connects', changes: [], next_cursor: 'foreign', has_more: false, through_sequence: 0, journal_epoch: 1 });
  await assert.rejects(service.refresh());
  assert.equal(service.addressSync, cache); assert.equal(service.balance, balance); assert.equal(service.history, history);
});

test('legacy monetary parsing preserves signed limits, lexical checks and exact formatting', async t => {
  const { service, rpc } = await fixture(t, { legacy: true });
  service.accounts = service.accounts.slice(0, 1);
  const request = rpc.request.bind(rpc); let sample = '0';
  rpc.request = async (method, params, options) => {
    const result = await request(method, params, options);
    if (method === 'getaddresshistory') return { ...result, items: [], next_cursor: null };
    return method === 'getaddressbalance' ? { ...result, pending_delta: sample } : result;
  };
  const originalAmount = value => {
    if (typeof value !== 'string' || !/^-?\d{1,19}$/.test(value) || BigInt(value) > 1000000000000000000n || BigInt(value) < -1000000000000000000n) throw new Error('invalid');
    return BigInt(value);
  };
  const display = value => {
    const sign = value < 0n ? '-' : '', absolute = value < 0n ? -value : value;
    const fraction = (absolute % 10000000000n).toString().padStart(10, '0').replace(/0+$/, '');
    return sign + (absolute / 10000000000n).toString() + (fraction ? '.' + fraction : '');
  };
  const samples = ['0', '-0', '0000000000000000000', '-0001', '10000000000', '-10000000000',
    '999999999999999999', '-999999999999999999', '1000000000000000000', '-1000000000000000000',
    // Preserve the existing regex semantics; this optimization is not a wire-format change.
    '1\n', undefined, null, 1, 1n, NaN, [], ['1'], {}, { toString: () => '1' },
    '', '-', '+1', '1.0', '1e2', ' 1', '1 ', '0x10', 'one', '１', '1\n2',
    '1000000000000000001', '-1000000000000000001', '00000000000000000000', '9999999999999999999'];
  for (let index = -40; index <= 40; index++) samples.push((BigInt(index) * 1234567890123456n).toString());
  for (sample of samples) {
    let expected;
    try { expected = originalAmount(sample); } catch { /* The same invalid input must still fail before publication. */ }
    if (expected !== undefined) {
      await service.refresh();
      assert.equal(service.balance.pending, display(expected));
    } else {
      const before = { balance: service.balance, history: service.history, utxos: service.utxos };
      await assert.rejects(service.refresh(), /invalid monetary amount/);
      assert.equal(service.balance, before.balance); assert.equal(service.history, before.history); assert.equal(service.utxos, before.utxos);
    }
  }
});

test('a real automatic delta refresh publishes notifications without building an unused return snapshot', async t => {
  const { service, rpc } = await fixture(t); await service.refresh();
  service.statePublisher.cancelPending();
  const getState = service.getState.bind(service), observed = [];
  let snapshots = 0;
  service.getState = () => { snapshots++; return getState(); };
  service.on('state', state => observed.push(state));
  service.walletUpdateRevision++; rpc.calls = [];
  await service.walletUpdates.run();
  assert.equal(service.walletReadRevision, service.walletUpdateRevision);
  assert.equal(service.refreshing, null);
  assert.deepEqual(counts(rpc), { getaddresschanges: 1 });
  assert.equal(snapshots, observed.length, 'all projections must correspond to a delivered state, not an ignored return');
  assert.equal(service.history.length, 201);
});
