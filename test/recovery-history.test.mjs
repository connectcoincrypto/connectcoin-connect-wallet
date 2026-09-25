import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { WalletService } from '../src/core/wallet-service.mjs';
import { GENESIS } from '../src/core/config.mjs';

const mnemonic = `${'abandon '.repeat(11)}about`;
const originalTip = { chain: 'testnet4', height: 999, hash: 'a'.repeat(64), mediantime: 1789500000, genesis_hash: GENESIS.testnet4 };
const forkTip = { ...originalTip, hash: 'b'.repeat(64) };
const transaction = digit => ({ txid: digit.repeat(64), status: 'confirmed', block_height: 998,
  confirmations: 2, received: '10000000000', spent: '0', balance_delta: '10000000000' });

class Backend extends EventEmitter {
  constructor() { super(); this.socket = {}; this.tip = originalTip; this.calls = []; this.historyBudget = Infinity; }
  async connect() { if (!this.socket) { this.socket = {}; this.emit('connected'); } return this.socket; }
  async request(method, params = {}) {
    this.calls.push({ method, ...params });
    if (['subscribetip', 'subscribebounties', 'subscribeaddress'].includes(method)) return {
      subscription_id: `${method}-${params.address ?? 'global'}`, tip: this.tip, cursor: 'fixture-journal',
    };
    if (method === 'unsubscribe') return { removed: true };
    if (method === 'getchaintip') return this.chainTip?.() ?? this.tip;
    if (method === 'getaddressbalance') {
      this.beforeBalance?.(params);
      return { tip: this.tip, address: params.address, unit: 'connects', confirmed: '0', available_confirmed: '0', immature: '0', pending_delta: '0' };
    }
    if (method === 'getaddresshistory') {
      assert.ok(this.calls.filter(call => call.method === method).length <= this.historyBudget,
        'Recovery must fit within the unchanged 48 history requests per minute.');
      const result = await this.history?.(params);
      return { tip: this.tip, address: params.address, unit: 'connects', items: [], next_cursor: null, ...result };
    }
    if (method === 'getaddressutxos') return { tip: this.tip, address: params.address, unit: 'connects', items: [], next_cursor: null };
    throw new Error(`Unexpected fixture request ${method}`);
  }
  close() { this.socket = null; }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-recovery-history-'));
  const backend = new Backend();
  const service = new WalletService({ directory, clientFactory: () => backend, proofRunner: async () => '020100' });
  await service.initialize();
  clearInterval(service.timer);
  // Exercise the real discovery/refresh state machine without unrelated KDF IO.
  service.session = { password: 'public-test-password-only', data: { name: 'Recovery fixture', mnemonic,
    network: 'testnet4', passphrase: '', receiveIndex: 0, changeIndex: 0,
    lastUsedReceive: -1, lastUsedChange: -1, needsRecovery: true } };
  service.persist = async () => {};
  service.buildAccounts();
  t.after(async () => {
    await service.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('connectwallet-recovery-history-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { service, backend, calls: () => backend.calls.filter(call => call.method === 'getaddresshistory') };
}

test('empty recovery discovers both complete gaps within one 48-request budget and refreshes them again later', async t => {
  const { service, backend, calls } = await fixture(t);
  backend.historyBudget = 48;
  await service.refresh();
  assert.equal(calls().length, 40);
  assert.equal(new Set(calls().map(call => call.address)).size, 40);
  assert.equal(service.accounts.length, 40);
  assert.equal(service.session.data.scanLookahead, true);
  assert.equal(service.session.data.needsRecovery, false);
  for (const change of [0, 1]) assert.ok(service.accounts.some(account => account.change === change && account.index === 19));
  const watched = new Set(service.accounts.map(account => account.address));
  const paid = service.publicAccount(19, 0).address;
  backend.historyBudget = Infinity;
  backend.calls = [];
  backend.history = ({ address }) => address === paid ? { items: [transaction('c')] } : undefined;
  await service.refresh();
  assert.deepEqual(new Set(calls().map(call => call.address)), watched);
  assert.equal(calls().length, 40);
  assert.equal(service.history[0].txid, 'c'.repeat(64));
  assert.equal(service.session.data.lastUsedReceive, 19);
  assert.ok(service.accounts.some(account => account.change === 0 && account.index === 39));
  assert.ok(!Object.keys(service.session.data).some(key => /empty|cache|snapshot/i.test(key)));
});

test('a mempool payment arriving after discovery at the same tip is found by the next refresh', async t => {
  const { service, backend, calls } = await fixture(t);
  const paid = service.publicAccount(19, 0).address;
  const pending = { ...transaction('e'), status: 'pending', block_height: null, confirmations: 0 };
  let tipCalls = 0, inMempool = false;
  backend.chainTip = () => {
    if (++tipCalls === 2) {
      assert.equal(calls().length, 40, 'The payment arrives only after both empty recovery gaps were discovered.');
      inMempool = true;
    }
    return originalTip;
  };
  backend.history = ({ address }) => inMempool && address === paid ? { items: [pending] } : undefined;
  const request = backend.request.bind(backend);
  backend.request = async (method, params = {}) => {
    const result = await request(method, params);
    return method === 'getaddressbalance' && inMempool && params.address === paid
      ? { ...result, pending_delta: pending.balance_delta } : result;
  };
  await service.refresh();
  assert.equal(inMempool, true);
  assert.equal(calls().length, 40);
  assert.equal(service.tip.hash, originalTip.hash);
  assert.deepEqual(service.history, [], 'An unchanged tip is not an atomic mempool snapshot.');
  assert.equal(service.balance.pending, '0');
  assert.equal(service.session.data.needsRecovery, false);
  assert.ok(service.accounts.some(account => account.address === paid), 'The unused lookahead remains watched.');

  backend.calls = [];
  await service.refresh();
  assert.equal(service.tip.hash, originalTip.hash, 'No new block is needed to discover the pending payment.');
  assert.equal(calls().length, 40);
  assert.equal(calls().filter(call => call.address === paid).length, 1);
  assert.deepEqual(service.history.map(({ txid, status, confirmations }) => ({ txid, status, confirmations })),
    [{ txid: pending.txid, status: 'pending', confirmations: 0 }]);
  assert.equal(service.balance.pending, '1');
  assert.equal(service.session.data.lastUsedReceive, 19);
  assert.ok(service.accounts.some(account => account.change === 0 && account.index === 39));
});

test('recovery follows empty continuation pages and fully refreshes a used address', async t => {
  const { service, backend, calls } = await fixture(t);
  const used = service.publicAccount(0, 0).address;
  backend.historyBudget = 48;
  backend.history = ({ address, cursor }) => {
    if (address !== used) return;
    if (!cursor) return { items: [], next_cursor: 'next-page' };
    if (cursor === 'next-page') return { items: [transaction('c')], next_cursor: 'last-page' };
    assert.equal(cursor, 'last-page');
    return { items: [transaction('d')], next_cursor: null };
  };
  await service.refresh();
  assert.deepEqual(calls().filter(call => call.address === used).map(call => call.cursor),
    [undefined, 'next-page', undefined, 'next-page', 'last-page']);
  assert.equal(calls().length, 45);
  assert.equal(service.session.data.lastUsedReceive, 0);
  assert.equal(service.session.data.receiveIndex, 1);
  assert.equal(service.accounts.length, 41);
  assert.deepEqual(new Set(service.history.map(row => row.txid)), new Set(['c'.repeat(64), 'd'.repeat(64)]));
});

test('an empty address is reused only after all of its empty pages are exhausted', async t => {
  const { service, backend, calls } = await fixture(t);
  const address = service.publicAccount(0, 0).address;
  backend.history = params => params.address === address && !params.cursor ? { next_cursor: 'last-empty-page' } : undefined;
  await service.refresh();
  assert.deepEqual(calls().filter(call => call.address === address).map(call => call.cursor), [undefined, 'last-empty-page']);
  assert.equal(calls().length, 41);
});

test('a same-height fork between discovery and refresh prevents reuse of every empty address', async t => {
  const { service, backend, calls } = await fixture(t);
  const paid = service.publicAccount(19, 0).address;
  let tipCalls = 0;
  backend.chainTip = () => { if (++tipCalls === 2) backend.tip = forkTip; return backend.tip; };
  backend.history = ({ address }) => backend.tip === forkTip && address === paid ? { items: [transaction('c')] } : undefined;
  await service.refresh();
  assert.equal(calls().length, 80);
  assert.equal(service.history[0].txid, 'c'.repeat(64));
  assert.equal(service.session.data.lastUsedReceive, 19);
});

test('a different tip on any discovery page invalidates emptiness even when getchaintip still reports the original hash', async t => {
  const { service, backend, calls } = await fixture(t);
  let historyCalls = 0;
  backend.history = () => ++historyCalls === 20 ? { tip: forkTip } : undefined;
  await service.refresh();
  assert.equal(calls().length, 80);
});

test('a tip change after a skipped address causes one complete refresh without reuse', async t => {
  const { service, backend, calls } = await fixture(t);
  const paid = service.publicAccount(0, 0).address;
  backend.beforeBalance = () => { backend.tip = forkTip; };
  backend.history = ({ address }) => backend.tip === forkTip && address === paid ? { items: [transaction('c')] } : undefined;
  await service.refresh();
  assert.equal(calls().filter(call => call.address === paid).length, 2);
  assert.equal(service.history[0].txid, 'c'.repeat(64));
  assert.equal(service.session.data.lastUsedReceive, 0);
  assert.equal(service.tip.hash, forkTip.hash);
});

test('the final tip check detects a fork after all empty lookahead addresses were skipped', async t => {
  const { service, backend, calls } = await fixture(t);
  const paid = service.publicAccount(19, 1).address;
  let tipCalls = 0;
  backend.chainTip = () => { if (++tipCalls === 3) backend.tip = forkTip; return backend.tip; };
  backend.history = ({ address }) => backend.tip === forkTip && address === paid ? { items: [transaction('c')] } : undefined;
  await service.refresh();
  assert.equal(calls().length, 80);
  assert.equal(service.history[0].txid, 'c'.repeat(64));
  assert.equal(service.session.data.lastUsedChange, 19);
});

for (const nextCursor of ['', 'same-cursor']) test(`empty firstOnly pages reject invalid or repeated cursor ${JSON.stringify(nextCursor)}`, async t => {
  const { service, backend } = await fixture(t);
  backend.history = () => ({ next_cursor: nextCursor });
  await assert.rejects(service.page('getaddresshistory', service.accounts[0].address, { firstOnly: true }), /invalid or repeated cursor/);
});

test('an endless sequence of distinct empty continuation pages has a bounded request count', async t => {
  const { service, backend, calls } = await fixture(t);
  let page = 0;
  backend.history = () => ({ next_cursor: `page-${++page}` });
  await assert.rejects(service.page('getaddresshistory', service.accounts[0].address, { firstOnly: true }), /pagination exceeds/);
  assert.equal(calls().length, 1000);
});

for (const transition of ['epoch', 'rpc']) test(`an in-flight recovery page cannot survive a changed ${transition}`, async t => {
  const { service, backend } = await fixture(t);
  let finish, started;
  const waiting = new Promise(resolve => { started = resolve; });
  backend.history = () => new Promise(resolve => { finish = resolve; started(); });
  const request = service.page('getaddresshistory', service.accounts[0].address, { firstOnly: true });
  await waiting;
  if (transition === 'epoch') service.epoch++;
  else service.rpc = new Backend();
  finish(undefined);
  await assert.rejects(request, /locked or changed|connection changed/);
});

for (const transition of ['epoch', 'rpc']) test(`recovered empty addresses cannot cross a changed ${transition} during persistence`, async t => {
  const { service } = await fixture(t);
  service.persist = async () => {
    if (transition === 'epoch') service.epoch++;
    else service.rpc = new Backend();
  };
  await assert.rejects(service.refresh(), /locked or changed|connection changed/);
  assert.equal(service.balance, null);
  assert.deepEqual(service.history, []);
});
