import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ConnectionPool, validateConnectionOptions } from '../src/core/claim-pool.mjs';
import { diagnosticError } from '../src/core/diagnostics.mjs';

const context = (domain = 'example.com') => ({ domain, txid: '01'.repeat(32), input_index: 0,
  connection_work_target: 'f'.repeat(64), root_certificates_version: 1, signature_algorithms_mask: 7, validation_time: 1800000000 });
const bountyId = `${'02'.repeat(32)}:0`;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, onCommand = () => {}, options = {}) {
  const commands = [], children = [], spawns = [];
  const spawnProcess = (command, args, opts) => {
    spawns.push({ command, args, options: opts });
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); return true; };
    child.send = value => child.stdout.write(JSON.stringify(value) + '\n');
    let buffer = '';
    child.stdin.on('data', data => {
      buffer += data.toString(); let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        commands.push(message);
        if (message.type === 'start') {
          if (options.autoReady !== false) queueMicrotask(() => child.send({ type: 'ready', protocol: 3, roots: 1 }));
        }
        else if (message.type === 'shutdown') setImmediate(() => child.emit('close', 0));
        else onCommand(message, child);
      }
    });
    children.push(child); return child;
  };
  const pool = new ConnectionPool({ helper: { command: 'isolated-protocol3-helper', args: ['mock'] }, spawnProcess, ...options });
  t.after(() => pool.close());
  return { pool, commands, children, spawns };
}

function observation(command, overrides = {}) {
  return { id: command.id, context: command.context, started: true, captured: true, seconds: 0.1,
    cancelled: false, successfulConnections: (BigInt(command.successfulConnections) + 1n).toString(), ...overrides };
}
function complete(command, child, overrides = {}) {
  const value = observation(command, overrides);
  child.send({ type: 'started', id: command.id });
  child.send({ type: 'capture', ...value });
  child.send({ type: 'attempt', ...value, proof: '020100', verified: true });
}

test('connection-only settings reject lifetime batch options and invalid global limits', () => {
  assert.deepEqual(validateConnectionOptions(), { connectionsPerSecond: 100, concurrency: 100 });
  for (const input of [null, [], { maxAttempts: 1 }, { overallTimeout: 1 }, { concurrency: 0 }, { concurrency: 257 }, { connectionsPerSecond: NaN }, { concurrency: 1.5 }]) assert.throws(() => validateConnectionOptions(input));
});

test('one persistent helper serves several domains and proofs with monotonic request identities', async t => {
  const { pool, commands, spawns } = fixture(t, (command, child) => {
    if (command.type === 'resolve') child.send({ type: 'resolved', id: command.id, ok: true });
    if (command.type === 'attempt') complete(command, child);
  });
  await pool.start({ connectionsPerSecond: 20, concurrency: 3 });
  assert.equal(pool.pacesStarts, true, 'protocol 3 paces actual TCP starts in the persistent helper');
  await pool.start({ connectionsPerSecond: 20, concurrency: 3 });
  await Promise.all(['example.com', 'other.example'].map(domain => pool.resolve(domain)));
  const events = [];
  const values = await Promise.all(['example.com', 'other.example'].map(domain => pool.attempt(context(domain), {
    bountyId, successfulConnections: 7n, onStarted: () => events.push('start'), onCapture: row => events.push(row.captured ? 'capture' : 'failed'),
  })));
  assert.equal(spawns.length, 1); assert.deepEqual(spawns[0].args, ['mock', '--service']);
  assert.equal(spawns[0].options.shell, false); assert.equal(spawns[0].options.windowsHide, true);
  assert.equal(commands.filter(row => row.type === 'start').length, 1);
  assert.deepEqual(commands.filter(row => row.id !== undefined).map(row => row.id), [1, 2, 3, 4]);
  assert.deepEqual(events, ['start', 'capture', 'start', 'capture']);
  assert.ok(values.every(value => value.proof === '020100' && value.successfulConnections === '8'));
  for (const command of commands.filter(row => row.type === 'attempt')) {
    assert.deepEqual(Object.keys(command.context).sort(), Object.keys(context()).sort());
    assert.equal(command.successfulConnections, '7');
  }
  assert.equal(pool.requests.size, 0);
});

test('capture observation is delivered before delayed verification and hash misses remain successful captures', async t => {
  let pending, child, captures = 0, settled = false;
  const { pool } = fixture(t, (command, current) => { pending = command; child = current; });
  await pool.start({});
  const result = pool.attempt(context(), { bountyId, onCapture: value => { assert.equal(value.captured, true); captures++; } }).then(value => { settled = true; return value; });
  child.send({ type: 'started', id: pending.id });
  child.send({ type: 'capture', ...observation(pending) });
  await tick(); assert.equal(captures, 1); assert.equal(settled, false);
  child.send({ type: 'attempt', ...observation(pending), proof: null, verified: false });
  assert.equal((await result).captured, true); assert.equal(captures, 1);
});

test('budget rejection before TCP does not invent a capture or start notification', async t => {
  const { pool } = fixture(t, (command, child) => child.send({ type: 'attempt', ...observation(command, {
    started: false, captured: false, seconds: 0, successfulConnections: command.successfulConnections,
  }), proof: null, verified: false, blocked: 'budget' }));
  await pool.start({});
  let events = 0;
  const result = await pool.attempt(context(), { bountyId, successfulConnections: 3n, onStarted: () => events++, onCapture: () => events++ });
  assert.equal(result.blocked, 'budget'); assert.equal(events, 0);
});

for (const [message, expected, category] of [
  ['TLS connection timed out', 'TLS connection timed out', 'tls-timeout'],
  ['TLS capture or proof validation failed', 'TLS capture or proof validation failed', 'proof-failed'],
  ['TLS capture cancelled', 'TLS capture cancelled', 'unknown'],
  ['Public DNS resolution is required', 'Public DNS resolution is required', 'unknown'],
  ['private-peer-details: timed out', 'TLS capture or proof validation failed', 'proof-failed'],
  [{ private: 'private-peer-details' }, 'TLS capture or proof validation failed', 'proof-failed'],
]) test(`attempt descriptions retain only allowlisted text: ${typeof message === 'string' ? message : 'non-string'}`, async t => {
  const { pool, children } = fixture(t, (command, child) => {
    const value = observation(command, { captured: false, successfulConnections: command.successfulConnections });
    child.send({ type: 'started', id: command.id });
    child.send({ type: 'capture', ...value });
    child.send({ type: 'attempt', ...value, proof: null, verified: false, message });
  });
  await pool.start({});
  const result = await pool.attempt(context(), { bountyId, successfulConnections: 2n });
  assert.equal(result.message, expected);
  assert.equal(diagnosticError(new Error(result.message)).category, category);
  assert.equal(result.successfulConnections, '2');
  assert.equal(result.cancelled, false);
  assert.ok(!JSON.stringify(result).includes('private-peer-details'));
  assert.equal(pool.failure, undefined);
  assert.equal(children[0].killed, false);
  assert.equal(pool.requests.size, 0);
});

test('fatal helper error frames never expose arbitrary message text', async t => {
  const { pool, children } = fixture(t, (_command, child) => child.send({ type: 'error', message: 'private-peer-details: timed out' }));
  await pool.start({});
  await assert.rejects(pool.attempt(context(), { bountyId }), error => {
    assert.equal(error.message, 'Claims helper failed');
    assert.equal(diagnosticError(error).category, 'helper-failed');
    return error.helperFatal === true;
  });
  assert.equal(children[0].killed, true);
});

test('cancellation sends only its request ID and waits for the terminal acknowledgement', async t => {
  const pending = new Map();
  const { pool, commands, children } = fixture(t, command => { if (command.type === 'attempt') pending.set(command.id, command); });
  await pool.start({});
  const abort = new AbortController();
  const cancelled = pool.attempt(context(), { bountyId, signal: abort.signal });
  const other = pool.attempt(context('other.example'), { bountyId: `${'03'.repeat(32)}:1` });
  const rejected = assert.rejects(cancelled, error => error.name === 'AbortError');
  abort.abort(); assert.equal(pool.requests.size, 2);
  assert.deepEqual(commands.at(-1), { type: 'cancel', id: 1 });
  children[0].send({ type: 'attempt', ...observation(pending.get(1), { started: false, captured: false, cancelled: true, seconds: 0, successfulConnections: '0' }), proof: null, verified: false });
  await rejected; assert.equal(pool.requests.size, 1); assert.equal(children[0].killed, false);
  complete(pending.get(2), children[0]); assert.equal((await other).verified, true);
});

for (const scenario of ['wrong-context', 'unknown-id', 'duplicate-start', 'missing-capture', 'false-verified', 'string-verified', 'missing-verified', 'conflicting-capture', 'missing-counter', 'regressing-counter', 'conflicting-counter', 'nonfinite-duration', 'oversized-proof']) {
  test(`persistent helper fails closed for ${scenario}`, async t => {
    const { pool, children } = fixture(t, (command, child) => {
      const value = observation(command);
      if (scenario === 'unknown-id') { child.send({ type: 'started', id: command.id + 100 }); return; }
      child.send({ type: 'started', id: command.id });
      if (scenario === 'duplicate-start') { child.send({ type: 'started', id: command.id }); return; }
      if (scenario !== 'missing-capture') child.send({ type: 'capture', ...value });
      const result = { type: 'attempt', ...value, proof: '020100', verified: true };
      if (scenario === 'wrong-context') result.context = { ...command.context, txid: 'ff'.repeat(32) };
      if (scenario === 'false-verified') result.verified = false;
      if (scenario === 'string-verified') result.verified = 'true';
      if (scenario === 'missing-verified') delete result.verified;
      if (scenario === 'conflicting-capture') result.captured = false;
      if (scenario === 'missing-counter') delete result.successfulConnections;
      if (scenario === 'regressing-counter') result.successfulConnections = '0';
      if (scenario === 'conflicting-counter') result.successfulConnections = '2';
      if (scenario === 'nonfinite-duration') result.seconds = Infinity;
      if (scenario === 'oversized-proof') result.proof = '02' + '11'.repeat(65536);
      child.send(result);
    });
    await pool.start({});
    await assert.rejects(pool.attempt(context(), { bountyId }), error => error.helperFatal === true);
    assert.equal(children[0].killed, true); assert.equal(pool.requests.size, 0);
  });
}

test('malformed framing rejects every live request and does not leave the helper running', async t => {
  const { pool, children } = fixture(t);
  await pool.start({});
  const requests = [pool.resolve('example.com'), pool.attempt(context(), { bountyId })];
  const observed = Promise.allSettled(requests);
  children[0].stdout.write('{malformed}\n');
  assert.ok((await observed).every(row => row.status === 'rejected' && row.reason.helperFatal));
  assert.equal(pool.requests.size, 0); assert.equal(children[0].killed, true);
});

test('a rejected asynchronous diagnostic callback cannot escape helper failure cleanup', async t => {
  const { pool, children } = fixture(t, () => {}, { onDiagnostic: async () => { throw new Error('mock diagnostic failure'); } });
  await pool.start({});
  const result = assert.rejects(pool.resolve('example.com'));
  children[0].stdout.write('[]\n');
  await result; await tick(); assert.equal(children[0].killed, true);
});

for (const helperReady of [false, true]) {
  for (const [exitCode, signal] of [[0, null], [1, null], [0xc0000005, null], [-1073741819, null], [null, 'SIGTERM']]) {
    test(`an idle helper closing ${helperReady ? 'after' : 'before'} ready records safe status ${exitCode ?? signal}`, async t => {
      const events = [], failures = [];
      const { pool, children, commands } = fixture(t, () => {}, {
        autoReady: helperReady, onDiagnostic: (event, details) => events.push({ event, details }), onFailure: error => failures.push(error),
      });
      const starting = pool.start({});
      const started = helperReady ? starting : assert.rejects(starting, error => error.helperFatal === true);
      if (helperReady) await started;
      children[0].stderr.write('private-helper-traceback-and-profile-path');
      children[0].emit('close', exitCode, signal);
      await started;
      assert.equal(pool.requests.size, 0);
      assert.equal(events.length, 1);
      assert.deepEqual(failures, [pool.failure]);
      assert.equal(events[0].event, 'helper.failed');
      const { details } = events[0];
      assert.equal(details.helperReady, helperReady);
      assert.ok(details.durationMs >= 0 && details.durationMs < 10000);
      assert.equal(details.stderrBytes, Buffer.byteLength('private-helper-traceback-and-profile-path'));
      assert.equal(details.exitCode, exitCode === null ? undefined : exitCode);
      assert.equal(details.signal, signal ?? undefined);
      assert.equal(diagnosticError(details.error).category, 'helper-failed');
      assert.ok(!JSON.stringify(events).includes('private-helper'));
      assert.equal(children[0].killed, false, 'a child that already closed must not be killed again');
      await pool.close();
      assert.equal(commands.some(command => command.type === 'shutdown'), false);
    });
  }
}

test('unexpected helper exit rejects all requests with the same first failure and clears pending work', async t => {
  const events = [], failures = [];
  const { pool, children } = fixture(t, () => {}, {
    onDiagnostic: (event, details) => events.push({ event, details }), onFailure: error => failures.push(error),
  });
  await pool.start({});
  const aborted = new AbortController();
  const pending = Promise.allSettled([
    pool.resolve('example.com', { signal: aborted.signal }), pool.attempt(context(), { bountyId }),
  ]);
  children[0].emit('close', 42, null);
  const results = await pending;
  assert.ok(results.every(row => row.status === 'rejected' && row.reason === pool.failure && row.reason.helperFatal));
  assert.equal(pool.requests.size, 0);
  aborted.abort(); // Its removed handler must not write cancellation to a dead helper.
  assert.equal(events.length, 1);
  assert.deepEqual(failures, [pool.failure]);
  assert.equal(events[0].details.exitCode, 42);
  await assert.rejects(pool.resolve('example.com'), error => error === pool.failure);
});

test('shutdown before ready cancels startup without classifying late pipe or output events as failure', async t => {
  const events = [], failures = [];
  const { pool, children } = fixture(t, () => {}, {
    autoReady: false, onDiagnostic: (event, details) => events.push({ event, details }), onFailure: error => failures.push(error),
  });
  const starting = assert.rejects(pool.start({}), error => error.name === 'AbortError');
  const stopping = pool.close();
  children[0].stdout.write('{invalid-json}\n');
  children[0].stderr.write('x'.repeat(9000));
  children[0].stdin.emit('error', new Error('late EPIPE'));
  await Promise.all([starting, stopping]);
  assert.equal(pool.failure, undefined);
  assert.deepEqual(events, []);
  assert.deepEqual(failures, []);
});

test('shutdown after ready cancels pending work without reporting a crash', async t => {
  const events = [], failures = [];
  const { pool, children } = fixture(t, () => {}, {
    onDiagnostic: (event, details) => events.push({ event, details }), onFailure: error => failures.push(error),
  });
  await pool.start({});
  const pending = assert.rejects(pool.resolve('example.com'), error => error.name === 'AbortError');
  await pool.close();
  await pending;
  assert.equal(pool.requests.size, 0);
  assert.equal(children[0].killed, false);
  assert.deepEqual(events, []);
  assert.deepEqual(failures, []);
});

test('protocol failure keeps its original diagnosis when process teardown emits more errors', async t => {
  const events = [], failures = [];
  const { pool, children } = fixture(t, () => {}, {
    onDiagnostic: (event, details) => events.push({ event, details }), onFailure: error => failures.push(error),
  });
  await pool.start({});
  const pending = assert.rejects(pool.resolve('example.com'), /Malformed claims helper response/);
  children[0].stdout.write('[]\n');
  const first = pool.failure;
  children[0].stderr.write('x'.repeat(9000));
  children[0].stdin.emit('error', new Error('late EPIPE'));
  await pending;
  await tick();
  assert.equal(pool.failure, first);
  assert.equal(events.length, 1);
  assert.deepEqual(failures, [first]);
  assert.equal(events[0].details.error, first);
  assert.equal(diagnosticError(first).category, 'helper-response');
  assert.equal(children[0].killed, true);
});

test('arbitrary process status values never enter the helper diagnostic callback', async t => {
  const events = [];
  const { pool, children } = fixture(t, () => {}, { onDiagnostic: (event, details) => events.push({ event, details }) });
  await pool.start({});
  children[0].emit('close', 'private-exit-text', 'private-signal-text');
  assert.equal(events.length, 1);
  assert.equal(events[0].details.exitCode, undefined);
  assert.equal(events[0].details.signal, undefined);
  assert.ok(!JSON.stringify(events).includes('private-'));
});

test('a closed pool cannot restart a helper or leave its startup promise pending', async t => {
  const { pool, spawns } = fixture(t);
  await pool.close();
  await assert.rejects(pool.start({}), error => error.name === 'AbortError');
  assert.deepEqual(spawns, []);
});

for (const asynchronous of [false, true]) test(`a ${asynchronous ? 'rejecting' : 'throwing'} failure callback cannot escape helper cleanup`, async t => {
  const onFailure = asynchronous ? async () => { throw new Error('callback unavailable'); } : () => { throw new Error('callback unavailable'); };
  const { pool, children } = fixture(t, () => {}, { onFailure });
  await pool.start({});
  const pending = assert.rejects(pool.resolve('example.com'), error => error.helperFatal === true);
  children[0].stdout.write('[]\n');
  await pending;
  await tick();
  assert.equal(pool.requests.size, 0);
  assert.equal(children[0].killed, true);
  await pool.close();
});
