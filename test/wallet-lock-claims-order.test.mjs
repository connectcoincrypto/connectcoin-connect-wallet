import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WalletService } from '../src/core/wallet-service.mjs';
import { GENESIS } from '../src/core/config.mjs';

const password = 'public-test-password-only';
const mnemonic = `${'abandon '.repeat(11)}about`;
const tip = { chain: 'testnet4', height: 999, hash: 'a'.repeat(64), mediantime: 1789500000, genesis_hash: GENESIS.testnet4 };
class Backend extends EventEmitter {
  constructor() { super(); this.socket = {}; }
  async connect() { return this.socket; }
  async request(method, params) {
    if (method === 'getaddresschanges') throw Object.assign(new Error('Legacy fixture'), { code: -32601 });
    if (['subscribetip', 'subscribebounties', 'subscribeaddress'].includes(method)) return {
      subscription_id: `${method}-${params?.address ?? 'global'}`, tip, cursor: 'fixture-journal',
      ...(method === 'subscribeaddress' ? { changes_only: true } : {}),
    };
    if (method === 'unsubscribe') return { removed: true };
    if (method === 'getchaintip') return tip;
    if (method === 'getaddressbalance') return { tip, address: params.address, unit: 'connects',
      confirmed: '0', available_confirmed: '0', immature: '0', pending_delta: '0' };
    if (['getaddresshistory', 'getaddressutxos'].includes(method)) return { tip, address: params.address, unit: 'connects', items: [], next_cursor: null };
    throw new Error(`Unexpected mock request ${method}`);
  }
  close() { this.socket = null; }
}

test('unlock during a real shared claims-stop barrier clears old work before resuming new work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-lock-order-test-'));
  const service = new WalletService({ directory, network: 'testnet4', clientFactory: () => new Backend(), proofRunner: async () => '020100' });
  let release;
  const draining = new Promise(resolve => { release = resolve; });
  let locking;
  try {
    await service.initialize();
    await service.createWallet({ name: 'Synthetic lock test', password, mnemonic }, false);
    await service.refresh();
    const engine = service.engine, steps = [];
    const clear = engine.clear.bind(engine), start = engine.start.bind(engine);
    engine.clear = (...args) => { steps.push('clear'); return clear(...args); };
    engine.start = (...args) => { steps.push('start'); return start(...args); };
    const row = { txid: '02'.repeat(32), vout: 0, amount: '10000000000', domain: 'example.com',
      connection_work_target: 'f'.repeat(64), signature_algorithms_mask: 7, root_certificates_version: 1, status: 'available' };
    service.syncBounties = async () => { steps.push('sync'); engine.enqueue([row]); };
    // Model a helper taking time to exit, keeping ClaimsEngine.stop itself real.
    // Both lock and resumeClaims must await this one engine.stopping promise.
    engine.pool = { close: () => draining };
    service.config.claims.enabled = true;
    locking = service.lock();
    const barrier = engine.stopping;
    assert.ok(barrier);
    await service.unlock({ password });
    assert.equal(engine.stopping, barrier);
    assert.equal(engine.enabled, false);
    assert.deepEqual(steps, []);
    release(); await locking;
    for (let attempt = 0; attempt < 100 && !steps.includes('sync'); attempt++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(steps, ['clear', 'start', 'sync']);
    assert.equal(engine.enabled, true);
    assert.equal(engine.queue.has(`${row.txid}:0`), true, 'Late lock completion must not clear the newly resumed catalog');
    await service.refresh();
    assert.equal(service.getState().network.status, 'online');
    assert.equal(service.getState().phase, 'unlocked');
  } finally {
    release(); await locking;
    await service.close();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}\\connectwallet-lock-order-test-`) || resolve(directory).startsWith(`${resolve(tmpdir())}/connectwallet-lock-order-test-`));
    await rm(directory, { recursive: true, force: true });
  }
});
