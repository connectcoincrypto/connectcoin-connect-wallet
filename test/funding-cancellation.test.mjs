import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { getEventListeners, once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setImmediate as tick } from 'node:timers/promises';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';
import { RpcClient } from '../src/core/rpc.mjs';
import { serializeTransaction, transactionId } from '../src/core/transaction.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const cancelled = error => error.name === 'AbortError' && error.code === 'ABORT_ERR';
async function bounded(promise, timeoutMs = 500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Funding wait did not settle promptly')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function serviceFixture(t, rpc) {
  // Public BIP39 vector and synthetic transaction only; no wallet files are used.
  const account = deriveAccount('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  account.privateKey.fill(0);
  const transaction = { version: 2, locktime: 0,
    inputs: [{ txid: '99'.repeat(32), vout: 0, sequence: 0xffffffff, scriptSig: '', witness: [] }],
    outputs: [{ type: 2, amount: '1000000000', domain: 'example.com', target: 'f'.repeat(64), rootVersion: 1, mask: 7 }] };
  const raw = serializeTransaction(transaction).toString('hex');
  const bounty = { txid: transactionId(transaction), vout: 0, amount: '1000000000', status: 'available' };
  const service = new WalletService({ directory: '/unused-funding-cancellation-test' });
  service.config = { ...structuredClone(DEFAULT_CONFIG), network: 'testnet4' };
  service.epoch = 7; service.session = { data: {} }; service.rpc = rpc;
  service.tip = { chain: 'testnet4', genesis_hash: GENESIS.testnet4, height: 1, hash: '01'.repeat(32), mediantime: 1800000000 };
  service.engine = { enabled: true };
  service.claimOutpoints = new Map([[`${bounty.txid}:0`, bounty]]);
  service.getState = () => ({ wallet: { address: account.address } });
  t.after(() => service.statePublisher.close());
  return { service, bounty, raw, response: { tip: service.tip, transaction: { hex: raw } } };
}

async function localRpc(t, result) {
  const sockets = new Set(), requests = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        requests.push(request);
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new RpcClient({ host: '127.0.0.1', port: server.address().port, timeoutMs: 2000, windowMs: 1000 });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { client, requests };
}

for (const stage of ['quota', 'connection']) test(`STOP during funding ${stage} abandons preparation but preserves the shared read and cache`, async t => {
  const { service, bounty, raw, response } = serviceFixture(t);
  const { client, requests } = await localRpc(t, response);
  service.rpc = client;
  const entered = deferred(), gate = deferred();
  t.after(() => gate.resolve());
  if (stage === 'quota') {
    client.history.set('gettransaction', Array(client.quota).fill(performance.now()));
    const pace = client.pace.bind(client);
    client.pace = (...args) => { const waiting = pace(...args); entered.resolve(); return waiting; };
  } else {
    const connect = client.connect.bind(client);
    client.connect = async () => { const socket = await connect(); entered.resolve(); await gate.promise; return socket; };
  }
  const controller = new AbortController();
  // Exercise cancellation of both the creator and a later waiter of the read.
  let other = stage === 'connection' ? service.funding(bounty.txid) : null;
  const preparation = service.prepareAutomaticClaim(bounty, { signal: controller.signal });
  const rejected = assert.rejects(bounded(preparation), cancelled);
  other ??= service.funding(bounty.txid);
  await bounded(entered.promise);
  assert.deepEqual(requests, []);
  assert.equal(service.fundingPending.size, 1);
  service.engine.enabled = false; controller.abort(); await rejected;
  assert.equal(service.fundingPending.size, 1, 'cancelling a waiter must not discard shared work');
  assert.equal(client.closed, false);
  assert.equal(client.queuedRequests, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  gate.resolve();
  assert.equal(await bounded(other, 2000), raw);
  assert.equal(service.fundingPending.size, 0);
  assert.equal(service.fundingCache.get(bounty.txid), raw);
  assert.equal(await service.funding(bounty.txid), raw);
  assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
    { method: 'gettransaction', params: { txid: bounty.txid } },
  ]);
  assert.equal(service.reserved.size, 0);
  assert.equal(service.error, null);
});

test('an eventual shared failure after the only waiter aborts is observed and permits a fresh read', async t => {
  const read = deferred(), entered = deferred(), unhandled = [];
  const listener = error => unhandled.push(error);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  let calls = 0;
  const { service, bounty, raw, response } = serviceFixture(t, { request(method, params, options) {
    assert.equal(method, 'gettransaction'); assert.deepEqual(params, { txid: bounty.txid });
    assert.equal(options?.signal, undefined, 'the shared RPC must outlive an individual claim signal');
    calls++; entered.resolve(); return calls === 1 ? read.promise : Promise.resolve(response);
  } });
  const controller = new AbortController();
  const rejected = assert.rejects(bounded(service.prepareAutomaticClaim(bounty, { signal: controller.signal })), cancelled);
  await entered.promise; controller.abort(); await rejected;
  assert.equal(service.fundingPending.size, 1);
  read.reject(new Error('Synthetic funding RPC failure'));
  await tick(); await tick();
  assert.deepEqual(unhandled, []);
  assert.equal(service.fundingPending.size, 0);
  assert.equal(service.fundingCache.size, 0);
  assert.equal(await service.funding(bounty.txid), raw);
  assert.equal(calls, 2);
});

test('already-aborted funding and preparation start no RPC, including a cached funding read', async t => {
  let calls = 0;
  const { service, bounty, raw } = serviceFixture(t, { request() { calls++; throw new Error('Unexpected RPC'); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.funding(bounty.txid, { signal: controller.signal }), cancelled);
  await assert.rejects(service.prepareAutomaticClaim(bounty, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(service.fundingPending.size, 0);
  service.fundingCache.set(bounty.txid, raw);
  await assert.rejects(service.funding(bounty.txid, { signal: controller.signal }), cancelled);
  assert.equal(calls, 0);
  assert.equal(service.fundingCache.get(bounty.txid), raw);
});
