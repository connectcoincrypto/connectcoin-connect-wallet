import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LiveUpdates } from '../src/core/live-updates.mjs';
import { GENESIS } from '../src/core/config.mjs';

const tip = { chain: 'testnet4', genesis_hash: GENESIS.testnet4, height: 1, hash: 'a'.repeat(64), mediantime: 100 };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
class FakeRpc extends EventEmitter {
  constructor() { super(); this.calls = []; this.up = false; this.next = 0; }
  async connect() { if (!this.up) { this.up = true; this.emit('connected'); } }
  async request(method, params, options) {
    const call = { method, params, options }; this.calls.push(call);
    if (this.handler) { const result = await this.handler(call); if (result !== undefined) return result; }
    return { subscription_id: `id${++this.next}`, tip, cursor: 'opaque_cursor' };
  }
  disconnect() { this.up = false; this.emit('disconnected'); }
}
function setup(options = {}) {
  const rpc = new FakeRpc(), changes = [], errors = [], timers = new Map();
  let active = true, addresses = ['abcdefgh1'], nextTimer = 0;
  const live = new LiveUpdates({ rpc, network: 'testnet4', isActive: () => active, getAddresses: () => addresses,
    onChange: flags => changes.push(flags), onError: error => errors.push(error),
    setTimer: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimer: id => timers.delete(id), ...options });
  const fire = () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); };
  const notify = (key, extra = {}) => {
    const entry = live.registrations.get(key);
    rpc.emit('notification', { subscription_id: entry?.id, kind: entry?.kind, tip, address: entry?.address,
      refresh: true, cursor: 'opaque_cursor', changes: [], ...extra });
  };
  return { rpc, live, changes, errors, timers, fire, notify, setActive: value => { active = value; }, setAddresses: value => { addresses = value; } };
}

test('base subscriptions precede addresses, catch up after readiness and never poll on success', async () => {
  const s = setup(); s.live.start(); await flush();
  assert.deepEqual(s.rpc.calls.map(c => c.method), ['subscribetip', 'subscribebounties', 'subscribeaddress']);
  assert.deepEqual(s.changes[0], { wallet: true, bounties: true, reset: false, catchup: true });
  assert.deepEqual(s.changes[1], { wallet: true, bounties: false, reset: false, catchup: true });
  assert.equal(s.timers.size, 0);
  s.live.start(); s.live.updateAddresses(); await flush(); assert.equal(s.rpc.calls.length, 3);
  s.live.close();
});

test('notifications are validated and translated to wakeups, not applied as state', async () => {
  const s = setup(); s.live.start(); await flush(); s.changes.length = 0;
  s.notify('tip'); s.notify('bounties'); s.notify('address:abcdefgh1');
  assert.deepEqual(s.changes, [
    { wallet: true, bounties: true, reset: false, catchup: false },
    { wallet: false, bounties: true, reset: false, catchup: false },
    { wallet: true, bounties: false, reset: false, catchup: false },
  ]);
  s.changes.length = 0;
  s.notify('tip', { subscription_id: 'unknown' }); s.notify('tip', { kind: 'address' });
  s.notify('address:abcdefgh1', { address: 'abcdefgh2' }); s.notify('address:abcdefgh1', { refresh: false });
  s.notify('tip', { reorg: 'true' }); s.notify('tip', { tip: { ...tip, chain: 'main' } });
  s.notify('bounties', { cursor: '' }); s.notify('bounties', { cursor: 'a'.repeat(4097) }); s.notify('bounties', { changes: {} });
  assert.equal(s.changes.length, 0); assert.equal(s.errors.length, 1);
  s.notify('tip', { reorg: true }); s.notify('bounties', { resync_required: true, changes: undefined });
  assert.equal(s.changes.length, 2); assert.ok(s.changes.every(change => change.reset && change.bounties));
  s.live.close();
});

test('early notifications before registration are covered by initial catch-up', async () => {
  const s = setup();
  s.rpc.handler = call => {
    if (call.method !== 'subscribebounties') return;
    s.rpc.emit('notification', { subscription_id: 'early', kind: 'bounties', tip, cursor: 'c', changes: [{}] });
    return { subscription_id: 'early', tip, cursor: 'c' };
  };
  s.live.start(); await flush();
  assert.equal(s.live.registrations.get('bounties').id, 'early');
  assert.ok(s.changes.some(change => change.bounties)); s.live.close();
});

test('disconnect retries then installs new IDs; old notifications are ignored', async () => {
  const s = setup(); s.live.start(); await flush();
  const old = s.live.registrations.get('tip').id; s.rpc.disconnect();
  assert.equal(s.live.registrations.size, 0); assert.equal(s.timers.size, 1);
  assert.equal([...s.timers.values()][0].ms, 1000); s.fire(); await flush();
  assert.equal(s.rpc.calls.length, 6); assert.notEqual(s.live.registrations.get('tip').id, old);
  s.changes.length = 0;
  s.rpc.emit('notification', { subscription_id: old, kind: 'tip', tip });
  assert.equal(s.changes.length, 0); assert.equal(s.timers.size, 0); s.live.close();
});

test('late subscription replies from a former connection cannot install IDs', async () => {
  const s = setup(), reply = deferred(); let first = true;
  s.rpc.handler = call => { if (call.method === 'subscribetip' && first) { first = false; return reply.promise; } };
  s.live.start(); await flush(); s.rpc.disconnect(); await s.rpc.connect();
  reply.resolve({ subscription_id: 'old', tip, cursor: 'c' }); await flush();
  assert.notEqual(s.live.registrations.get('tip').id, 'old');
  assert.equal(s.live.registrations.size, 3); assert.equal(s.timers.size, 0); s.live.close();
});

test('close aborts queued requests, detaches listeners and ignores late replies', async () => {
  const s = setup(), reply = deferred(); s.rpc.handler = () => reply.promise;
  s.live.start(); await flush(); const signal = s.rpc.calls[0].options.signal;
  s.live.close(); assert.equal(signal.aborted, true);
  reply.resolve({ subscription_id: 'late', tip, cursor: 'c' }); await flush();
  assert.equal(s.live.registrations.size, 0); assert.equal(s.changes.length, 0); assert.equal(s.timers.size, 0);
  assert.equal(s.rpc.listenerCount('connected'), 0); assert.equal(s.rpc.listenerCount('disconnected'), 0);
  assert.equal(s.rpc.listenerCount('notification'), 0);
});

test('inactive wallets cannot receive wakeups, install results or retry', async () => {
  const s = setup(); s.live.start(); await flush(); s.setActive(false); s.changes.length = 0;
  s.notify('tip'); s.live.updateAddresses(); s.rpc.disconnect(); await flush();
  assert.equal(s.changes.length, 0); assert.equal(s.timers.size, 0); s.live.close();
});

test('address capacity stops retries and preserves tip and bounty subscriptions', async () => {
  const s = setup(); s.rpc.handler = call => { if (call.method === 'subscribeaddress') throw Object.assign(new Error('server text'), { code: -32005 }); };
  s.live.start(); await flush();
  assert.equal(s.live.registrations.size, 2); assert.equal(s.errors[0].code, 'LIVE_UPDATE_ADDRESS_CAPACITY');
  assert.match(s.errors[0].message, /Refresh/); assert.equal(s.timers.size, 0);
  for (let i = 0; i < 20; i++) s.live.updateAddresses(); await flush();
  assert.equal(s.rpc.calls.filter(c => c.method === 'subscribeaddress').length, 1);
  s.changes.length = 0; s.notify('tip'); assert.ok(s.changes[0].wallet && s.changes[0].bounties); s.live.close();
});

test('address changes unsubscribe stale addresses and subscribe replacements', async () => {
  const s = setup(); s.live.start(); await flush();
  const old = s.live.registrations.get('address:abcdefgh1').id;
  s.setAddresses(['abcdefgh2']); s.live.updateAddresses(); await flush();
  assert.equal(s.live.registrations.has('address:abcdefgh1'), false);
  assert.equal(s.live.registrations.has('address:abcdefgh2'), true);
  assert.deepEqual(s.rpc.calls.slice(3).map(c => [c.method, c.params]), [
    ['unsubscribe', { subscription_id: old }], ['subscribeaddress', { address: 'abcdefgh2' }],
  ]); s.live.close();
});

test('ordinary address failures retry with bounded backoff without replacing base IDs', async () => {
  const s = setup(); let failures = 8;
  s.rpc.handler = call => { if (call.method === 'subscribeaddress' && failures-- > 0) throw new Error('temporary'); };
  s.live.start(); await flush(); const waits = [];
  while (s.timers.size) { waits.push([...s.timers.values()][0].ms); s.fire(); await flush(); }
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(s.rpc.calls.filter(c => c.method === 'subscribetip').length, 1);
  assert.equal(s.rpc.calls.filter(c => c.method === 'subscribebounties').length, 1);
  assert.equal(s.live.registrations.size, 3); s.live.close();
});

test('invalid subscription identity/network never starts initial catch-up', async () => {
  for (const replacement of [{ subscription_id: '' }, { subscription_id: 'a'.repeat(101) }, { subscription_id: 'bad\u0000id' }, { subscription_id: 'bad\u007fid' }, { cursor: '' }, { tip: { ...tip, genesis_hash: 'b'.repeat(64) } }]) {
    const s = setup(); s.rpc.handler = () => ({ subscription_id: 'valid', cursor: 'c', tip, ...replacement });
    s.live.start(); await flush(); assert.equal(s.changes.length, 0); assert.equal(s.live.registrations.size, 0);
    assert.equal(s.timers.size, 1); s.live.close();
  }
});

test('notification and update storms do not duplicate subscription requests', async () => {
  const s = setup(); s.live.start(); await flush();
  for (let i = 0; i < 1000; i++) { s.notify('tip'); s.live.updateAddresses(); }
  await flush(); assert.equal(s.rpc.calls.length, 3); assert.equal(s.timers.size, 0); s.live.close();
});

test('address catch-ups are batched, while base tip changes remain immediate', async () => {
  const s = setup(); s.setAddresses(Array.from({ length: 40 }, (_, i) => `address${String(i).padStart(3, '0')}`));
  s.live.start(); await flush();
  assert.equal(s.rpc.calls.filter(c => c.method === 'subscribeaddress').length, 40);
  assert.equal(s.changes.length, 6); // One base catch-up, five groups of eight.
  assert.equal(s.timers.size, 0);
  const pending = deferred(); s.rpc.handler = call => call.method === 'subscribeaddress' ? pending.promise : undefined;
  s.setAddresses(['address000', 'address001', 'newaddress']); s.live.updateAddresses(); await flush();
  s.changes.length = 0; s.notify('address:address000');
  assert.equal(s.changes.length, 0); assert.equal(s.timers.size, 1);
  s.notify('tip'); assert.deepEqual(s.changes, [{ wallet: true, bounties: true, reset: false, catchup: false }]);
  s.fire(); assert.deepEqual(s.changes[1], { wallet: true, bounties: false, reset: false, catchup: false });
  pending.resolve({ subscription_id: 'new-id', tip, cursor: 'c' }); await flush();
  assert.equal(s.timers.size, 0); s.live.close();
});

test('local subscription cap reserves both base slots and does not spin for extra addresses', async () => {
  const s = setup(); s.setAddresses(Array.from({ length: 105 }, (_, i) => `address${String(i).padStart(3, '0')}`));
  s.live.start(); await flush();
  assert.equal(s.live.registrations.size, 100);
  assert.equal(s.rpc.calls.filter(c => c.method === 'subscribeaddress').length, 98);
  assert.equal(s.errors.length, 1); assert.equal(s.errors[0].code, 'LIVE_UPDATE_ADDRESS_CAPACITY');
  assert.equal(s.timers.size, 0);
  s.live.updateAddresses(); await flush(); assert.equal(s.rpc.calls.length, 100); s.live.close();
});

test('closing while a batched address notification waits cancels that wakeup', async () => {
  const s = setup(); s.live.start(); await flush(); const pending = deferred();
  s.rpc.handler = call => call.method === 'subscribeaddress' ? pending.promise : undefined;
  s.setAddresses(['abcdefgh1', 'abcdefgh2']); s.live.updateAddresses(); await flush();
  s.notify('address:abcdefgh1'); assert.equal(s.timers.size, 1);
  const count = s.changes.length; s.live.close(); assert.equal(s.timers.size, 0);
  pending.resolve({ subscription_id: 'late-address', cursor: 'c', tip }); await flush();
  assert.equal(s.changes.length, count);
});

test('subscription identifiers are opaque bounded text, not assumed UUIDs', async () => {
  const s = setup(); s.rpc.handler = call => ({ subscription_id: `${call.method}:${call.params.address ?? ''}`, tip, cursor: 'c' });
  s.live.start(); await flush(); assert.equal(s.live.registrations.size, 3);
  s.changes.length = 0; s.notify('tip'); assert.equal(s.changes.length, 1); s.live.close();
});

test('watchAddress waits for the address subscription before the caller reads history', async () => {
  const s = setup(), pending = deferred();
  s.rpc.handler = call => call.method === 'subscribeaddress' ? pending.promise : undefined;
  s.live.start(); await flush();
  let read = false;
  const watched = s.live.watchAddress('abcdefgh1').then(result => { read = true; return result; });
  await flush(); assert.equal(read, false);
  pending.resolve({ subscription_id: 'watched', tip, cursor: 'c' });
  assert.equal(await watched, true); assert.equal(read, true);
  assert.ok(s.changes.every(change => change.catchup));
  const count = s.rpc.calls.length; assert.equal(await s.live.watchAddress('abcdefgh1'), true);
  assert.equal(s.rpc.calls.length, count); s.live.close();
});

test('watchAddress handles an address discovered after a running batch snapshot', async () => {
  const s = setup(), pending = deferred(); let first = true;
  s.rpc.handler = call => {
    if (call.method === 'subscribeaddress' && first) { first = false; return pending.promise; }
  };
  s.live.start(); await flush();
  s.setAddresses(['abcdefgh1', 'abcdefgh2']);
  const watched = s.live.watchAddress('abcdefgh2');
  pending.resolve({ subscription_id: 'earlier', tip, cursor: 'c' });
  assert.equal(await watched, true);
  assert.equal(s.rpc.calls.filter(call => call.method === 'subscribeaddress').length, 2);
  assert.ok(s.live.registrations.has('address:abcdefgh2')); s.live.close();
});

test('watchAddress reports capacity without blocking forever, and rejects lock or reconnect backoff', async () => {
  const s = setup(); s.rpc.handler = call => {
    if (call.method === 'subscribeaddress') throw Object.assign(new Error('capacity'), { code: -32005 });
  };
  s.live.start(); await flush(); assert.equal(await s.live.watchAddress('abcdefgh1'), false);
  s.live.close(); await assert.rejects(s.live.watchAddress('abcdefgh1'), { name: 'AbortError' });
  const other = setup(); other.live.start(); await flush(); other.rpc.disconnect();
  await assert.rejects(other.live.watchAddress('abcdefgh1'), /reconnecting/); other.live.close();
});

test('real address notifications merged with subscription catch-ups stay real', async () => {
  const s = setup(); s.live.start(); await flush(); s.changes.length = 0;
  const pending = deferred(); s.setAddresses(['abcdefgh1', 'abcdefgh2', 'abcdefgh3']);
  s.rpc.handler = call => call.method === 'subscribeaddress' && call.params.address === 'abcdefgh3' ? pending.promise : undefined;
  s.live.updateAddresses(); await flush();
  s.notify('address:abcdefgh1');
  pending.resolve({ subscription_id: 'last', tip, cursor: 'c' }); await flush();
  assert.equal(s.changes.length, 1); assert.equal(s.changes[0].catchup, false);
  assert.equal(s.changes[0].wallet, true); s.live.close();
});
