import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { RpcClient, validateRpcParams } from '../src/core/rpc.mjs';

test('funding batch params copy bounded unique hashes without evaluating getters or sending extras', () => {
  const txids = ['AB'.repeat(32)];
  const clean = validateRpcParams('gettransactions', { txids });
  txids[0] = 'cd'.repeat(32);
  assert.deepEqual(clean, { txids: ['ab'.repeat(32)] });
  for (const value of [[], Array(33).fill('ab'.repeat(32)), ['ab'.repeat(32), 'AB'.repeat(32)], ['bad'], [null], Array(2)]) {
    assert.throws(() => validateRpcParams('gettransactions', { txids: value }));
  }
  const getter = []; getter.length = 1;
  Object.defineProperty(getter, '0', { get() { assert.fail('Getter must not run'); } });
  assert.throws(() => validateRpcParams('gettransactions', { txids: getter }));
  assert.throws(() => validateRpcParams('gettransactions', { txids: ['ab'.repeat(32)], mnemonic: 'never send' }));
});

test('151 cold parents require five bounded requests, while the ninth batch respects its own quota', async t => {
  const sockets = new Set(), calls = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString(); let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        calls.push({ method: request.method, at: performance.now() });
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.params.txids }) + '\n');
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new RpcClient({ host: '127.0.0.1', port: server.address().port, windowMs: 200, timeoutMs: 2000 });
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise(done => server.close(done)); });
  // Exhaust the unrelated single-parent quota. Bulk requests must use their
  // independently bounded method, not evade a quota by opening more sockets.
  client.history.set('gettransaction', Array(48).fill(performance.now()));
  const ids = Array.from({ length: 151 }, (_, index) => index.toString(16).padStart(64, '0'));
  for (let offset = 0; offset < ids.length; offset += 32) await client.request('gettransactions', { txids: ids.slice(offset, offset + 32) });
  assert.equal(calls.length, 5);
  assert.equal(client.history.get('gettransactions').length, 5);
  for (let index = 0; index < 4; index++) await client.request('gettransactions', { txids: [ids[0]] });
  assert.equal(calls.length, 9);
  assert.ok(calls.at(-1).at - calls[0].at >= 150, 'Ninth request waits for the batch quota window');
});
