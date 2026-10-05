import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WalletService } from '../src/core/wallet-service.mjs';
import { GENESIS } from '../src/core/config.mjs';

const hash = i => i.toString(16).padStart(64, '0');
const initialTip = { chain: 'testnet4', height: 999, hash: hash(999), mediantime: 1789500000, genesis_hash: GENESIS.testnet4 };
const row = i => ({ txid: hash(i), status: 'confirmed', block_height: 998, block_hash: hash(998), confirmations: 2, received: '1', spent: '0', balance_delta: '1' });
const coin = (extra = {}) => ({ txid: hash(1), vout: 0, amount: '201', block_height: 998, status: 'confirmed', confirmations: 2, coinbase: false, mature: true, pending_spent_by: null, ...extra });
class Backend extends EventEmitter {
  constructor() { super(); this.socket = {}; this.tip = initialTip; this.calls = []; this.serial = 0; this.legacy = false; }
  async connect() { return this.socket; }
  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'getaddresschanges') {
      if (this.legacy) throw Object.assign(new Error('Method not found'), { code: -32601 });
      return await this.delta?.(params) ?? { tip: this.tip, unit: 'connects', changes: [], next_cursor: `journal-${++this.serial}`, has_more: false, through_sequence: 0, journal_epoch: 1 };
    }
    if (['subscribetip', 'subscribebounties', 'subscribeaddress'].includes(method)) return { subscription_id: `${method}-${params.address ?? 'global'}`, tip: this.tip, cursor: 'journal-start' };
    if (method === 'getchaintip') return this.tip;
    if (method === 'getaddresshistory') {
      await this.beforeHistory?.(params);
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
async function settled(service) {
  for (let pass = 0; pass < 800; pass++) {
    const live = service.liveUpdates;
    if (!service.refreshing && !live.running && !live.requested && !live.addressPending && !live.addressTimer && [service.walletUpdates, service.bountyUpdates].every(q => !q.running && !q.timer && !q.dirty)) return;
    await sleep(5);
  }
  assert.fail('Isolated synchronization did not settle');
}

test('201-row/41-address wallet downloads baseline once; each tip or address push fetches one delta', async t => {
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
  for (const kind of ['tip', 'tip', 'address']) {
    rpc.calls = []; rpc.tip = { ...rpc.tip, height: rpc.tip.height + 1, hash: hash(rpc.tip.height + 1) };
    const sub = service.liveUpdates.registrations.get(kind === 'tip' ? 'tip' : `address:${rpc.used}`);
    rpc.emit('notification', { subscription_id: sub.id, kind, tip: rpc.tip, ...(kind === 'address' ? { address: rpc.used, refresh: true } : {}) });
    await settled(service);
    assert.deepEqual(counts(rpc), { getchaintip: 1, getaddresschanges: 1 });
    assert.equal(service.history.length, 201);
  }
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
  assert.deepEqual(counts(rpc), { getchaintip: 1, getaddresschanges: 1 });
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
