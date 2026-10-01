import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { readBountyBlock } from '../src/core/bounty-discovery.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { DiagnosticLog } from '../src/core/diagnostics.mjs';
import { RpcClient } from '../src/core/rpc.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';

const hash = '01'.repeat(32), txid = '02'.repeat(32), streamId = 'cancelled-discovery';
const tip = { chain: 'testnet4', genesis_hash: GENESIS.testnet4, height: 1, hash, mediantime: 1800000000 };
const snapshot = { type: 'snapshot', tip, block_hash: hash, unit: 'connects', cursor: 'start' };
const row = { txid, vout: 0, amount: '1000000000', domain: 'example.com', connection_work_target: 'f'.repeat(64),
  root_certificates_version: 1, signature_algorithms_mask: 7, block_height: 1, block_hash: hash,
  coinbase: false, confirmations: 1, status: 'available', spending_txid: null };
const abortError = () => Object.assign(new Error('Bounty discovery stopped.'), { name: 'AbortError', code: 'ABORT_ERR' });
const cancelled = error => error.name === 'AbortError' && error.code === 'ABORT_ERR' && !error.unknownOutcome;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const line = message => `${JSON.stringify(message)}\n`;
const response = (request, result) => ({ jsonrpc: '2.0', id: request.id, result });
const note = (method, params) => ({ jsonrpc: '2.0', method, params: { stream_id: streamId, ...params } });
const chunk = (sequence, items) => note('stream.chunk', { sequence, items });
async function bounded(promise, timeoutMs = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Discovery/RPC operation did not settle promptly')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function localRpc(t, { timeoutMs = 2000 } = {}) {
  const sockets = new Set(), requests = [], events = [], streaming = deferred(), broadcasting = deferred();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', bytes => {
      buffer += bytes.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        requests.push(request);
        if (request.method === 'getblockbounties') {
          socket.write(line(response(request, { stream_id: streamId })));
          streaming.resolve({ request, socket });
        } else if (request.method === 'sendrawtransaction') broadcasting.resolve({ request, socket });
        else socket.write(line(response(request, tip)));
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new RpcClient({ host: '127.0.0.1', port: server.address().port, timeoutMs,
    onDiagnostic: (event, details) => events.push({ event, details }) });
  t.after(async () => {
    client.close(); for (const socket of sockets) socket.destroy();
    await new Promise(done => server.close(done));
  });
  return { client, requests, events, streaming, broadcasting };
}

async function stopDiscovery(t, { broadcast = false, ...options } = {}) {
  const f = await localRpc(t, options);
  let enabled = true, checks = 0;
  const reading = readBountyBlock({ rpc: f.client, network: 'testnet4', hash, height: 1, check() {
    checks++; if (!enabled) throw abortError();
  } });
  const rejected = assert.rejects(bounded(reading), cancelled);
  // Observe both outcomes immediately, including failures during fixture setup.
  const submission = broadcast ? f.client.request('sendrawtransaction', { transaction_hex: 'ab'.repeat(40) })
    .then(value => ({ value }), error => ({ error })) : null;
  const [{ socket }, sent] = await bounded(Promise.all([
    f.streaming.promise, broadcast ? f.broadcasting.promise : Promise.resolve(null),
  ]));
  if (sent) assert.equal(sent.socket, socket);
  enabled = false; socket.write(line(chunk(0, snapshot))); await rejected;
  assert.equal(checks, 2, 'the discovery check cancels its first arriving chunk');
  assert.equal(f.client.streams.size, 1, 'the cancelled stream must retain its bounded drain');
  assert.equal(f.client.socket.destroyed, false);
  assert.equal(f.events.filter(value => value.event === 'rpc.cancelled').length, 1);
  return { ...f, socket, clientSocket: f.client.socket, sent, submission, get checks() { return checks; } };
}

test('STOP discards discovery while an unrelated broadcast confirms and the valid stream drains', async t => {
  const f = await stopDiscovery(t, { broadcast: true });
  assert.equal(f.client.pending.size, 1);
  assert.deepEqual(await f.client.request('getchaintip'), tip);
  assert.equal(f.client.socket, f.clientSocket);
  f.socket.write(line(response(f.sent.request, { txid })));
  assert.deepEqual(await bounded(f.submission), { value: { txid } });
  const stream = f.client.streams.get(streamId);
  const clearTimer = t.mock.method(globalThis, 'clearTimeout');
  f.socket.write([
    chunk(1, { type: 'bounties', tip, items: [row] }),
    chunk(2, { type: 'state', tip, cursor: 'end' }),
    note('stream.end', { complete: true, chunks: 3 }),
  ].map(line).join(''));
  // This reply is ordered after the drained frames on the same TCP socket.
  assert.deepEqual(await f.client.request('getchaintip'), tip);
  assert.equal(f.checks, 2, 'no callbacks may apply chunks after cancellation');
  assert.equal(f.client.streams.size, 0);
  assert.equal(f.client.pending.size, 0);
  for (const timer of [stream.timer, stream.deadlineTimer]) {
    assert.ok(clearTimer.mock.calls.some(call => call.arguments[0] === timer), 'completion clears idle and total-deadline timers');
  }
  assert.equal(f.client.socket, f.clientSocket);
  assert.equal(f.events.some(value => value.event === 'rpc.failed'), false);
  assert.equal(f.requests.filter(value => value.method === 'sendrawtransaction').length, 1);
});

const malformed = {
  sequence: () => chunk(3, { type: 'bounties', items: [] }),
  order: () => chunk(1, snapshot),
  shape: () => chunk(1, { type: 'bounties', items: {} }),
};
for (const [kind, message] of Object.entries(malformed)) test(`a cancelled stream still rejects malformed ${kind} and preserves broadcast uncertainty`, async t => {
  const f = await stopDiscovery(t, { broadcast: true });
  const closed = bounded(once(f.clientSocket, 'close'));
  f.socket.write(line(message()));
  const result = await bounded(f.submission); await closed;
  assert.equal(result.error?.unknownOutcome, true);
  assert.notEqual(result.error?.notSent, true);
  assert.equal(f.client.streams.size, 0); assert.equal(f.client.pending.size, 0);
  assert.equal(f.checks, 2);
  assert.ok(f.events.some(value => value.event === 'rpc.failed' && value.details.method === 'sendrawtransaction' && value.details.unknownOutcome === true));
  assert.equal(f.requests.filter(value => value.method === 'sendrawtransaction').length, 1);
});

for (const kind of ['shape', 'incomplete end', 'record limit', 'byte limit']) test(`a cancelled stream alone reports a safe RPC failure for ${kind}`, async t => {
  const f = await stopDiscovery(t);
  const stream = f.client.streams.get(streamId);
  let message;
  if (kind === 'shape') message = malformed.shape();
  else if (kind === 'incomplete end') message = note('stream.end', { complete: false, chunks: 1,
    error: { code: -32001, message: 'private-canary-server-message', data: { node_code: -26, address: 'private-canary-address' } } });
  else {
    // Reach the boundary without allocating a 100,001-row or 64-MiB fixture.
    if (kind === 'record limit') stream.records = 100000;
    else stream.bytes = 64 * 1024 * 1024;
    message = chunk(1, { type: 'bounties', items: [row] });
  }
  const closed = bounded(once(f.clientSocket, 'close'));
  f.socket.write(line(message)); await closed;
  const failures = f.events.filter(value => value.event === 'rpc.failed');
  assert.ok(failures.length >= 1, 'failure must be visible even though the discovery promise already rejected');
  const failure = failures.find(value => value.details.method === 'getblockbounties');
  assert.ok(failure); assert.equal(failure.details.stage, 'stream');
  assert.equal(failure.details.unknownOutcome, false);
  if (kind === 'incomplete end') {
    assert.equal(failure.details.error.code, -32001);
    assert.deepEqual(failure.details.error.data, { node_code: -26 });
  }
  assert.equal(JSON.stringify(f.events).includes('private-canary'), false);
  assert.equal(f.client.streams.size, 0); assert.equal(f.client.pending.size, 0);
});

test('a cancelled stream retains an idle timeout and reports failure when the server never finishes', async t => {
  const f = await stopDiscovery(t, { timeoutMs: 100 });
  await bounded(once(f.clientSocket, 'close'));
  assert.equal(f.client.streams.size, 0); assert.equal(f.client.pending.size, 0);
  assert.ok(f.events.some(value => value.event === 'rpc.failed' && value.details.method === 'getblockbounties' && /timed out/i.test(value.details.error.message)));
});

test('closing the client during an abandoned stream clears its drain without a false RPC failure', async t => {
  const f = await stopDiscovery(t);
  const closed = bounded(once(f.clientSocket, 'close'));
  f.client.close(); await closed;
  assert.equal(f.client.streams.size, 0); assert.equal(f.client.pending.size, 0);
  assert.equal(f.events.some(value => value.event === 'rpc.failed'), false);
});

for (const kind of ['untyped abort', 'uncertain abort']) test(`a ${kind} from a stream callback remains a transport failure`, async t => {
  const f = await localRpc(t);
  const error = kind === 'untyped abort' ? Object.assign(new Error('Callback failed'), { name: 'AbortError' })
    : Object.assign(abortError(), { unknownOutcome: true });
  const reading = f.client.request('getblockbounties', { block_hash: hash }, { onChunk() { throw error; } });
  const rejected = assert.rejects(bounded(reading), /invalid or oversized/i);
  const { socket } = await bounded(f.streaming.promise);
  socket.write(line(chunk(0, snapshot))); await rejected;
  assert.equal(f.client.streams.size, 0);
  assert.ok(f.events.some(value => value.event === 'rpc.failed'));
  assert.equal(f.events.some(value => value.event === 'rpc.cancelled'), false);
});

function serviceFixture(t, directory = '/unused-discovery-cancellation-test') {
  const service = new WalletService({ directory, network: 'testnet4' });
  service.config = { ...structuredClone(DEFAULT_CONFIG), network: 'testnet4' };
  service.epoch = 7; service.session = { data: {} }; service.rpc = {};
  service.engine = { enabled: true, stopped: 0, async stop() { this.enabled = false; this.stopped++; } };
  service.emitState = () => {};
  t.after(() => service.statePublisher.close());
  return service;
}

for (const kind of ['cancelled', 'failure', 'uncertain abort']) test(`discovery ${kind} receives the proper diagnostic and UI treatment`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-discovery-cancellation-'));
  const service = serviceFixture(t, directory);
  service.diagnostics = new DiagnosticLog({ directory });
  t.after(async () => {
    await service.diagnostics.flush();
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith('connectwallet-discovery-cancellation-'));
    await rm(absolute, { recursive: true, force: true });
  });
  const error = kind === 'failure' ? new Error('Invalid bounty metadata.') : abortError();
  if (kind === 'uncertain abort') error.unknownOutcome = true;
  service.syncBountiesInternal = async () => { service.scanningBounties = true; throw error; };
  await assert.rejects(service.syncBounties(), value => value === error);
  await service.diagnostics.flush();
  const log = service.diagnostics.snapshot();
  const stored = (await readFile(log.file, 'utf8')).trim().split('\n').filter(Boolean).map(value => JSON.parse(value));
  assert.equal(log.dropped, 0);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].event, kind === 'cancelled' ? 'wallet.discovery_cancelled' : 'wallet.discovery_failed');
  assert.equal(stored[0].details.stage, 'discovery');
  assert.equal(service.bountySync, null); assert.equal(service.scanningBounties, false);
  if (kind === 'cancelled') {
    assert.equal(service.error, null); assert.equal(service.engine.stopped, 0); assert.equal(service.engine.enabled, true);
    assert.equal(stored[0].details.error, undefined); assert.equal(log.errors, 0); assert.deepEqual(log.recent, []);
  } else {
    assert.equal(service.error, error.message); assert.equal(service.engine.stopped, 1); assert.equal(service.engine.enabled, false);
    assert.equal(log.errors, 1);
  }
});

test('wallet, epoch, RPC and STOP transitions produce typed discovery cancellation before any request', async t => {
  for (const transition of ['wallet locked', 'epoch changed', 'RPC changed']) {
    const service = serviceFixture(t), epoch = service.epoch;
    let calls = 0;
    const rpc = { request() { calls++; throw new Error('Unexpected discovery request'); } };
    service.rpc = rpc;
    if (transition === 'wallet locked') service.session = null;
    if (transition === 'epoch changed') service.epoch++;
    if (transition === 'RPC changed') service.rpc = {};
    await assert.rejects(service.blockBounties(hash, { rpc, epoch }), cancelled, transition);
    if (transition !== 'RPC changed') await assert.rejects(service.syncBountiesInternal(epoch), cancelled, transition);
    assert.equal(calls, 0);
  }
  const stopped = serviceFixture(t); stopped.engine.enabled = false;
  await assert.rejects(stopped.syncBountiesInternal(stopped.epoch), cancelled);
});
