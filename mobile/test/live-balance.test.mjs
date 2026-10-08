import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBalance } from '../src/live-balance.mjs';
import { MAINNET_GENESIS, validateTip } from '../src/model.mjs';

// Local promises and a monotonic fake clock only. No RPC, bridge or live wallet.
const ADDRESS = 'test-account-one', OTHER = 'test-account-two';
const tip = (height = 200) => ({ chain: 'main', genesis_hash: MAINNET_GENESIS, height,
  hash: height.toString(16).padStart(64, '0'), mediantime: 1700000000 + height });
const tick = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let time = 0, sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    get count() { return timers.size; },
    async advance(ms) {
      const until = time + ms;
      let count = 0;
      for (;;) {
        const next = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0];
        if (!next || next[1].at > until) break;
        assert.ok(++count <= 1000, 'Unexpected busy-loop in the event scheduler');
        time = next[1].at; timers.delete(next[0]); next[1].callback(); await tick();
      }
      time = until; await tick();
    },
  };
}
function fixture({ loaded = true, outcomes = [] } = {}) {
  const timer = clock(), calls = [], published = [], observed = [];
  let permitted = true, emissions = 0;
  const state = address => ({ address, tip: loaded ? { height: 200 } : null, busy: false, stale: false });
  const session = {
    state: state(ADDRESS), generation: 0, pendingRefreshes: 0, active: true, connected: true,
    confirmationsStale: false,
    historyNeedsBaseline() { return this.confirmationsStale && this.state.historyStale; },
    invalidate() { this.generation++; this.state.busy = false; this.state.stale = true; return Promise.resolve(); },
    disconnectWatch() { void this.invalidate(); this.emit(); },
    observeTip(value, { reset = false } = {}) {
      const block = validateTip(value); observed.push(block);
      if (reset) void this.invalidate();
      this.emit(); return reset;
    },
    emit() { emissions++; },
    async refresh(options) {
      const generation = ++this.generation, address = this.state.address;
      this.pendingRefreshes++; this.state.busy = true;
      calls.push({ address, options: { ...options }, at: timer.now() });
      try {
        const result = await (outcomes.length ? outcomes.shift() : true);
        if (result instanceof Error) throw result;
        if (generation !== this.generation || !this.active || !this.connected) return false;
        if (result) {
          this.state.stale = false; this.state.tip ??= { height: 200 }; published.push(address);
          if (options.reloadLoaded) { this.confirmationsStale = false; this.state.historyStale = false; }
        }
        return result;
      } finally {
        this.pendingRefreshes--;
        if (generation === this.generation) this.state.busy = false;
      }
    },
  };
  const live = new LiveBalance({ session, allowed: () => permitted, now: timer.now,
    setTimer: timer.setTimer, clearTimer: timer.clearTimer });
  return { live, session, timer, calls, published, observed,
    notify: (reason, address = session.state.address) => live.notify({ reason, address }),
    allow(value) { permitted = value; },
    switchAccount(address) { void session.invalidate(); session.state = state(address); live.sync(); },
    get emissions() { return emissions; },
  };
}

test('a connected subscription catches up once and does not poll an unchanged account', async () => {
  for (const loaded of [true, false]) {
    const f = fixture({ loaded });
    f.notify('connected');
    assert.equal(f.calls.length, 0);
    await f.timer.advance(249);
    assert.equal(f.calls.length, 0);
    await f.timer.advance(1);
    assert.deepEqual(f.calls, [{ address: ADDRESS, options: { reloadLoaded: true }, at: 250 }]);
    assert.deepEqual(f.published, [ADDRESS]);
    assert.equal(f.timer.count, 0);
    await f.timer.advance(600_000);
    assert.equal(f.calls.length, 1);
    assert.equal(f.timer.count, 0);
  }
});

test('explicit startup refresh works before a subscription ACK and does not create idle polling', async () => {
  for (const loaded of [true, false]) {
    const f = fixture({ loaded });
    f.live.request();
    assert.equal(f.live.connected, false);
    await f.timer.advance(249);
    assert.equal(f.calls.length, 0);
    await f.timer.advance(1);
    assert.deepEqual(f.calls, [{ address: ADDRESS, options: { balanceOnly: true }, at: 250 }]);
    assert.deepEqual(f.published, [ADDRESS]);
    assert.equal(f.live.connected, false);
    assert.equal(f.timer.count, 0);
    for (let index = 0; index < 20; index++) f.notify('disconnected');
    await f.timer.advance(600_000);
    assert.equal(f.calls.length, 1);
    assert.equal(f.timer.count, 0);
    assert.equal(f.session.state.stale, false);
  }
});

test('older registration tips still require validation and explicit reset flags remain effective', async () => {
  for (const patch of [{}, { reorg: true }, { resync_required: true }, { tip: { ...tip(), chain: 'testnet4' } }]) {
    const f = fixture(); f.session.displayTip = tip(201);
    f.live.notify({ address: ADDRESS, reason: 'connected', tip: tip(200), ...patch });
    const invalid = patch.tip?.chain === 'testnet4', reset = patch.reorg || patch.resync_required;
    assert.equal(f.live.dirty, !invalid);
    assert.equal(f.session.generation, reset ? 1 : 0);
    assert.equal(f.observed.length, reset ? 1 : 0);
    await f.timer.advance(250);
    assert.equal(f.calls.length, invalid ? 0 : 1);
  }
});

test('startup read failures retry once after sixty seconds without waiting for subscription registration', async () => {
  for (const failure of [false, new Error('Startup RPC unavailable')]) {
    const f = fixture({ loaded: false, outcomes: [failure, true] });
    f.live.request(); await f.timer.advance(250);
    assert.equal(f.calls.length, 1);
    assert.equal(f.live.connected, false);
    for (let index = 0; index < 20; index++) {
      f.notify('address', OTHER); f.notify('tip', OTHER); f.notify('disconnected');
    }
    await f.timer.advance(59_999);
    assert.equal(f.calls.length, 1);
    await f.timer.advance(1);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.published, [ADDRESS]);
    assert.equal(f.live.connected, false);
    assert.equal(f.timer.count, 0);
    await f.timer.advance(600_000);
    assert.equal(f.calls.length, 2);
  }
});

test('unrelated accounts, unsupported notifications and initial disconnect cannot trigger reads', async () => {
  const f = fixture();
  for (const event of [null, {}, { reason: 'connected', address: OTHER }, { reason: 'balance', address: ADDRESS },
    { reason: 'tip', address: ADDRESS }]) f.live.notify(event);
  f.notify('address', OTHER); f.notify('tip', OTHER); f.notify('disconnected');
  await f.timer.advance(100_000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timer.count, 0);
  assert.equal(f.live.dirty, false);
  assert.equal(f.session.generation, 0);
  assert.equal(f.session.state.stale, false);
  f.notify('connected');
  await f.timer.advance(250);
  assert.equal(f.calls.length, 1);
});

test('a native validated own-address hint recovers a missed connected notification at startup or resume', async () => {
  const f = fixture();
  // The bridge emits address hints only after its changes-only subscription
  // was acknowledged. An address hint can recover a missed connected delivery.
  f.notify('address');
  assert.equal(f.live.connected, true);
  await f.timer.advance(250);
  assert.equal(f.calls.length, 1);
  f.live.pause(); f.session.active = false; void f.session.invalidate();
  assert.equal(f.live.connected, false);
  await f.timer.advance(5000);
  assert.equal(f.calls.length, 1);
  f.session.active = true;
  f.notify('address');
  assert.equal(f.live.connected, true);
  await f.timer.advance(250);
  assert.equal(f.calls.length, 2);
  assert.equal(f.session.state.stale, false);
  assert.equal(f.timer.count, 0);
  await f.timer.advance(600_000);
  assert.equal(f.calls.length, 2);
});

test('one hundred tip events for the connected account cause no balance reads or delayed polling', async () => {
  const f = fixture();
  f.notify('connected'); await f.timer.advance(250);
  assert.equal(f.calls.length, 1);
  const generation = f.session.generation;
  for (let index = 0; index < 100; index++) f.notify('tip');
  assert.equal(f.live.connected, true);
  assert.equal(f.live.dirty, false);
  assert.equal(f.timer.count, 0);
  await f.timer.advance(600_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.session.generation, generation);
  assert.equal(f.session.state.stale, false);
  // An actual change to this same address still schedules a fresh snapshot.
  f.notify('address'); await f.timer.advance(250);
  assert.equal(f.calls.length, 2);
  assert.equal(f.timer.count, 0);
});

test('own-address bursts coalesce into one read and preserve the two-second minimum between reads', async () => {
  const f = fixture();
  f.notify('connected');
  for (let index = 0; index < 100; index++) f.notify('address');
  assert.equal(f.timer.count, 1);
  await f.timer.advance(250);
  assert.equal(f.calls.length, 1);
  for (let index = 0; index < 100; index++) f.notify('address');
  assert.equal(f.timer.count, 1);
  await f.timer.advance(1999);
  assert.equal(f.calls.length, 1);
  await f.timer.advance(1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].at, 2250);
  assert.equal(f.timer.count, 0);
});

test('events arriving during a read remain dirty for exactly one non-overlapping follow-up', async () => {
  const gate = deferred();
  const f = fixture({ outcomes: [gate.promise, true] });
  f.notify('connected');
  await f.timer.advance(250);
  assert.equal(f.calls.length, 1);
  assert.equal(f.session.pendingRefreshes, 1);
  for (let index = 0; index < 50; index++) f.notify('address');
  await f.timer.advance(5000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timer.count, 0);
  gate.resolve(true); await tick();
  assert.equal(f.session.pendingRefreshes, 0);
  assert.equal(f.timer.count, 1);
  await f.timer.advance(1999);
  assert.equal(f.calls.length, 1);
  await f.timer.advance(1);
  assert.equal(f.calls.length, 2);
  await f.timer.advance(60_000);
  assert.equal(f.calls.length, 2);
});

test('tip events received during an in-flight snapshot cannot queue a follow-up read', async () => {
  const gate = deferred();
  const f = fixture({ outcomes: [gate.promise] });
  f.notify('connected'); await f.timer.advance(250);
  assert.equal(f.calls.length, 1);
  assert.equal(f.session.pendingRefreshes, 1);
  for (let index = 0; index < 100; index++) f.notify('tip');
  assert.equal(f.live.dirty, false);
  gate.resolve(true); await tick();
  assert.equal(f.session.pendingRefreshes, 0);
  assert.equal(f.timer.count, 0);
  await f.timer.advance(600_000);
  assert.equal(f.calls.length, 1);
});

test('invalidated external reads stay physically pending and prevent another request', async () => {
  const f = fixture();
  f.session.pendingRefreshes = 1; f.session.state.busy = true;
  void f.session.invalidate();
  assert.equal(f.session.state.busy, false);
  f.notify('connected');
  await f.timer.advance(2500);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timer.count, 1);
  f.session.pendingRefreshes = 0;
  await f.timer.advance(500);
  assert.equal(f.calls.length, 1);
  assert.equal(f.session.pendingRefreshes, 0);
  assert.equal(f.timer.count, 0);
});

test('background, offline and native-busy states suppress reads but retain an event for explicit wake', async () => {
  for (const blocked of ['background', 'offline', 'native-busy']) {
    const f = fixture();
    if (blocked === 'background') f.session.active = false;
    if (blocked === 'offline') f.session.connected = false;
    if (blocked === 'native-busy') f.allow(false);
    f.notify('connected');
    await f.timer.advance(60_000);
    assert.equal(f.calls.length, 0);
    assert.equal(f.timer.count, 0);
    f.session.active = true; f.session.connected = true; f.allow(true); f.live.wake();
    await f.timer.advance(250);
    assert.equal(f.calls.length, 1);
    assert.equal(f.timer.count, 0);
  }
});

test('a block arising after a scheduled event prevents the request at timer execution', async () => {
  const f = fixture();
  f.notify('connected');
  f.allow(false);
  await f.timer.advance(5000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timer.count, 0);
  f.allow(true); f.live.wake();
  await f.timer.advance(250);
  assert.equal(f.calls.length, 1);
});

test('failed and throwing reads retry after sixty seconds rather than spinning or obeying every event', async () => {
  for (const failure of [false, new Error('Transient RPC failure')]) {
    const f = fixture({ outcomes: [failure, true] });
    f.notify('connected'); await f.timer.advance(250);
    assert.equal(f.calls.length, 1);
    assert.equal(f.timer.count, 1);
    for (let index = 0; index < 100; index++) f.notify('address');
    await f.timer.advance(59_999);
    assert.equal(f.calls.length, 1);
    await f.timer.advance(1);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].at, 60_250);
    assert.equal(f.timer.count, 0);
    await f.timer.advance(600_000);
    assert.equal(f.calls.length, 2);
  }
});

test('account switching rejects old subscription events and does not apply old read completion to the new account', async () => {
  const gate = deferred();
  const f = fixture({ outcomes: [gate.promise, true] });
  f.notify('connected'); await f.timer.advance(250);
  f.switchAccount(OTHER);
  f.notify('connected', ADDRESS); f.notify('address', ADDRESS); f.notify('disconnected', ADDRESS);
  assert.equal(f.live.connected, false);
  f.notify('connected', OTHER);
  await f.timer.advance(10_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.session.pendingRefreshes, 1);
  gate.resolve(true); await tick();
  assert.deepEqual(f.published, []);
  await f.timer.advance(250);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].address, OTHER);
  assert.deepEqual(f.published, [OTHER]);
  assert.equal(f.timer.count, 0);
});

test('pause cancels queued work and an explicit resume refresh does not wait for subscription reconnection', async () => {
  const f = fixture();
  f.live.request();
  f.live.pause(); f.session.active = false; void f.session.invalidate();
  assert.equal(f.timer.count, 0);
  await f.timer.advance(10_000);
  assert.equal(f.calls.length, 0);
  f.session.active = true; f.live.request();
  assert.equal(f.live.connected, false);
  await f.timer.advance(250);
  assert.equal(f.calls.length, 1);
  assert.equal(f.session.state.stale, false);
  assert.equal(f.live.connected, false);
  assert.equal(f.timer.count, 0);
});

test('an established subscription disconnect invalidates an in-flight snapshot and queues one bounded catch-up', async () => {
  const gate = deferred();
  const f = fixture({ outcomes: [gate.promise, true] });
  f.notify('connected'); await f.timer.advance(250);
  const generation = f.session.generation;
  f.notify('disconnected');
  assert.equal(f.session.generation, generation + 1);
  assert.equal(f.session.state.stale, true);
  assert.equal(f.session.state.busy, false);
  assert.equal(f.session.pendingRefreshes, 1);
  assert.equal(f.emissions, 1);
  assert.equal(f.live.connected, false);
  gate.resolve(true); await tick();
  assert.deepEqual(f.published, []);
  assert.equal(f.session.pendingRefreshes, 0);
  assert.equal(f.timer.count, 1);
  for (let index = 0; index < 20; index++) f.notify('disconnected');
  await f.timer.advance(1999);
  assert.equal(f.calls.length, 1);
  await f.timer.advance(1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.session.state.stale, false);
  assert.deepEqual(f.published, [ADDRESS]);
  assert.deepEqual(f.calls.map(call => call.options), [{ reloadLoaded: true }, { reloadLoaded: true }]);
  assert.equal(f.timer.count, 0);
  for (let index = 0; index < 20; index++) f.notify('disconnected');
  await f.timer.advance(600_000);
  assert.equal(f.calls.length, 2);
});

test('failed registration cannot invalidate a separate startup or manual query before the first ACK', async () => {
  const gate = deferred();
  const f = fixture({ outcomes: [gate.promise] });
  f.session.state.balance = { available_confirmed: '10000000000' };
  const work = f.session.refresh({ balanceOnly: true });
  const generation = f.session.generation;
  for (let index = 0; index < 20; index++) f.notify('disconnected');
  assert.equal(f.session.generation, generation);
  assert.equal(f.session.pendingRefreshes, 1);
  assert.equal(f.session.state.busy, true);
  assert.equal(f.session.state.stale, false);
  assert.deepEqual(f.session.state.balance, { available_confirmed: '10000000000' });
  assert.equal(f.timer.count, 0);
  gate.resolve(true);
  assert.equal(await work, true);
  assert.deepEqual(f.published, [ADDRESS]);
  assert.equal(f.session.pendingRefreshes, 0);
  await f.timer.advance(600_000);
  assert.equal(f.calls.length, 1);
});

test('explicit startup requests still respect lifecycle and physically pending queries without an ACK', async () => {
  for (const blocked of ['background', 'offline', 'native-busy', 'pending-query']) {
    const f = fixture();
    if (blocked === 'background') f.session.active = false;
    if (blocked === 'offline') f.session.connected = false;
    if (blocked === 'native-busy') f.allow(false);
    if (blocked === 'pending-query') { f.session.pendingRefreshes = 1; void f.session.invalidate(); }
    f.live.request();
    await f.timer.advance(1000);
    assert.equal(f.calls.length, 0);
    assert.equal(f.live.connected, false);
    f.session.active = true; f.session.connected = true; f.allow(true); f.session.pendingRefreshes = 0;
    f.live.wake(); await f.timer.advance(500);
    assert.equal(f.calls.length, 1);
    assert.equal(f.timer.count, 0);
  }
});

test('clearing the account cancels queued notifications and does not restore it', async () => {
  const f = fixture();
  f.notify('connected'); f.switchAccount('');
  f.notify('connected', ADDRESS); f.live.request(); f.live.wake();
  await f.timer.advance(600_000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timer.count, 0);
  assert.equal(f.session.state.address, '');
});

test('validated tip hints project display metadata without scheduling any account reads', async () => {
  const f = fixture();
  f.notify('connected'); await f.timer.advance(250);
  const generation = f.session.generation;
  for (let height = 201; height <= 300; height++) f.live.notify({ reason: 'tip', address: ADDRESS, tip: tip(height) });
  assert.equal(f.observed.length, 100);
  assert.deepEqual(f.observed.at(-1), tip(300));
  assert.equal(f.session.generation, generation);
  assert.equal(f.live.dirty, false);
  assert.equal(f.timer.count, 0);
  await f.timer.advance(600_000);
  assert.equal(f.calls.length, 1);
});

test('wrong-network, malformed tips and non-boolean reset flags cannot trigger reads or projection', async () => {
  const f = fixture();
  for (const event of [
    { tip: { ...tip(), chain: 'testnet4' } },
    { tip: { ...tip(), genesis_hash: '0'.repeat(64) } },
    { tip: { ...tip(), height: -1 } },
    { tip: { ...tip(), hash: 'invalid' } },
    { tip: tip(), reorg: 'true' },
    { tip: tip(), resync_required: 1 },
  ]) f.live.notify({ reason: 'tip', address: ADDRESS, ...event });
  await f.timer.advance(600_000);
  assert.deepEqual(f.observed, []);
  assert.equal(f.calls.length, 0);
  assert.equal(f.emissions, 0);
  assert.equal(f.session.generation, 0);
  assert.equal(f.timer.count, 0);
});

test('reorg hints request a full catch-up while later ordinary tips do not add another one', async () => {
  const gate = deferred();
  const f = fixture({ outcomes: [true, gate.promise] });
  f.notify('connected'); await f.timer.advance(250);
  f.live.notify({ reason: 'tip', address: ADDRESS, tip: tip(190), reorg: true });
  assert.equal(f.session.state.stale, true);
  await f.timer.advance(2000);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].options, { reloadLoaded: true });
  const generation = f.session.generation;
  for (let height = 191; height <= 205; height++) f.live.notify({ reason: 'tip', address: ADDRESS, tip: tip(height) });
  assert.equal(f.session.generation, generation);
  assert.equal(f.live.dirty, false);
  gate.resolve(true); await tick();
  await f.timer.advance(600_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.timer.count, 0);
});

test('successful balance-only reads that detect a history reset queue exactly one full replacement baseline', async () => {
  const gate = deferred();
  const f = fixture({ outcomes: [gate.promise, true] });
  f.live.request(); await f.timer.advance(250);
  assert.deepEqual(f.calls[0].options, { balanceOnly: true });
  // Simulate a verified balance snapshot discovering a same-height replacement.
  f.session.confirmationsStale = true; f.session.state.historyStale = true;
  gate.resolve(true); await tick();
  assert.equal(f.live.dirty, true);
  assert.equal(f.timer.count, 1);
  await f.timer.advance(1999);
  assert.equal(f.calls.length, 1);
  await f.timer.advance(1);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].options, { reloadLoaded: true });
  assert.equal(f.session.historyNeedsBaseline(), false);
  assert.equal(f.live.dirty, false);
  assert.equal(f.timer.count, 0);
  await f.timer.advance(600_000);
  assert.equal(f.calls.length, 2);
});
