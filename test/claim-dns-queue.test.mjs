import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaimsEngine } from '../src/core/claims-engine.mjs';

const keyOf = row => `${row.txid}:${row.vout}`;
const row = vout => ({ txid: 'a'.repeat(64), vout, amount: '100000000',
  domain: `${String.fromCharCode(97 + vout)}.example`, status: 'available',
  connection_work_target: `0001${'f'.repeat(60)}`, signature_algorithms_mask: 6,
  root_certificates_version: 1 });
async function settle() { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); }

function fixture(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1800000000000 });
  const pending = new Map(), resolutions = [], requests = [];
  let peakResolutions = 0;
  const pool = { pacesStarts: true, async start() {}, async close() {},
    resolve(domain, { signal }) {
      resolutions.push(domain);
      return new Promise((resolve, reject) => {
        const finish = error => {
          if (!pending.has(domain)) return;
          pending.delete(domain); signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };
        const abort = () => finish(Object.assign(new Error('Controlled DNS cancellation'), { name: 'AbortError' }));
        pending.set(domain, finish); peakResolutions = Math.max(peakResolutions, pending.size);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
    },
    attempt(context, callbacks) {
      return new Promise(resolve => {
        const request = { context, settled: false };
        request.finish = () => {
          if (request.settled) return;
          request.settled = true; callbacks.signal.removeEventListener('abort', request.finish);
          const result = { started: true, captured: false, cancelled: true, validationPassed: null,
            seconds: 0.01, proof: null, verified: false };
          callbacks.onCapture(result); callbacks.onResult(result); resolve(result);
        };
        requests.push(request); callbacks.onStarted();
        if (callbacks.signal.aborted) request.finish();
        else callbacks.signal.addEventListener('abort', request.finish, { once: true });
      });
    },
  };
  const engine = new ClaimsEngine({ isUnlocked: () => true, randomIndex: () => 0,
    poolFactory: () => pool, getNetReward: () => 75283000n,
    options: { connectionsPerSecond: 100, concurrency: 2 },
    submit: async () => assert.fail('DNS queue tests must not submit a claim'),
    prepare: async bounty => ({ bounty, payout: '75283000', context: {
      domain: bounty.domain, txid: 'b'.repeat(64), input_index: 0,
      connection_work_target: bounty.connection_work_target, signature_algorithms_mask: 6,
      root_certificates_version: 1, validation_time: 1800000000,
    } }),
  });
  t.after(() => engine.stop());
  return { engine, pending, resolutions, requests, get peakResolutions() { return peakResolutions; } };
}

for (const invalidation of ['remove', 'retire']) {
  test(`${invalidation} of awakened DNS candidates cannot strand remaining domains`, async t => {
    const f = fixture(t), { engine } = f, rows = Array.from({ length: 6 }, (_, i) => row(i));
    engine.enqueue(rows); engine.start(); await settle();
    assert.deepEqual(f.resolutions, ['a.example', 'b.example']);
    assert.deepEqual([...engine.waitingDns], ['c.example', 'd.example', 'e.example', 'f.example']);
    for (const finish of [...f.pending.values()]) finish();
    await settle();
    assert.equal(engine.connections.size, 2, 'live captures delay admission of the woken domains');
    assert.equal(engine.resolving.size, 0);
    for (const bounty of rows.slice(0, 4)) engine[invalidation](bounty.txid, bounty.vout);
    if (invalidation === 'retire') for (const request of f.requests) request.finish();
    await settle();
    assert.deepEqual(f.resolutions, ['a.example', 'b.example', 'e.example', 'f.example'],
      'free DNS slots must progress without another completion to wake parked domains');
    assert.equal(engine.resolving.size, 2); assert.equal(f.peakResolutions, 2);
    for (let repeat = 0; repeat < 3; repeat++) {
      engine.retainCatalog(rows.slice(4)); engine.enqueue(rows.slice(4)); engine.resume();
      t.mock.timers.tick(5000); await settle();
    }
    assert.equal(f.resolutions.length, 4, 'catalog refresh must not duplicate live resolutions');
    for (const finish of [...f.pending.values()]) finish();
    await settle();
    assert.equal(engine.connections.size, 2); assert.equal(engine.resolving.size, 0);
    assert.equal(f.peakResolutions, 2);
    assert.equal(engine.snapshot().attempts, f.requests.length, 'only actual socket starts count');
    assert.ok(rows.every(bounty => !engine.successCounts.has(keyOf(bounty))));
  });
}

test('reopening DNS capacity preserves failed-resolution retry deadlines and cancellation', async t => {
  const f = fixture(t), { engine } = f, rows = [row(0), row(1), row(2)];
  engine.enqueue(rows); engine.start(); await settle();
  for (const finish of [...f.pending.values()]) finish(new Error('Controlled DNS failure'));
  await settle();
  assert.deepEqual(f.resolutions, ['a.example', 'b.example', 'c.example']);
  assert.equal(engine.dns.get('a.example').expires, Date.now() + 2000);
  assert.equal(engine.dns.get('b.example').expires, Date.now() + 2000);
  t.mock.timers.tick(1999); await settle();
  assert.equal(f.resolutions.length, 3);
  t.mock.timers.tick(1); await settle();
  assert.equal(f.resolutions.length, 4, 'one free resolution slot retries at the original deadline');
  assert.equal(engine.resolving.size, 2); assert.equal(f.peakResolutions, 2);
  await engine.stop(); t.mock.timers.tick(60000); await settle();
  assert.equal(f.pending.size, 0); assert.equal(engine.resolving.size, 0);
  assert.equal(engine.waitingDns.size, 0); assert.equal(f.resolutions.length, 4);
  assert.equal(engine.snapshot().attempts, 0);
});
