import assert from 'node:assert/strict';
import test from 'node:test';
import { acknowledgePreferences, createPreferenceSaver, preferenceBatch } from '../src/ui/preferences.mjs';

const config = () => ({ rpc: { host: 'localhost', port: 48190 }, claims: { enabled: true, maxConnectionsPerSecond: 100, maxConcurrent: 100, lookbackBlocks: 600 }, autoLockMinutes: 15, feeRate: 1500 });
const draft = () => ({ settings: {}, claims: {}, send: {} });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('autosave allows only valid preferences and keeps RPC edits atomic until leaving the endpoint fields', () => {
  const edits = { claims: { maxConnectionsPerSecond: '127', maxConcurrent: '', lookbackBlocks: '601', enabled: true }, settings: { host: 'new.example', port: '', autoLockMinutes: '30', feeRate: '2200', password: 'never-save' }, send: { address: 'never-save', amount: '7', mnemonic: 'never-save' } };
  assert.deepEqual(preferenceBatch(config(), edits).patch, { claims: { maxConnectionsPerSecond: 127 }, autoLockMinutes: 30, feeRate: 2200 });
  assert.deepEqual(preferenceBatch(config(), edits, { rpcReady: true }).patch, preferenceBatch(config(), edits).patch);
  edits.settings.port = '12345';
  assert.equal(preferenceBatch(config(), edits).patch.rpc, undefined);
  assert.deepEqual(preferenceBatch(config(), edits, { rpcReady: true }).patch.rpc, { host: 'new.example', port: 12345 });
  for (const host of ['', 'https://example.com', 'a/b', '256.0.0.1', '01.0.0.1', 'host%', '-bad.example', '::bad::']) {
    edits.settings.host = host;
    assert.equal(preferenceBatch(config(), edits, { rpcReady: true }).patch.rpc, undefined, host);
  }
  edits.settings.host = '::1';
  assert.deepEqual(preferenceBatch(config(), edits, { rpcReady: true }).patch.rpc, { host: '::1', port: 12345 });
  for (const invalid of ['', ' ', '-1', '1.5', '1e2', '257', 'Infinity']) {
    edits.claims.maxConnectionsPerSecond = invalid;
    assert.equal(preferenceBatch(config(), edits).patch.claims, undefined);
  }
});

test('an in-flight save acknowledges only its own draft, then saves the newer preference without overlap', async () => {
  let current = config();
  const edits = draft(), started = deferred(), release = deferred();
  const writes = [];
  let active = 0;
  const saver = createPreferenceSaver({
    snapshot: () => preferenceBatch(current, edits),
    save: async patch => {
      assert.equal(++active, 1);
      writes.push(patch);
      if (writes.length === 1) { started.resolve(); await release.promise; }
      current = { ...current, ...patch }; active--; return current;
    },
    saved: (_, batch) => acknowledgePreferences(edits, batch),
  });
  edits.settings.autoLockMinutes = '20';
  const first = saver.flush();
  await started.promise;
  edits.settings.autoLockMinutes = '25';
  const second = saver.flush();
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(writes, [{ autoLockMinutes: 20 }, { autoLockMinutes: 25 }]);
  assert.deepEqual(edits.settings, {});
  assert.equal(saver.hasPending(), false);
});

test('busy retries use the latest valid draft, while write failures stay visible and retain edits for retry', async () => {
  const current = config(), edits = draft();
  let attempts = 0;
  edits.settings.autoLockMinutes = '25';
  const saver = createPreferenceSaver({
    snapshot: () => preferenceBatch(current, edits),
    save: async () => { attempts++; edits.settings.autoLockMinutes = ''; throw new Error('Another wallet action is in progress. Please wait.'); },
    saved: (_, batch) => acknowledgePreferences(edits, batch), retryDelay: 1,
  });
  await saver.flush();
  assert.equal(attempts, 1, 'a now-invalid draft must not replay its earlier valid value');
  assert.equal(edits.settings.autoLockMinutes, '');
  edits.settings.autoLockMinutes = '25';
  const failure = new Error('Disk is full');
  const failing = createPreferenceSaver({ snapshot: () => preferenceBatch(current, edits), save: async () => { throw failure; }, saved: () => assert.fail('unsaved draft acknowledged') });
  await assert.rejects(failing.flush(), error => error === failure);
  assert.equal(edits.settings.autoLockMinutes, '25');
});
