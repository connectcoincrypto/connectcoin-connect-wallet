import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createUiStartupDiagnostics } from '../scripts/ui-startup.mjs';

function fixture() {
  let clock = 0;
  const lines = [];
  const diagnostics = createUiStartupDiagnostics({ log: line => lines.push(line), now: () => clock });
  return { diagnostics, lines, at(value) { clock = value; }, rows: () => lines.map(line => JSON.parse(line.slice('UI startup: '.length))) };
}

test('startup observations preserve a successful operation and its timing without logging its result', async () => {
  const f = fixture();
  const privateResult = { title: 'private-window-title', profile: 'private-profile-path' };
  const result = await f.diagnostics.run('electron-launch', () => { f.at(42); return privateResult; });
  assert.equal(result, privateResult);
  assert.deepEqual(f.rows(), [
    { step: 'electron-launch', status: 'started', durationMs: 0 },
    { step: 'electron-launch', status: 'completed', durationMs: 42 },
  ]);
});

test('startup failures retain the exact error without retries or reading private event/exception fields', async () => {
  const f = fixture();
  const page = new EventEmitter();
  const privatePayload = new Proxy({}, { get() { throw new Error('Private payload was read.'); } });
  let calls = 0;
  f.diagnostics.observePage(page);
  for (const event of ['domcontentloaded', 'load', 'pageerror', 'requestfailed', 'crash', 'close']) page.emit(event, privatePayload);
  page.emit('pageerror', privatePayload);
  await f.diagnostics.run('welcome-heading', () => {
    calls++;
    f.at(15000);
    throw privatePayload;
  }).then(() => assert.fail('The startup failure must propagate.'), error => assert.equal(error, privatePayload));
  assert.equal(calls, 1);
  assert.deepEqual(f.rows().at(-1), {
    step: 'welcome-heading', status: 'failed', durationMs: 15000,
    pageObserved: 1, domContentLoadedCount: 1, loadCount: 1,
    pageErrorCount: 2, failedRequestCount: 1, crashCount: 1, closeCount: 1,
  });
  f.diagnostics.dispose();
});

test('startup failure reporting does not query an unavailable page or process', async () => {
  const f = fixture();
  const failure = new Error('private-launch-failure');
  await assert.rejects(f.diagnostics.run('first-window', async () => { throw failure; }), error => error === failure);
  assert.deepEqual(f.rows().at(-1), {
    step: 'first-window', status: 'failed', durationMs: 0,
    pageObserved: 0, domContentLoadedCount: 0, loadCount: 0,
    pageErrorCount: 0, failedRequestCount: 0, crashCount: 0, closeCount: 0,
  });
  assert.ok(!f.lines.join('\n').includes('private-launch-failure'));
  f.diagnostics.dispose();
});

test('startup observations detach only their listeners and do not carry events into a later launch', async () => {
  const f = fixture();
  const page = new EventEmitter();
  const existingListener = () => {};
  page.on('pageerror', existingListener);
  f.diagnostics.observePage(page);
  assert.equal(page.listenerCount('pageerror'), 2);
  f.diagnostics.dispose();
  f.diagnostics.dispose();
  assert.deepEqual(page.listeners('pageerror'), [existingListener]);
  assert.equal(page.listenerCount('load'), 0);
  page.emit('requestfailed', { url: 'private-url' });
  const next = fixture();
  next.diagnostics.observePage(page);
  await assert.rejects(next.diagnostics.run('brand-image', () => { throw new Error('private-image-error'); }));
  assert.equal(next.rows().at(-1).failedRequestCount, 0);
  next.diagnostics.dispose();
});

test('startup observations accept only fixed step labels and cannot mask errors when logging fails', async () => {
  let calls = 0;
  const f = fixture();
  await assert.rejects(f.diagnostics.run('private-runtime-label', () => { calls++; }), /Unknown UI startup step/);
  assert.equal(calls, 0);
  assert.deepEqual(f.lines, []);
  const diagnostics = createUiStartupDiagnostics({ log() { throw new Error('Log unavailable.'); } });
  assert.equal(await diagnostics.run('window-title', () => 42), 42);
  const failure = new Error('Original failure.');
  await assert.rejects(diagnostics.run('application-name', () => { throw failure; }), error => error === failure);
});
