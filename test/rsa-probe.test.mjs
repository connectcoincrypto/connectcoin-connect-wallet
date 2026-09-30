import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRsaProbe } from '../src/core/rsa-probe.mjs';

const INPUT = Object.freeze({ domain: 'example.com', rootVersion: 1, validationTime: 1800000000 });
const VERIFIED = { verified: true, status: 'verified' };
const FAILED = { verified: false, status: 'failed' };
const frame = (changes = {}) => `${JSON.stringify({ type: 'rsa-probe', ...INPUT, verified: true, ...changes })}\n`;

function fixture(t, options = {}) {
  const children = [];
  const calls = [];
  const probe = createRsaProbe({ helper: { command: 'fake-python', args: ['-I', 'claims_bridge.py'] }, ...options,
    spawnProcess(command, args, spawnOptions) {
      calls.push({ command, args, options: spawnOptions });
      const child = new EventEmitter();
      child.pid = 12345;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.input = '';
      child.stdin.on('data', chunk => { child.input += chunk; });
      child.kill = signal => { child.killed = true; child.killSignal = signal; return true; };
      child.close = (code = 0, signal = null) => { child.emit('exit', code, signal); child.emit('close', code, signal); };
      children.push(child);
      options.onSpawn?.(child);
      return child;
    },
  });
  t.after(() => { for (const child of children) child.close(); });
  return { probe, children, calls };
}

test('RSA probe sends only the public input with a sanitized subprocess environment', async t => {
  const { probe, children, calls } = fixture(t);
  process.env.CONNECTWALLET_RSA_TEST_SECRET = 'must-not-cross';
  t.after(() => { delete process.env.CONNECTWALLET_RSA_TEST_SECRET; });
  const result = probe({ ...INPUT, domain: 'EXAMPLE.COM', privateKey: 'must-not-cross' });
  assert.deepEqual(JSON.parse(children[0].input), INPUT);
  assert.equal(calls[0].command, 'fake-python');
  assert.deepEqual(calls[0].args, ['-I', 'claims_bridge.py', '--probe-rsa', '--require-rsa-exponent-64']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(calls[0].options.env.CONNECTWALLET_RSA_TEST_SECRET, undefined);
  assert.equal(calls[0].options.env.PYTHONNOUSERSITE, '1');
  children[0].stdout.write(frame().slice(0, 25));
  children[0].stdout.write(frame().slice(25));
  children[0].close();
  assert.deepEqual(await result, VERIFIED);
});

test('RSA probe fails closed on a legacy helper without retrying its unsupported policy flag', async t => {
  const { probe, children, calls } = fixture(t, { helper: { command: 'legacy-helper' } });
  const result = probe(INPUT);
  assert.deepEqual(calls[0].args, ['--probe-rsa', '--require-rsa-exponent-64']);
  children[0].stdout.write('{"type":"error","message":"unknown helper arguments"}\n');
  children[0].close(1);
  assert.deepEqual(await result, FAILED);
  assert.equal(calls.length, 1);
});

test('RSA probe requires a complete successful process exit, not just a success frame', async t => {
  const { probe, children } = fixture(t);
  let settled = false;
  const result = probe(INPUT).then(value => { settled = true; return value; });
  children[0].stdout.write(frame());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  children[0].close(1);
  assert.deepEqual(await result, FAILED);
});

for (const [label, output] of [
  ['negative', frame({ verified: false })],
  ['unbound domain', frame({ domain: 'other.example' })],
  ['unbound roots', frame({ rootVersion: 2 })],
  ['unbound time', frame({ validationTime: INPUT.validationTime + 1 })],
  ['wrong type', frame({ type: 'result' })],
  ['truthy verification', frame({ verified: 'true' })],
  ['extra key', frame({ proof: 'fake' })],
  ['missing key', frame().replace('"type":"rsa-probe",', '')],
  ['duplicate key', frame().replace('"verified":true', '"verified":false,"verified":true')],
  ['malformed JSON', '{bad}\n'],
  ['no newline', frame().trimEnd()],
  ['empty output', ''],
  ['extra frame', frame() + frame()],
  ['trailing data', frame() + 'unexpected'],
  ['extra blank line', frame() + '\n'],
  ['invalid UTF-8', Buffer.concat([Buffer.from(frame().trimEnd()), Buffer.from([0xff, 0x0a])])],
]) test(`RSA probe rejects ${label}`, async t => {
  const { probe, children } = fixture(t);
  const result = probe(INPUT);
  children[0].stdout.write(output);
  children[0].close();
  assert.deepEqual(await result, FAILED);
});

for (const [stream, size] of [['stdout', 2049], ['stderr', 8193]]) test(`RSA probe bounds ${stream} without waiting for exit`, async t => {
  const { probe, children } = fixture(t);
  const result = probe(INPUT);
  children[0][stream].write(Buffer.alloc(size));
  assert.deepEqual(await result, FAILED);
  assert.equal(children[0].killSignal, 'SIGKILL');
});

test('RSA probe returns unavailable when no helper is installed or spawn fails', async t => {
  assert.deepEqual(await createRsaProbe({ helper: null })(INPUT), { verified: false, status: 'unavailable' });
  const throwing = createRsaProbe({ helper: { command: 'absent' }, spawnProcess() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  assert.deepEqual(await throwing(INPUT), { verified: false, status: 'unavailable' });
  const { probe, children } = fixture(t);
  const result = probe(INPUT);
  delete children[0].pid;
  children[0].emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
  assert.deepEqual(await result, { verified: false, status: 'unavailable' });
});

test('RSA probe handles child and pipe errors as an advisory failure', async t => {
  for (const stream of [null, 'stdin', 'stdout', 'stderr']) {
    const { probe, children } = fixture(t);
    const result = probe(INPUT);
    (stream ? children[0][stream] : children[0]).emit('error', new Error('broken'));
    assert.deepEqual(await result, FAILED);
    assert.equal(children[0].killed, true);
    children[0].close();
  }
});

test('RSA probe times out and ignores a late success even when kill does not cause exit', async t => {
  const { probe, children } = fixture(t, { deadlineMs: 15 });
  const result = await probe(INPUT);
  assert.deepEqual(result, { verified: false, status: 'timeout' });
  assert.equal(children[0].killSignal, 'SIGKILL');
  children[0].stdout.write(frame());
  children[0].close();
  assert.deepEqual(result, { verified: false, status: 'timeout' });
});

test('RSA probe includes synchronous process startup in its wall deadline', async t => {
  let clock = 0;
  const { probe, children } = fixture(t, { now: () => clock, onSpawn: () => { clock = 3001; } });
  assert.deepEqual(await probe(INPUT), { verified: false, status: 'timeout' });
  assert.equal(children[0].input, '');
  assert.equal(children[0].killed, true);
});

test('RSA probe cannot accept a late success before the delayed timer runs', async t => {
  let clock = 0;
  const { probe, children } = fixture(t, { now: () => clock });
  const result = probe(INPUT);
  children[0].stdout.write(frame());
  clock = 3001;
  children[0].close();
  assert.deepEqual(await result, { verified: false, status: 'timeout' });
});

test('RSA probe abort rejects immediately, kills the child and ignores late success', async t => {
  const { probe, children } = fixture(t);
  const controller = new AbortController();
  const result = probe(INPUT, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(children[0].killed, true);
  children[0].stdout.write(frame());
  children[0].close();
});

test('RSA probe aborts before spawn and during synchronous spawn', async t => {
  const before = new AbortController();
  before.abort();
  const first = fixture(t);
  await assert.rejects(first.probe(INPUT, { signal: before.signal }), { name: 'AbortError' });
  assert.equal(first.children.length, 0);
  const during = new AbortController();
  const second = fixture(t, { onSpawn: () => during.abort() });
  await assert.rejects(second.probe(INPUT, { signal: during.signal }), { name: 'AbortError' });
  assert.equal(second.children[0].killed, true);
  assert.equal(second.children[0].input, '');
});

test('RSA process limit is shared between instances and retains slots until exit after abort or timeout', async t => {
  const first = fixture(t, { deadlineMs: 15 });
  const second = fixture(t, { deadlineMs: 15 });
  const controller = new AbortController();
  const aborted = first.probe(INPUT, { signal: controller.signal });
  const abortCheck = assert.rejects(aborted, { name: 'AbortError' });
  const pending = [first.probe(INPUT), second.probe(INPUT), second.probe(INPUT)];
  controller.abort();
  await abortCheck;
  assert.deepEqual(await first.probe(INPUT), { verified: false, status: 'busy' });
  assert.deepEqual(await Promise.all(pending), Array.from({ length: 3 }, () => ({ verified: false, status: 'timeout' })));
  assert.deepEqual(await second.probe(INPUT), { verified: false, status: 'busy' });
  assert.equal(first.children.length + second.children.length, 4);
  first.children[0].emit('exit', null, 'SIGKILL');
  const next = second.probe(INPUT);
  second.children.at(-1).stdout.write(frame());
  second.children.at(-1).close();
  assert.deepEqual(await next, VERIFIED);
});

test('RSA probe rejects invalid public inputs before spawning', async t => {
  const { probe, children } = fixture(t);
  for (const invalid of [
    { domain: 'https://example.com' }, { domain: 'localhost' }, { domain: 'example.local' },
    { domain: 'example.internal' }, { domain: '-bad.example' }, { domain: 'x'.repeat(254) },
    { rootVersion: 2 }, { validationTime: 0 }, { validationTime: 1.5 }, { validationTime: undefined },
  ]) await assert.rejects(probe({ ...INPUT, ...invalid }));
  assert.equal(children.length, 0);
});
