import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { RpcClient } from '../src/core/rpc.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';
import { prepareClaim, serializeTransaction, transactionId } from '../src/core/transaction.mjs';

const bytes = 'ab'.repeat(40);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reply = (socket, request, result) => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
const cancelled = error => error.name === 'AbortError' && error.code === 'ABORT_ERR' && error.notSent === true && !error.unknownOutcome;
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cancellation did not settle promptly')), 500); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t, handler = (request, socket) => reply(socket, request, true), options = {}) {
  const sockets = new Set(), requests = [], events = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        requests.push(request); handler(request, socket);
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new RpcClient({ host: '127.0.0.1', port: server.address().port, timeoutMs: 1000,
    onDiagnostic: (event, details) => events.push({ event, details }), ...options });
  t.after(async () => { client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { client, requests, events };
}

test('an already-cancelled request never connects or consumes quota', async t => {
  const { client, requests } = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.request('sendrawtransaction', { transaction_hex: bytes }, { signal: controller.signal }), cancelled);
  assert.equal(client.socket, null); assert.equal(client.history.size, 0); assert.equal(client.queuedRequests, 0);
  assert.deepEqual(requests, []);
});

for (const mode of ['quota', 'cooldown']) test(`cancelling a broadcast during ${mode} prevents its later transmission and keeps shared RPC alive`, async t => {
  const { client, requests, events } = await fixture(t, undefined, { windowMs: 180 });
  await client.request('getchaintip'); const socket = client.socket;
  if (mode === 'quota') client.history.set('sendrawtransaction', Array(48).fill(performance.now()));
  else client.cooldowns.set('sendrawtransaction', performance.now() + 180);
  const controller = new AbortController();
  const waiting = client.request('sendrawtransaction', { transaction_hex: bytes }, { signal: controller.signal });
  const rejected = assert.rejects(bounded(waiting), cancelled);
  controller.abort(); await rejected;
  assert.equal(await client.request('getrecentblockhashes'), true);
  await delay(220);
  assert.equal(requests.some(request => request.method === 'sendrawtransaction'), false);
  assert.equal(client.socket, socket); assert.equal(socket.destroyed, false); assert.equal(client.queuedRequests, 0);
  assert.equal(events.filter(row => row.event === 'rpc.cancelled').length, 1);
  assert.equal(events.some(row => row.event === 'rpc.failed'), false);
});

test('one request can leave a shared connection wait without cancelling another request', async t => {
  const { client, requests } = await fixture(t);
  const gate = deferred(), entered = deferred(), connect = client.connect.bind(client);
  t.after(() => gate.resolve());
  client.connect = async () => { const socket = await connect(); entered.resolve(); await gate.promise; return socket; };
  const controller = new AbortController();
  const waiting = client.request('sendrawtransaction', { transaction_hex: bytes }, { signal: controller.signal });
  const rejected = assert.rejects(bounded(waiting), cancelled);
  const other = client.request('getchaintip');
  await entered.promise; controller.abort(); await rejected;
  assert.equal(client.socket.destroyed, false);
  gate.resolve(); assert.equal(await other, true);
  assert.deepEqual(requests.map(request => request.method), ['getchaintip']);
});

test('cancellation at connection completion is checked before socket.write', async t => {
  const { client, requests } = await fixture(t);
  const controller = new AbortController();
  client.once('connected', () => controller.abort());
  await assert.rejects(client.request('sendrawtransaction', { transaction_hex: bytes }, { signal: controller.signal }), cancelled);
  assert.equal(await client.request('getchaintip'), true);
  assert.deepEqual(requests.map(request => request.method), ['getchaintip']);
});

for (const outcome of ['confirmed', 'disconnected']) test(`cancellation after socket.write preserves a ${outcome} broadcast outcome without retry`, async t => {
  const received = deferred();
  const { client, requests, events } = await fixture(t, (request, socket) => {
    if (request.method === 'sendrawtransaction') received.resolve({ request, socket });
    else reply(socket, request, true);
  });
  const controller = new AbortController();
  const broadcast = client.request('sendrawtransaction', { transaction_hex: bytes }, { signal: controller.signal });
  const result = outcome === 'confirmed' ? broadcast : assert.rejects(broadcast, error => error.unknownOutcome === true && error.notSent !== true);
  const { request, socket } = await received.promise; controller.abort();
  assert.equal(await client.request('getchaintip'), true);
  if (outcome === 'confirmed') { reply(socket, request, { txid: '01'.repeat(32) }); assert.deepEqual(await result, { txid: '01'.repeat(32) }); }
  else { socket.destroy(); await result; }
  assert.equal(requests.filter(value => value.method === 'sendrawtransaction').length, 1);
  assert.equal(events.some(row => row.event === 'rpc.cancelled'), false);
  assert.equal(client.pending.size, 0);
});

function claimFixture(rpc) {
  // Public BIP39 vector, synthetic funding/proof; no wallet files or remote nodes.
  const account = deriveAccount('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  account.privateKey.fill(0);
  const funding = { version: 2, locktime: 0,
    inputs: [{ txid: '99'.repeat(32), vout: 0, sequence: 0xffffffff, scriptSig: '', witness: [] }],
    outputs: [{ type: 2, amount: '1000000000', domain: 'example.com', target: 'f'.repeat(64), rootVersion: 1, mask: 7 }] };
  const bounty = { txid: transactionId(funding), vout: 0, amount: '1000000000', status: 'available' };
  const prepared = { ...prepareClaim({ bounty, rawTransaction: serializeTransaction(funding).toString('hex'), rewardAddress: account.address }), epoch: 7, walletGeneration: 0, rpc };
  const hello = Buffer.concat([Buffer.from('010000220303', 'hex'), Buffer.from(prepared.challenge, 'hex')]);
  const proof = Buffer.concat([Buffer.from([2]), hello, ...[2, 8, 11, 15].map(type => Buffer.from([type, 0, 0, 0]))]).toString('hex');
  const service = new WalletService({ directory: '/unused-rpc-cancellation-test' });
  service.rpc = rpc; service.epoch = 7; service.session = { data: {} };
  service.config = { claims: { enabled: true } };
  service.queueSettings = async operation => operation();
  service.applyConfig = async input => { Object.assign(service.config.claims, input.claims); };
  service.engine = { enabled: true, stopped: 0, async stop() { this.enabled = false; this.stopped++; } };
  const key = `${bounty.txid}:0`; service.claimOutpoints = new Map([[key, bounty]]); service.emitState = () => {};
  return { service, prepared, proof, key };
}

test('STOP during claim broadcast quota releases only its unsent reservation and sends no transaction', async t => {
  const { client, requests } = await fixture(t, undefined, { windowMs: 180 });
  client.history.set('sendrawtransaction', Array(48).fill(performance.now()));
  const { service, prepared, proof, key } = claimFixture(client);
  const controller = new AbortController();
  const submission = service.submitAutomaticClaim(prepared, proof, { signal: controller.signal });
  const rejected = assert.rejects(bounded(submission), cancelled);
  assert.equal(service.reserved.has(key), true);
  service.engine.enabled = false; controller.abort(); await rejected; await delay(220);
  assert.deepEqual(requests, []); assert.equal(service.reserved.has(key), false);
  assert.equal(service.error, null); assert.equal(service.engine.stopped, 0);
});

for (const outcome of ['confirmed', 'disconnected']) test(`STOP after a claim was sent preserves its ${outcome} outcome and reservation`, async t => {
  const received = deferred();
  const { client, requests } = await fixture(t, (request, socket) => received.resolve({ request, socket }));
  const { service, prepared, proof, key } = claimFixture(client);
  const controller = new AbortController();
  const submission = service.submitAutomaticClaim(prepared, proof, { signal: controller.signal });
  const result = outcome === 'confirmed' ? submission : assert.rejects(submission, error => error.unknownOutcome === true);
  const { request, socket } = await received.promise;
  service.engine.enabled = false; controller.abort();
  if (outcome === 'confirmed') { reply(socket, request, { txid: prepared.txid }); assert.deepEqual(await result, { txid: prepared.txid }); }
  else { socket.destroy(); await result; assert.match(service.error, /broadcast was not confirmed/); }
  assert.equal(service.reserved.has(key), true); assert.equal(requests.length, 1);
});
