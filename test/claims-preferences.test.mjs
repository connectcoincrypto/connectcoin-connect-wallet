import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { WalletService } from '../src/core/wallet-service.mjs';
import { GENESIS, readConfig, writeConfig } from '../src/core/config.mjs';
import { createVault } from '../src/core/vault.mjs';
import { VAULT_NAME } from '../src/core/profile-paths.mjs';
import { serializeTransaction, transactionId } from '../src/core/transaction.mjs';

const password = 'isolated-preferences-test-password';
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const tip = { chain: 'testnet4', genesis_hash: GENESIS.testnet4, height: 0,
  hash: GENESIS.testnet4, mediantime: 1800000000 };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

class Backend extends EventEmitter {
  constructor(options, control) {
    super(); this.options = options; this.control = control; this.calls = []; this.socket = null;
  }
  async connect() {
    if (!this.control.online) throw new Error('Isolated test RPC is offline.');
    if (!this.socket) { this.socket = {}; this.emit('connected'); }
    return this.socket;
  }
  async request(method, params = {}, { onChunk } = {}) {
    this.calls.push(method);
    await this.connect();
    const currentTip = this.control.validChain ? tip : { ...tip, chain: 'main' };
    if (['subscribetip', 'subscribebounties', 'subscribeaddress'].includes(method)) return {
      subscription_id: `${method}-${params.address ?? 'global'}`, tip: currentTip, cursor: 'empty-journal',
    };
    if (method === 'unsubscribe') return { removed: true };
    if (method === 'getchaintip') return currentTip;
    if (method === 'getaddressbalance') return { tip: currentTip, address: params.address, unit: 'connects',
      confirmed: '0', available_confirmed: '0', immature: '0', pending_delta: '0' };
    if (['getaddresshistory', 'getaddressutxos'].includes(method)) return {
      tip: currentTip, address: params.address, unit: 'connects', items: [], next_cursor: null,
    };
    if (method === 'getrecentblockhashes') return { tip: currentTip, window: 600,
      blocks: [{ height: 0, hash: GENESIS.testnet4 }] };
    if (method === 'getbountychanges') return { tip: currentTip, next_cursor: 'empty-journal', has_more: false, changes: [] };
    if (method === 'getblockbounties') {
      onChunk({ type: 'snapshot', tip: currentTip, block_hash: params.block_hash, unit: 'connects', cursor: 'empty-journal' });
      onChunk({ type: 'state', tip: currentTip, cursor: 'empty-journal' });
      return { records: 0, chunks: 2 };
    }
    throw new Error(`Unexpected isolated test RPC request: ${method}`);
  }
  close() { this.socket = null; }
}

async function fixture(t, { online = true, validChain = true, config = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-claims-preference-test-'));
  const services = [], clients = [], cleanup = [], control = { online, validChain };
  t.after(async () => {
    for (const release of cleanup) release();
    for (const service of services) if (!service.closed) await service.close();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('connectwallet-claims-preference-test-'));
    await rm(absolute, { recursive: true, force: true });
  });
  await writeConfig(directory, config);
  await createVault(join(directory, VAULT_NAME), {
    name: 'Isolated preference fixture', mnemonic, network: 'testnet4', passphrase: '',
    receiveIndex: 0, changeIndex: 0, lastUsedReceive: -1, lastUsedChange: -1,
    needsRecovery: false, createdAt: '2026-01-01T00:00:00.000Z',
  }, password);
  const open = async () => {
    const service = new WalletService({ directory,
      clientFactory: options => { const client = new Backend(options, control); clients.push(client); return client; },
      proofRunner: async () => { throw new Error('Empty test chain must never generate a proof.'); },
    });
    services.push(service); await service.initialize(); return service;
  };
  const service = await open();
  return { service, directory, clients, control, cleanup, open };
}

async function settle(service) {
  if (service.rpc.control.online && service.rpc.control.validChain && service.liveUpdates.started) {
    // Real sockets emit connected before replies; after an offline or invalid
    // network attempt, subscriptions recover asynchronously under backoff.
    // Wait for those actual registrations instead of treating a manual refresh
    // during reconnect as proof that automatic recovery failed.
    let ready = false;
    for (let attempt = 0; attempt < 1000; attempt++) {
      ready = service.liveUpdates.baseReady && service.accounts.every(account =>
        service.liveUpdates.registrations.has(`address:${account.address}`));
      if (ready) break;
      await new Promise(done => setTimeout(done, 5));
    }
    assert.ok(ready, 'Valid online RPC must recover its live subscriptions within the bounded retry window');
  }
  await service.refresh();
  await service.bountySync;
  if (service.rpc.control.online && service.rpc.control.validChain && service.liveUpdates.started) {
    // Wait for the startup catch-up queues as well as registration. Appearance
    // and preference tests below measure only work caused by their own edit,
    // not a subscription catch-up that happened to be delayed under build load.
    let idle = false;
    for (let attempt = 0; attempt < 1000; attempt++) {
      const live = service.liveUpdates;
      idle = !service.refreshing && !service.bountySync && !live.running && !live.requested &&
        !live.retryTimer && !live.addressTimer && !live.addressPending &&
        [service.walletUpdates, service.bountyUpdates].every(queue => !queue.running && !queue.timer && !queue.dirty);
      if (idle) break;
      await new Promise(done => setTimeout(done, 5));
    }
    assert.ok(idle, 'Initial live catch-up work must settle before checking a subsequent settings edit');
  }
}
async function unlock(service) {
  await service.unlock({ password });
  await settle(service);
}

test('locked offline preferences persist partial limits and remain separate from runtime execution', async t => {
  const f = await fixture(t, { online: false });
  const s = f.service;
  assert.equal(s.getState().phase, 'locked');
  await s.setClaims({ enabled: true });
  await s.setClaims({ maxConcurrent: 7 });
  await s.setClaims({ maxConnectionsPerSecond: 3, lookbackBlocks: 42 });
  const expected = { enabled: true, maxConcurrent: 7, maxConnectionsPerSecond: 3, lookbackBlocks: 42 };
  assert.deepEqual(s.config.claims, expected);
  assert.deepEqual((await readConfig(f.directory)).claims, expected);
  assert.equal(s.getState().claims.enabled, false);
  assert.equal(s.session, null);
  assert.equal(f.clients.flatMap(client => client.calls).length, 0, 'locked settings must not need an RPC connection');
  await s.close();
  const reopened = await f.open();
  assert.deepEqual(reopened.config.claims, expected);
  assert.equal(reopened.getState().claims.enabled, false);
});

test('saved Automatic Claims starts after unlock and survives lock, close and reopening', async t => {
  const f = await fixture(t, { config: { claims: { enabled: true, lookbackBlocks: 1 } } });
  const s = f.service;
  assert.equal(s.engine.enabled, false);
  await unlock(s);
  assert.equal(s.getState().network.status, 'online');
  assert.equal(s.engine.enabled, true);
  assert.ok(s.rpc.calls.includes('getblockbounties'), 'unlock must synchronize the claim catalog before work resumes');
  await s.lock();
  assert.equal(s.engine.enabled, false);
  assert.equal(s.config.claims.enabled, true);
  assert.equal((await readConfig(f.directory)).claims.enabled, true);
  await unlock(s);
  assert.equal(s.engine.enabled, true);
  await s.close();
  const reopened = await f.open();
  assert.equal(reopened.config.claims.enabled, true);
  assert.equal(reopened.engine.enabled, false);
  await unlock(reopened);
  assert.equal(reopened.engine.enabled, true);
  await reopened.setClaims({ enabled: false });
  assert.equal(reopened.engine.enabled, false);
  await reopened.close();
  const stopped = await f.open();
  await unlock(stopped);
  assert.equal(stopped.config.claims.enabled, false);
  assert.equal(stopped.engine.enabled, false);
  assert.equal(stopped.rpc.calls.includes('getblockbounties'), false);
});

test('saved intent waits through offline or invalid-chain refreshes and resumes only on a validated chain', async t => {
  const f = await fixture(t, { online: false, config: { claims: { enabled: true, lookbackBlocks: 1 } } });
  const s = f.service;
  await s.unlock({ password });
  await assert.rejects(s.refresh(), /offline/);
  assert.equal(s.config.claims.enabled, true);
  assert.equal(s.engine.enabled, false);
  f.control.online = true; f.control.validChain = false;
  await assert.rejects(s.refresh(), /network|chain tip/);
  assert.equal(s.engine.enabled, false);
  assert.equal(s.rpc.calls.includes('getblockbounties'), false);
  f.control.validChain = true;
  await settle(s);
  assert.equal(s.engine.enabled, true);
  f.control.online = false; s.rpc.close(); s.rpc.emit('disconnected');
  await assert.rejects(s.refresh(), /offline/);
  assert.equal(s.engine.enabled, false);
  assert.equal((await readConfig(f.directory)).claims.enabled, true);
  f.control.online = true;
  await settle(s);
  assert.equal(s.engine.enabled, true);
});

test('disabling and changing limits while offline saves successfully and prevents later automatic restart', async t => {
  const f = await fixture(t, { config: { claims: { enabled: true, lookbackBlocks: 1 } } });
  const s = f.service;
  await unlock(s);
  f.control.online = false; s.rpc.close(); s.rpc.emit('disconnected');
  await s.setClaims({ maxConcurrent: 4 });
  assert.equal(s.config.claims.enabled, true);
  await s.setClaims({ enabled: false, maxConnectionsPerSecond: 2 });
  assert.equal(s.engine.enabled, false);
  assert.deepEqual((await readConfig(f.directory)).claims,
    { enabled: false, maxConcurrent: 4, maxConnectionsPerSecond: 2, lookbackBlocks: 1 });
  f.control.online = true;
  await settle(s);
  assert.equal(s.engine.enabled, false);
});

test('auto-lock and fee edits preserve active claims, RPC and saved appearance preferences', async t => {
  const f = await fixture(t, { config: { claims: { enabled: true, lookbackBlocks: 1 }, theme: 'dark', developerMode: true } });
  const s = f.service;
  await unlock(s);
  const rpc = s.rpc, engine = s.engine, session = s.session, epoch = s.epoch;
  const blocks = s.claimBlocks, cursor = s.claimCursor;
  const stopped = t.mock.method(engine, 'stop');
  const cleared = t.mock.method(engine, 'clear');
  const encrypted = await readFile(s.vaultFile, 'utf8');
  await s.saveConfig({ autoLockMinutes: 30 });
  await s.saveConfig({ feeRate: 2000 });
  assert.equal(s.rpc, rpc);
  assert.equal(s.engine, engine);
  assert.equal(s.engine.enabled, true);
  assert.equal(s.session, session);
  assert.equal(s.epoch, epoch);
  assert.equal(s.claimBlocks, blocks);
  assert.equal(s.claimCursor, cursor);
  assert.equal(stopped.mock.callCount(), 0);
  assert.equal(cleared.mock.callCount(), 0);
  assert.equal(await readFile(s.vaultFile, 'utf8'), encrypted);
  assert.deepEqual(await readConfig(f.directory), s.config);
  assert.equal(s.config.autoLockMinutes, 30);
  assert.equal(s.config.feeRate, 2000);
  assert.equal(s.config.theme, 'dark');
  assert.equal(s.config.developerMode, true);
  assert.equal(s.config.claims.enabled, true);
});

test('RPC endpoint edits clear old discovery state and resume saved claims on the replacement connection', async t => {
  const f = await fixture(t, { config: { claims: { enabled: true, lookbackBlocks: 1 } } });
  const s = f.service;
  await unlock(s);
  const oldRpc = s.rpc;
  const cleared = t.mock.method(s.engine, 'clear');
  const staleHash = 'ab'.repeat(32);
  s.claimBlocks.set(staleHash, []);
  await s.saveConfig({ rpc: { host: 'replacement.invalid', port: 18001 } });
  await settle(s);
  assert.notEqual(s.rpc, oldRpc);
  assert.equal(oldRpc.socket, null);
  assert.deepEqual(s.config.rpc, { host: 'replacement.invalid', port: 18001 });
  assert.equal(s.claimBlocks.has(staleHash), false);
  assert.ok(cleared.mock.callCount() > 0);
  assert.ok(s.rpc.calls.includes('getblockbounties'));
  assert.equal(s.engine.enabled, true);
  assert.equal(s.config.claims.enabled, true);
  assert.deepEqual(await readConfig(f.directory), s.config);
});

test('simultaneous settings writes preserve independent fields and latest partial claim preferences', async t => {
  const f = await fixture(t, { online: false });
  const s = f.service;
  await Promise.all([
    s.setClaims({ enabled: true, maxConcurrent: 9 }),
    s.setTheme({ theme: 'dark' }),
    s.setDeveloperMode({ enabled: true }),
    s.saveConfig({ autoLockMinutes: 27, feeRate: 2400 }),
    s.setClaims({ maxConnectionsPerSecond: 6, lookbackBlocks: 23 }),
  ]);
  const expected = { ...s.config, theme: 'dark', developerMode: true, autoLockMinutes: 27, feeRate: 2400,
    claims: { enabled: true, maxConcurrent: 9, maxConnectionsPerSecond: 6, lookbackBlocks: 23 } };
  assert.deepEqual(s.config, expected);
  assert.deepEqual(await readConfig(f.directory), expected);
  assert.equal(s.engine.enabled, false);
  await s.close();
  const reopened = await f.open();
  assert.deepEqual(reopened.config, expected);
});

test('locking during pending claim startup preserves the saved preference without starting the locked engine', async t => {
  const f = await fixture(t);
  const s = f.service;
  await unlock(s);
  const rpc = s.rpc, entered = deferred(), reply = deferred();
  const request = rpc.request.bind(rpc);
  t.mock.method(rpc, 'request', (method, ...args) => {
    if (method !== 'getchaintip') return request(method, ...args);
    entered.resolve(); return reply.promise;
  });
  f.cleanup.push(() => reply.resolve(tip));
  const started = t.mock.method(s.engine, 'start');
  const enabling = s.setClaims({ enabled: true });
  await entered.promise;
  assert.equal((await readConfig(f.directory)).claims.enabled, true);
  await s.lock();
  reply.resolve(tip);
  await enabling;
  assert.equal(s.getState().phase, 'locked');
  assert.equal(s.engine.enabled, false);
  assert.equal(started.mock.callCount(), 0);
  assert.equal(s.tip, null, 'a late old RPC reply must not repopulate the locked session');
  assert.equal(s.config.claims.enabled, true);
  await unlock(s);
  assert.equal(s.engine.enabled, true);
});

test('an older RPC-settings operation cannot clear or stop a newer session after its helper drain completes', async t => {
  const f = await fixture(t, { config: { claims: { enabled: true, lookbackBlocks: 1 } } });
  const s = f.service;
  await unlock(s);
  const entered = deferred(), release = deferred();
  const originalStop = s.engine.stop.bind(s.engine);
  let held = false;
  t.mock.method(s.engine, 'stop', async (...args) => {
    const stopped = originalStop(...args);
    if (!held) {
      held = true; entered.resolve(); await release.promise;
    }
    return stopped;
  });
  f.cleanup.push(() => release.resolve());
  const changing = s.saveConfig({ rpc: { host: 'changed.invalid', port: 18002 } });
  await entered.promise;
  await s.lock();
  await unlock(s);
  assert.equal(s.engine.enabled, true);
  const session = s.session, rpc = s.rpc, epoch = s.epoch, blocks = s.claimBlocks;
  const clears = t.mock.method(s.engine, 'clear');
  release.resolve();
  await changing;
  assert.equal(s.session, session);
  assert.equal(s.rpc, rpc);
  assert.equal(s.epoch, epoch);
  assert.equal(s.claimBlocks, blocks);
  assert.equal(s.engine.enabled, true);
  assert.equal(clears.mock.callCount(), 0);
  assert.deepEqual((await readConfig(f.directory)).rpc, { host: 'changed.invalid', port: 18002 });
});

async function preparedClaim(t, service) {
  const funding = { version: 2, locktime: 0,
    inputs: [{ txid: 'cd'.repeat(32), vout: 0, sequence: 0xffffffff, scriptSig: '', witness: [] }],
    outputs: [{ type: 2, amount: '1000000000', domain: 'example.com', target: 'f'.repeat(64), rootVersion: 1, mask: 7 }],
  };
  const bounty = { txid: transactionId(funding), vout: 0, amount: '1000000000', domain: 'example.com',
    connection_work_target: 'f'.repeat(64), root_certificates_version: 1, signature_algorithms_mask: 7,
    block_height: 0, block_hash: GENESIS.testnet4, status: 'available' };
  service.claimOutpoints.set(`${bounty.txid}:0`, bounty);
  t.mock.method(service, 'funding', async () => serializeTransaction(funding).toString('hex'));
  const prepared = await service.prepareAutomaticClaim(bounty);
  // Exercise submission safety only. TLS authentication is covered by the
  // existing proof tests; no socket or cryptographic proof worker is started.
  const hello = Buffer.concat([Buffer.from('010000220303', 'hex'), Buffer.from(prepared.challenge, 'hex')]);
  const proof = Buffer.concat([Buffer.from([2]), hello,
    ...[2, 8, 11, 15].map(type => Buffer.from([type, 0, 0, 0]))]).toString('hex');
  return { prepared, proof };
}

for (const transition of ['after reply', 'before reply', 'closing']) test(`an unknown broadcast outcome with lock ${transition} stays disabled after reopening`, async t => {
  const f = await fixture(t, { config: { claims: { enabled: true, lookbackBlocks: 1 } } });
  const s = f.service;
  await unlock(s);
  const { prepared, proof } = await preparedClaim(t, s);
  const sent = deferred(), response = deferred(), rpc = s.rpc;
  const originalRequest = rpc.request.bind(rpc);
  t.mock.method(rpc, 'request', (method, ...args) => {
    if (method !== 'sendrawtransaction') return originalRequest(method, ...args);
    sent.resolve(); return response.promise;
  });
  const submission = s.engine.track({ bounty: prepared.bounty }, s.submitAutomaticClaim(prepared, proof));
  const outcome = assert.rejects(submission, error =>
    error.unknownOutcome === true && /broadcast was not confirmed/.test(error.message));
  f.cleanup.push(() => response.reject(Object.assign(new Error('Isolated broadcast cleanup.'), { unknownOutcome: true })));
  await sent.promise;
  const stopping = transition === 'closing' ? s.close() : transition === 'before reply' ? s.lock() : null;
  response.reject(Object.assign(new Error('Isolated transport lost the broadcast response.'), { unknownOutcome: true }));
  await outcome;
  assert.equal(s.engine.enabled, false);
  if (stopping) await stopping;
  else await s.lock();
  if (!s.closed) await s.close();
  assert.equal((await readConfig(f.directory)).claims.enabled, false);
  const reopened = await f.open();
  await unlock(reopened);
  assert.equal(reopened.config.claims.enabled, false);
  assert.equal(reopened.engine.enabled, false);
  assert.equal(reopened.rpc.calls.includes('getblockbounties'), false);
});

for (const queuedEnable of [false, true]) test(`an unknown broadcast while claim settings drain cannot restart workers${queuedEnable ? ' through an earlier queued enable' : ''}`, async t => {
  const f = await fixture(t, { config: { claims: { enabled: true, lookbackBlocks: 1 } } });
  const s = f.service;
  await unlock(s);
  const { prepared, proof } = await preparedClaim(t, s);
  const sent = deferred(), response = deferred(), draining = deferred();
  const request = s.rpc.request.bind(s.rpc);
  t.mock.method(s.rpc, 'request', (method, ...args) => {
    if (method !== 'sendrawtransaction') return request(method, ...args);
    sent.resolve(); return response.promise;
  });
  const submission = s.engine.track({ bounty: prepared.bounty }, s.submitAutomaticClaim(prepared, proof));
  const outcome = assert.rejects(submission, error => error.unknownOutcome === true);
  f.cleanup.push(() => response.reject(Object.assign(new Error('Isolated broadcast cleanup.'), { unknownOutcome: true })));
  await sent.promise;
  const stop = s.engine.stop.bind(s.engine);
  t.mock.method(s.engine, 'stop', (...args) => { const pending = stop(...args); draining.resolve(); return pending; });
  const starts = t.mock.method(s.engine, 'start');
  const changing = s.saveConfig({ claims: { maxConcurrent: 3 } });
  await draining.promise;
  const enabling = queuedEnable ? s.setClaims({ enabled: true }) : null;
  response.reject(Object.assign(new Error('Isolated broadcast response lost during settings change.'), { unknownOutcome: true }));
  await outcome;
  await changing;
  await enabling;
  await s.settingsWrite;
  assert.equal(starts.mock.callCount(), 0, 'saved=true from the older settings change must not restart claims');
  assert.equal(s.engine.enabled, false);
  assert.equal(s.config.claims.enabled, false);
  assert.equal(s.config.claims.maxConcurrent, 3);
  const saved = await readConfig(f.directory);
  assert.equal(saved.claims.enabled, false);
  assert.equal(saved.claims.maxConcurrent, 3);
  await s.refresh();
  assert.equal(s.engine.enabled, false, 'an ordinary refresh must not dismiss required broadcast review');
  await s.setClaims({ enabled: true });
  await settle(s);
  assert.equal(s.engine.enabled, true, 'a new explicit enable after the review stop may restart workers');
});
