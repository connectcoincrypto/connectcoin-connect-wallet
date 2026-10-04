import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const txid = 'ab'.repeat(32);
const plain = value => JSON.parse(JSON.stringify(value));

test('confirmation IPC preserves only bounded public uncertainty metadata', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("ipcMain.handle('connectwallet:action'");
  const end = source.indexOf("window.once('ready-to-show'", start);
  const whitelist = source.match(/const SERVICE_METHODS = ([^\n]+);/)[1];
  const frame = { url: 'file:///wallet/index.html' }, webContents = { mainFrame: frame };
  let handler, failure;
  const service = { activity() {}, async confirmSend() { throw failure; }, async refresh() { throw failure; } };
  runInNewContext(`const SERVICE_METHODS = ${whitelist}; let actionInProgress = false; ${source.slice(start, end)}`, {
    ipcMain: { handle: (_name, callback) => { handler = callback; } }, service,
    window: { webContents }, UI_URL: frame.url, Buffer,
  });
  const event = { sender: webContents, senderFrame: frame };
  failure = Object.assign(new Error('Uncertain result'), { unknownOutcome: true, txid,
    mnemonic: 'PRIVATE-CANARY', hex: 'PRIVATE-CANARY', data: { secret: 'PRIVATE-CANARY' } });
  assert.deepEqual(plain(await handler(event, 'confirmSend', {})), { ok: false, error: 'Uncertain result', unknownOutcome: true, txid });
  assert.deepEqual(plain(await handler(event, 'refresh', {})), { ok: false, error: 'Uncertain result' });
  for (const invalid of ['PRIVATE-CANARY', txid + '00', {}, null]) {
    failure.txid = invalid;
    assert.deepEqual(plain(await handler(event, 'confirmSend', {})), { ok: false, error: 'Uncertain result', unknownOutcome: true });
  }
  failure = Object.assign(new Error('Save failed'), { unknownOutcome: 'true', txid });
  assert.deepEqual(plain(await handler(event, 'confirmSend', {})), { ok: false, error: 'Save failed' });
});

test('preload returns confirmation outcomes as plain data without exposing arbitrary error fields', async () => {
  let exposed, reply;
  const calls = [];
  runInNewContext(await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8'), {
    window: { addEventListener() {} },
    require: name => { assert.equal(name, 'electron'); return {
      contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return reply; } },
    }; },
  });
  reply = { ok: false, error: 'Unknown result', unknownOutcome: true, txid, stack: 'PRIVATE-CANARY', privateKey: 'PRIVATE-CANARY' };
  assert.deepEqual(plain(await exposed.invoke('confirmSend', { previewId: 'review' })), {
    ok: false, error: 'Unknown result', unknownOutcome: true, txid,
  });
  assert.deepEqual(calls[0], ['connectwallet:action', 'confirmSend', { previewId: 'review' }]);
  reply = { ok: true, value: { status: 'submitted', txid } };
  assert.deepEqual(plain(await exposed.invoke('confirmSend')), reply);
  reply = { ok: false, error: 'Read failed', unknownOutcome: true, txid };
  await assert.rejects(exposed.invoke('getState'), /Read failed/);
  await assert.rejects(exposed.invoke('arbitraryMethod'), /Unsupported/);
  reply.txid = '<untrusted>';
  assert.equal(Object.hasOwn(await exposed.invoke('confirmSend'), 'txid'), false);
});
