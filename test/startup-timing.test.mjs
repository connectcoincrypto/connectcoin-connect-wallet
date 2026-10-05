import assert from 'node:assert/strict';
import test from 'node:test';
import { StartupTiming } from '../src/core/startup-timing.mjs';

function fixture() {
  let clock = 0; const rows = [];
  const timing = new StartupTiming({ record: (event, details) => rows.push({ event, ...details }), now: () => clock });
  return { timing, rows, at(value) { clock = value; } };
}

test('startup timing separates unlock, first complete snapshot and rendered acknowledgement on one clock', () => {
  const f = fixture(); assert.equal(f.timing.begin(), 1);
  f.at(15); f.timing.observe({ epoch: 2, unlocked: true, ready: false });
  f.at(260); f.timing.observe({ epoch: 2, unlocked: true, ready: true });
  f.at(310); f.timing.rendered(2);
  assert.deepEqual(f.rows, [
    { event: 'wallet.unlock_started', stage: 'lifecycle', runId: 1 },
    { event: 'wallet.unlocked', stage: 'lifecycle', runId: 1, durationMs: 15, durationScope: 'run' },
    { event: 'wallet.snapshot_ready', stage: 'refresh', runId: 1, durationMs: 260, durationScope: 'run' },
    { event: 'wallet.render_ready', stage: 'lifecycle', runId: 1, durationMs: 310, durationScope: 'run' },
  ]);
  assert.equal(f.timing.active, null);
});

test('zero elapsed time, epoch zero and a ready empty-wallet snapshot are valid', () => {
  const f = fixture(); f.timing.begin();
  f.timing.observe({ epoch: 0, unlocked: true, ready: true, balance: 0, history: [] });
  f.timing.rendered(0);
  assert.equal(f.rows.length, 4); assert.ok(f.rows.slice(1).every(row => row.durationMs === 0));
});

test('invalid epochs and booleans cannot bind or end an attempt', () => {
  const f = fixture(); f.timing.begin();
  for (const epoch of [undefined, null, -1, 1.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1]) {
    f.timing.observe({ epoch, unlocked: true, ready: true }); f.timing.rendered(epoch);
  }
  f.timing.observe({ epoch: 1, unlocked: 'yes', ready: true });
  f.timing.observe({ epoch: 1, unlocked: true, ready: 1 });
  assert.equal(f.rows.length, 1); assert.equal(f.timing.active.epoch, null);
  f.timing.observe({ epoch: Number.MAX_SAFE_INTEGER, unlocked: true, ready: true });
  f.timing.rendered(Number.MAX_SAFE_INTEGER); assert.equal(f.rows.length, 4);
});

test('old states and duplicate readiness do not cancel or double-count the current attempt', () => {
  const f = fixture(); f.timing.begin();
  f.timing.observe({ epoch: 5, unlocked: true, ready: false });
  f.timing.observe({ epoch: 4, unlocked: false, ready: false });
  f.timing.observe({ epoch: 4, unlocked: true, ready: true }); f.timing.rendered(4);
  assert.equal(f.timing.active.epoch, 5); assert.equal(f.rows.length, 2);
  f.at(100); f.timing.observe({ epoch: 5, unlocked: true, ready: true });
  f.at(200); f.timing.observe({ epoch: 5, unlocked: true, ready: true });
  f.timing.rendered(5); f.timing.rendered(5);
  assert.equal(f.rows.length, 4); assert.equal(f.rows[2].durationMs, 100);
});

test('new security epoch after binding cancels the old attempt instead of timing a different wallet', () => {
  const f = fixture(); f.timing.begin(); f.timing.observe({ epoch: 2, unlocked: true, ready: false });
  f.timing.observe({ epoch: 3, unlocked: true, ready: true }); f.timing.rendered(2); f.timing.rendered(3);
  assert.equal(f.timing.active, null); assert.equal(f.rows.length, 2);
});

test('render acknowledgement needs a bound epoch and ready snapshot, including getState delivery', () => {
  const f = fixture(); f.timing.begin(); f.timing.rendered(3);
  f.timing.observe({ epoch: 3, unlocked: true, ready: false }); f.timing.rendered(3);
  assert.equal(f.rows.length, 2);
  // Main can observe the already-ready service immediately before accepting a
  // renderer ACK, even if getState delivered it before the coalesced state push.
  f.at(150); f.timing.observe({ epoch: 3, unlocked: true, ready: true }); f.timing.rendered(3);
  assert.equal(f.rows.length, 4); assert.equal(f.rows[3].durationMs, 150);
});

test('failed password cancellation and a new attempt have independent run IDs and elapsed times', () => {
  const f = fixture(); f.timing.begin(); f.at(200); f.timing.cancel();
  f.timing.observe({ epoch: 2, unlocked: true, ready: true }); assert.equal(f.rows.length, 1);
  f.at(1000); assert.equal(f.timing.begin(), 2);
  f.at(1025); f.timing.observe({ epoch: 4, unlocked: true, ready: true }); f.at(1040); f.timing.rendered(4);
  assert.equal(f.rows.at(-1).runId, 2); assert.equal(f.rows.at(-1).durationMs, 40);
  f.timing.begin(); f.at(1200); f.timing.begin(); f.timing.observe({ epoch: 6, unlocked: true, ready: true }); f.timing.rendered(6);
  assert.equal(f.rows.at(-1).runId, 4); assert.equal(f.rows.at(-1).durationMs, 0);
});

test('locked updates during decryption do not cancel an unbound attempt', () => {
  const f = fixture(); f.timing.begin(); f.timing.observe({ epoch: 1, unlocked: false, ready: false });
  assert.equal(f.timing.active.epoch, null); assert.equal(f.rows.length, 1);
  f.at(100); f.timing.observe({ epoch: 2, unlocked: true, ready: true }); f.timing.rendered(2);
  assert.equal(f.rows.length, 4); assert.equal(f.rows.at(-1).durationMs, 100);
});

test('explicit cancellation ends an unbound attempt and current locked state cancels a bound attempt', () => {
  const f = fixture(); f.timing.begin(); f.timing.observe({ epoch: 1, unlocked: false, ready: false });
  f.timing.cancel();
  f.timing.observe({ epoch: 2, unlocked: true, ready: true }); f.timing.rendered(2);
  assert.equal(f.timing.active, null);
  f.timing.begin(); f.timing.observe({ epoch: 2, unlocked: true, ready: false });
  f.timing.observe({ epoch: 2, unlocked: false, ready: false }); f.timing.rendered(2);
  assert.equal(f.timing.active, null); assert.equal(f.rows.filter(row => row.event === 'wallet.render_ready').length, 0);
});

test('timing does not inspect, retain or record unrelated wallet or secret fields', () => {
  const f = fixture(), canary = 'PRIVATE-DO-NOT-RETAIN'; f.timing.begin();
  f.timing.observe({ epoch: 2, unlocked: true, ready: true,
    get password() { throw new Error(canary); }, mnemonic: canary, address: canary, balance: canary, history: [canary] });
  assert.deepEqual(Object.keys(f.timing.active).sort(), ['epoch', 'ready', 'runId', 'started']);
  f.timing.rendered(2);
  assert.equal(JSON.stringify(f.rows).includes(canary), false);
  assert.ok(f.rows.every(row => Object.keys(row).every(key => ['event', 'stage', 'runId', 'durationMs', 'durationScope'].includes(key))));
});

test('throwing or rejected recorders cannot control wallet measurement', async () => {
  for (const record of [() => { throw new Error('logger failure'); }, () => Promise.reject(new Error('logger failure'))]) {
    const timing = new StartupTiming({ record, now: () => 0 });
    assert.doesNotThrow(() => { timing.begin(); timing.observe({ epoch: 1, unlocked: true, ready: true }); timing.rendered(1); });
    assert.equal(timing.active, null);
  }
  await new Promise(resolve => setImmediate(resolve)); // Rejections were observed, not unhandled.
});

test('bad clocks disable an attempt and a backwards test clock never produces negative durations', () => {
  const rows = [], timing = new StartupTiming({ record: (...args) => rows.push(args), now: () => NaN });
  assert.equal(timing.begin(), null); assert.equal(timing.active, null); assert.equal(rows.length, 0);
  timing.now = () => { throw new Error('clock unavailable'); }; assert.equal(timing.begin(), null);
  const f = fixture(); f.at(100); f.timing.begin(); f.at(90); f.timing.observe({ epoch: 1, unlocked: true, ready: true }); f.timing.rendered(1);
  assert.ok(f.rows.slice(1).every(row => row.durationMs === 0));
});
