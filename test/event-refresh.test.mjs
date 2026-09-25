import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { EventRefresh } from '../src/core/event-refresh.mjs';

async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await sleep(5);
  assert.ok(predicate(), 'event work should settle');
}

test('event refresh coalesces bursts and does not poll after success', async t => {
  let calls = 0;
  const queue = new EventRefresh({ run: async () => { calls++; }, isActive: () => true, delayMs: 5 });
  t.after(() => queue.close());
  for (let i = 0; i < 1000; i++) queue.request();
  await until(() => calls === 1 && !queue.running);
  await sleep(40);
  assert.equal(calls, 1); assert.equal(queue.timer, null);
});

test('events during an in-flight refresh produce exactly one subsequent pass', async t => {
  let calls = 0, release;
  const queue = new EventRefresh({ run: async () => { if (++calls === 1) await new Promise(resolve => { release = resolve; }); }, isActive: () => true, delayMs: 0 });
  t.after(() => queue.close());
  queue.request(); await until(() => release);
  for (let i = 0; i < 100; i++) queue.request();
  assert.equal(calls, 1); release();
  await until(() => calls === 2 && !queue.running);
  assert.equal(queue.timer, null);
});

test('only failed work retries, and successful recovery goes idle', async t => {
  let calls = 0, failures = 0;
  const queue = new EventRefresh({ run: async () => { if (++calls < 3) throw new Error('offline'); }, isActive: () => true,
    onError: () => { failures++; }, delayMs: 0, retryMs: 5, maxRetryMs: 10 });
  t.after(() => queue.close()); queue.request();
  await until(() => calls === 3 && !queue.running);
  await sleep(30); assert.equal(calls, 3); assert.equal(failures, 2); assert.equal(queue.timer, null);
});

test('close cancels queued and subsequent work, including a pending failure retry', async () => {
  let calls = 0;
  const queue = new EventRefresh({ run: async () => { calls++; throw new Error('offline'); }, isActive: () => true, delayMs: 0, retryMs: 100 });
  queue.request(); await until(() => calls === 1 && !queue.running);
  queue.close(); queue.request(); await sleep(120);
  assert.equal(calls, 1); assert.equal(queue.timer, null);
});

test('deactivated session is not refreshed and cancellation is not retried', async t => {
  let active = true, calls = 0;
  const queue = new EventRefresh({ run: async () => { calls++; throw Object.assign(new Error('locked'), { name: 'AbortError' }); }, isActive: () => active, delayMs: 5 });
  t.after(() => queue.close()); queue.request(); active = false; await sleep(20);
  assert.equal(calls, 0);
  active = true; queue.request(); await until(() => calls === 1 && !queue.running);
  assert.equal(queue.timer, null);
});
