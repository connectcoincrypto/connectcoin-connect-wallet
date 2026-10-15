import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaimsEngine } from '../src/core/claims-engine.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const bounty = { txid: 'a'.repeat(64), vout: 0, amount: '1000000000', domain: 'example.com', status: 'available',
  connection_work_target: 'f'.repeat(64), root_certificates_version: 1, signature_algorithms_mask: 7 };
const context = { domain: bounty.domain, txid: 'b'.repeat(64), input_index: 0,
  connection_work_target: bounty.connection_work_target, root_certificates_version: 1, signature_algorithms_mask: 7, validation_time: 1800000000 };

test('catalog pause propagates immediately to the existing native admission gate without cancelling started work', async t => {
  const gates = [], result = deferred(); let callbacks;
  const pool = { pacesStarts: true, setAdmissionAllowed: async allowed => { gates.push(allowed); },
    attempt: (_context, options) => { callbacks = options; return result.promise; }, async close() {} };
  const engine = new ClaimsEngine({ prepare: async () => ({ context }), submit: async () => {}, isUnlocked: () => true, randomIndex: () => 0 });
  engine.kick = () => {}; engine.enqueue([bounty]); engine.enabled = true; engine.pool = pool;
  const job = engine.queue.get(`${bounty.txid}:0`); job.prepared = { context }; engine.updatePriority(job);
  t.after(async () => { result.resolve({ started: true, captured: false, proof: null, verified: false, seconds: 0, cancelled: true, validationPassed: null }); await engine.stop(); });
  engine.dispatch([`${bounty.txid}:0`, job], engine.generation); await tick(); callbacks.onStarted();
  engine.setCatalogBlocked(true); assert.deepEqual(gates, [false]); assert.equal(callbacks.signal.aborted, false);
  assert.strictEqual(engine.pool, pool); assert.equal(engine.state.attempts, 1);
  engine.setCatalogBlocked(false); assert.deepEqual(gates, [false, true]);
});

test('catalog pause during helper startup is applied before any pending capture dispatch', async t => {
  const started = deferred(), gates = [];
  const pool = { start: () => started.promise, setAdmissionAllowed: async allowed => { gates.push(allowed); }, async close() {},
    attempt() { throw new Error('No capture should run while catalog is blocked'); } };
  const engine = new ClaimsEngine({ prepare: async () => ({ context }), submit: async () => {}, isUnlocked: () => true, poolFactory: () => pool });
  t.after(() => engine.stop());
  engine.enabled = true; const pump = engine.pump(engine.generation); engine.setCatalogBlocked(true);
  started.resolve(); await pump;
  assert.ok(gates.length > 0 && gates.every(allowed => allowed === false));
  assert.equal(engine.connections.size, 0); assert.equal(engine.catalogBlocked, true);
});

test('admission ACK failure stops only the pool and generation which requested it', async t => {
  for (const obsolete of [false, true]) {
    let reject; const gate = new Promise((_resolve, failed) => { reject = failed; });
    const pool = { setAdmissionAllowed: () => gate, async close() {} };
    const engine = new ClaimsEngine({ prepare: async () => ({}), submit: async () => {}, isUnlocked: () => true });
    engine.kick = () => {}; engine.enabled = true; engine.pool = pool;
    engine.setCatalogBlocked(true);
    if (obsolete) { engine.generation++; engine.pool = { async close() {} }; }
    reject(new Error('Gate acknowledgement failed')); await tick();
    assert.equal(engine.enabled, obsolete);
    await engine.stop();
  }
});

function softGateFixture(t) {
  const gates = [], captures = [], sends = [], preparations = [];
  const candidate = { ...bounty, connection_work_target: '00000' + 'f'.repeat(59) };
  const prepared = { context: { ...context, connection_work_target: candidate.connection_work_target } };
  const key = `${candidate.txid}:0`;
  const pool = { pacesStarts: true, setAdmissionAllowed: async allowed => { gates.push(allowed); },
    attempt: (claimContext, callbacks) => {
      const pending = deferred(); captures.push({ claimContext, callbacks, ...pending });
      callbacks.signal.addEventListener('abort', () => pending.resolve({ started: false, captured: false,
        verified: false, proof: null, cancelled: true, seconds: 0, validationPassed: null }), { once: true });
      return pending.promise;
    }, async close() {} };
  const engine = new ClaimsEngine({ prepare: async row => { preparations.push(row); return prepared; },
    submit: async (proposal, proof) => { sends.push({ proposal, proof }); return 'c'.repeat(64); },
    isUnlocked: () => true, randomIndex: () => 0, options: { connectionsPerSecond: 100, concurrency: 1 } });
  engine.kick = () => {}; engine.enqueue([candidate, { ...candidate, txid: 'd'.repeat(64), amount: '2000000000' }]);
  engine.enabled = true; engine.pool = pool; engine.beginDiagnosticRun();
  const job = engine.queue.get(key); job.prepared = prepared; engine.proposals.set(key, prepared); engine.updatePriority(job);
  engine.dns.set(candidate.domain, { ok: true, expires: Date.now() + 3600000 });
  t.after(() => engine.stop());
  const complete = async (capture, { winner = false, successfulConnections = 1 } = {}) => {
    capture.callbacks.onStarted();
    const result = { started: true, captured: true, proof: winner ? '02aa' : null, verified: winner,
      seconds: 0.1, cancelled: false, validationPassed: true, successfulConnections: String(successfulConnections) };
    capture.callbacks.onCapture(result); capture.callbacks.onResult(result); capture.resolve(result);
    await engine.running;
  };
  return { engine, key, job, prepared, captures, gates, sends, preparations, complete };
}

test('95-second catalog resync keeps prepared captures alive, retains winners, and sends/counts only once after release', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const f = softGateFixture(t), { engine } = f;
  const generation = engine.generation, runId = engine.diagnosticRun.runId;
  engine.setCatalogBlocked(true, { allowPreparedCaptures: true });
  for (let n = 1; n <= 4; n++) {
    if (n === 2) t.mock.timers.tick(95000);
    await engine.pump(generation); await tick();
    assert.equal(f.captures.length, n);
    await f.complete(f.captures.at(-1), { winner: n === 4, successfulConnections: n });
  }
  assert.equal(f.preparations.length, 0, 'unprepared higher-reward job cannot prepare during resync');
  assert.equal(f.sends.length, 0);
  assert.equal(engine.pendingProofs.get(f.key).proof, '02aa');
  assert.strictEqual(engine.proposals.get(f.key), f.prepared);
  assert.equal(engine.generation, generation); assert.equal(engine.diagnosticRun.runId, runId);
  assert.equal(engine.state.attempts, 4); assert.equal(engine.state.completed, 0);
  assert.equal(engine.successCounts.get(f.key), 4n);
  assert.equal(engine.nextProofDue(), Infinity);
  await engine.pump(generation);
  assert.equal(engine.timer, null, 'blocked submissions and unprepared jobs must not cause busy polling');
  assert.ok(f.gates.every(Boolean), 'prepared native admissions remain open throughout the scan');
  engine.setCatalogBlocked(false); engine.retrySubmissions(generation); await engine.running;
  engine.retrySubmissions(generation); await engine.running;
  assert.equal(f.sends.length, 1); assert.strictEqual(f.sends[0].proposal, f.prepared);
  assert.equal(f.sends[0].proof, '02aa'); assert.equal(engine.state.completed, 1);
  assert.equal(engine.state.attempts, 4); assert.equal(engine.pendingProofs.has(f.key), false);
  const counters = engine.diagnosticSnapshot();
  assert.equal(counters.captures, 4); assert.equal(counters.completed, 1);
  assert.equal(counters.operationsStarted, 5); assert.equal(counters.operationsCompleted, 5);
  assert.equal(counters.operationsFailed, 0); assert.equal(counters.operationsCancelled, 0);
  assert.equal(engine.nextReady()[0], 'd'.repeat(64) + ':0', 'release makes unprepared work eligible again');
});

test('soft catalog gate cannot bypass a later hard admission gate', async t => {
  const f = softGateFixture(t), { engine } = f;
  engine.setCatalogBlocked(true, { allowPreparedCaptures: true }); await engine.pump(engine.generation); await tick();
  const capture = f.captures[0]; capture.callbacks.onStarted();
  engine.setCatalogBlocked(true); await engine.pump(engine.generation);
  assert.equal(f.gates.at(-1), false); assert.equal(f.captures.length, 1);
  assert.equal(capture.callbacks.signal.aborted, false, 'already started work is not discarded');
});

test('known spend/reorg removal during resync cancels obsolete work and never submits a late winner', async t => {
  const f = softGateFixture(t), { engine } = f;
  engine.setCatalogBlocked(true, { allowPreparedCaptures: true }); await engine.pump(engine.generation); await tick();
  const capture = f.captures[0]; capture.callbacks.onStarted();
  engine.remove(bounty.txid, 0); await engine.running;
  assert.equal(capture.callbacks.signal.aborted, true);
  engine.setCatalogBlocked(false); engine.retrySubmissions(engine.generation); await engine.running;
  assert.equal(f.sends.length, 0); assert.equal(engine.pendingProofs.has(f.key), false);
  assert.equal(engine.state.attempts, 1); assert.equal(engine.state.completed, 0);
  assert.equal(engine.diagnosticSnapshot().operationsCancelled, 1);
});

for (const action of ['stop', 'locked', 'suspend']) test(`${action} during soft resync retains an already verified winner and prevents submission`, async t => {
  const f = softGateFixture(t), { engine } = f;
  engine.setCatalogBlocked(true, { allowPreparedCaptures: true }); await engine.pump(engine.generation); await tick();
  await f.complete(f.captures[0], { winner: true });
  const proof = engine.pendingProofs.get(f.key);
  if (action === 'suspend') await engine.suspend(); else await engine.stop(action);
  engine.setCatalogBlocked(false); engine.retrySubmissions(engine.generation); await engine.running;
  assert.strictEqual(engine.pendingProofs.get(f.key), proof); assert.strictEqual(engine.proposals.get(f.key), f.prepared);
  assert.equal(f.sends.length, 0); assert.equal(engine.state.attempts, 1); assert.equal(engine.state.completed, 0);
});
