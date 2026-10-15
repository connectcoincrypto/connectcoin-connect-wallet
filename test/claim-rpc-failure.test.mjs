import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletService } from '../src/core/wallet-service.mjs';
import { RpcClient } from '../src/core/rpc.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { bountyKey } from '../src/core/bounty-discovery.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';
import { attachClaimProof, parseTransaction, serializeTransaction, transactionId } from '../src/core/transaction.mjs';

const hash = value => value.toString(16).padStart(64, '0');
const tip = { chain: 'testnet4', genesis_hash: GENESIS.testnet4, height: 0, hash: GENESIS.testnet4, mediantime: 1800000000 };
const frame = value => JSON.stringify(value) + '\n';
async function until(predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail('Timed out waiting for the isolated RPC fixture.');
}

function funding(index) {
  const transaction = { version: 2, locktime: 0,
    inputs: [{ txid: hash(index + 1), vout: 0, scriptSig: '', sequence: 0xffffffff, witness: [] }],
    outputs: [{ type: 2, amount: '1000000000', domain: 'example.com', target: 'f'.repeat(64), rootVersion: 1, mask: 7 }] };
  return { hex: serializeTransaction(transaction).toString('hex'),
    bounty: { txid: transactionId(transaction), vout: 0, amount: '1000000000', domain: 'example.com',
      connection_work_target: 'f'.repeat(64), root_certificates_version: 1, signature_algorithms_mask: 7,
      block_height: 0, block_hash: tip.hash, coinbase: false, confirmations: 1, status: 'available', spending_txid: null } };
}

function structuralProof(prepared) {
  // Proof authentication is covered by the native helper tests. This fixture
  // seeds an already-verified winner and tests only its transport/lifecycle.
  const hello = Buffer.concat([Buffer.from('010000220303', 'hex'), Buffer.from(prepared.challenge, 'hex')]);
  return Buffer.concat([Buffer.from([2]), hello, ...[2, 8, 11, 15].map(type => Buffer.from([type, 0, 0, 0]))]).toString('hex');
}

async function fixture(t, { initialHeight = 0, initialHash = initialHeight ? hash(initialHeight + 100) : tip.hash, timeoutMs = 500 } = {}) {
  const parents = [funding(0), funding(1), funding(2)], rows = parents.map(parent => parent.bounty);
  const initialTip = { ...tip, height: initialHeight, hash: initialHash };
  for (const row of rows) { row.block_height = initialHeight; row.block_hash = initialHash; }
  const state = { stallStream: false, failingFunding: null, retries: 0, disconnected: 0,
    receipt: 'pending', claimHex: null, rejectClaim: false, events: [], tip: initialTip };
  const sockets = new Set(), requests = [];
  let nextStream = 0, service;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString('utf8');
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        requests.push(request);
        const reply = result => socket.write(frame({ jsonrpc: '2.0', id: request.id, result }));
        if (request.method === 'getbountychanges') {
          const changes = state.events.splice(0);
          state.sequence = changes.at(-1)?.sequence ?? state.sequence ?? 0;
          reply({ tip: state.tip, next_cursor: `next-cursor-${state.sequence}`, changes, has_more: false });
        }
        else if (request.method === 'getrecentblockhashes') reply({ tip: state.tip, window: 600,
          blocks: Array.from({ length: Math.min(request.params.count ?? 600, state.tip.height + 1) }, (_, index) => {
            const height = state.tip.height - index; return { height, hash: height ? hash(height + 100) : tip.hash };
          }) });
        else if (request.method === 'getchaintip') reply(state.tip);
        else if (request.method === 'gettransactionstatus') {
          if (!state.compactReceipts) socket.write(frame({ jsonrpc: '2.0', id: request.id,
            error: { code: -32601, message: 'Legacy fixture lacks compact receipts.' } }));
          else if (state.receipt === 'missing' || state.receipt === 'backend-error') socket.write(frame({ jsonrpc: '2.0', id: request.id,
            error: { code: state.receipt === 'missing' ? -32004 : -32002, message: 'Receipt unavailable.' } }));
          else reply({ tip: state.tip, txid: request.params.txid, status: state.receipt,
            confirmations: state.receipt === 'confirmed' ? state.tip.height + 1 : 0,
            ...(state.receipt === 'confirmed' ? { block_height: 0, block_hash: tip.hash } : {}), ...state.receiptOverride });
        }
        else if (request.method === 'gettransaction') {
          const heldParent = state.holdFundingEntries?.get(request.params.txid);
          if (heldParent) state.releaseFunding.push(() => reply({ tip: state.tip, transaction: { hex: heldParent.hex } }));
          else if (request.params.txid === state.failingFunding) {
            socket.write(frame({ jsonrpc: '2.0', id: request.id,
              error: { code: -32002, message: 'Transaction unavailable from the backend; retry after synchronization.' } }));
          } else {
            const parent = parents.find(value => value.bounty.txid === request.params.txid);
            if (parent) reply({ tip: state.tip, transaction: { hex: parent.hex } });
            else if (state.holdReceipt) state.heldReceipt = result => result ? reply(result) : socket.write(frame({ jsonrpc: '2.0', id: request.id,
              error: { code: -32004, message: 'Isolated delayed missing receipt.' } }));
            else if (state.receipt === 'missing' || state.receipt === 'backend-error') socket.write(frame({ jsonrpc: '2.0', id: request.id,
              error: { code: state.receipt === 'missing' ? -32004 : -32002, message: 'Isolated receipt unavailable.' } }));
            else reply({ tip: state.tip, status: state.receipt, ...(state.receipt === 'confirmed' ? { block_height: 0, block_hash: tip.hash } : {}),
              transaction: { hex: state.claimHex }, ...state.receiptOverride });
          }
        } else if (request.method === 'getblockbounties') {
          const stream_id = `stream-${++nextStream}`;
          reply({ stream_id });
          socket.write([
            { jsonrpc: '2.0', method: 'stream.chunk', params: { stream_id, sequence: 0,
              items: { type: 'snapshot', tip: state.tip, block_hash: request.params.block_hash, cursor: 'stream-cursor', unit: 'connects' } } },
            { jsonrpc: '2.0', method: 'stream.chunk', params: { stream_id, sequence: 1,
              items: { type: 'bounties', tip: state.tip, items: rows.filter(row => row.block_hash === request.params.block_hash) } } },
          ].map(frame).join(''));
          if (!state.stallStream) socket.write([
            { jsonrpc: '2.0', method: 'stream.chunk', params: { stream_id, sequence: 2,
              items: { type: 'state', tip: state.tip, cursor: 'stream-cursor' } } },
            { jsonrpc: '2.0', method: 'stream.end', params: { stream_id, complete: true, chunks: 3 } },
          ].map(frame).join(''));
        } else if (request.method === 'sendrawtransaction') {
          if (state.rejectClaim) socket.write(frame({ jsonrpc: '2.0', id: request.id,
            error: { code: -32020, message: 'Isolated explicit rejection.', data: { node_code: -26 } } }));
          else {
            state.claimHex = request.params.transaction_hex;
            const accepted = { txid: transactionId(parseTransaction(state.claimHex)) };
            if (state.holdClaim) state.heldClaim = error => error
              ? socket.write(frame({ jsonrpc: '2.0', id: request.id, error })) : reply(accepted);
            else reply(accepted);
          }
        } else assert.fail(`Unexpected RPC method ${request.method}`);
      }
    });
  });
  t.after(async () => {
    service?.stopLiveUpdates(); service?.rpc.close();
    await service?.engine.stop(); service?.releaseClaimCatalog(); service?.statePublisher.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  // Public BIP39 test vector only, memory-only service; no profile, helper,
  // external RPC, or public TLS endpoint is read, started or contacted.
  const account = deriveAccount('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  account.privateKey.fill(0);
  service = new WalletService({ directory: '/unused-claim-rpc-failure-test',
    clientFactory: options => new RpcClient({ ...options, timeoutMs }),
    proofRunner: () => assert.fail('A retained winner must not generate another TLS proof.') });
  service.config = { ...structuredClone(DEFAULT_CONFIG), network: 'testnet4',
    rpc: { host: '127.0.0.1', port: server.address().port } };
  service.config.claims.enabled = true; service.session = { data: {} };
  service.emitState = () => {}; service.getState = () => ({ wallet: { address: account.address } });
  service.connectClient(); service.createEngine();
  service.rpc.on('disconnected', () => { state.disconnected++; });
  service.bountyUpdates.close();
  service.bountyUpdates = { request() { state.retries++; }, close() {} };
  // Drive individual service/engine transitions explicitly, without a TLS
  // coordinator. All RPC framing, response classification and writes are real.
  service.engine.kick = () => {}; service.engine.enabled = true; service.tip = initialTip;
  const knownRows = rows.slice(0, 2);
  service.claimOutpoints = new Map(knownRows.map(row => [bountyKey(row), row]));
  service.claimBlocks = new Map([[initialHash, knownRows]]); service.claimCursor = 'saved-cursor';
  service.engine.enqueue(knownRows);
  const prepared = await service.prepareAutomaticClaim(rows[0]);
  const key = bountyKey(rows[0]), job = service.engine.queue.get(key);
  job.prepared = prepared; job.winner = true;
  const winner = { proof: structuralProof(prepared), context: prepared.context, due: 0, failures: 0 };
  service.engine.pendingProofs.set(key, winner); service.engine.proposals.set(key, prepared);
  service.engine.successCounts.set(key, 1n); service.engine.state.attempts = 1;
  return { service, rows, state, requests, prepared, key, job, winner };
}

async function submitOnce(f) {
  const { service, job, key, winner, prepared, requests } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const sends = requests.filter(request => request.method === 'sendrawtransaction');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params.transaction_hex, attachClaimProof(prepared, winner.proof).hex);
  assert.equal(service.engine.pendingProofs.has(key), false);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  assert.equal(service.engine.successCounts.get(key), 1n); assert.equal(service.claimsReviewRequired, false);
}

async function captureBehindCatalogBarrier(f) {
  const { service, job, key, prepared, requests } = f, gates = [], contexts = [];
  // The adapter represents an already-authenticated native response. Exercise
  // the real engine/service ownership and RPC path, not TLS cryptography here.
  service.engine.pendingProofs.delete(key); service.engine.successCounts.delete(key);
  service.engine.state.attempts = 0; job.winner = false;
  service.engine.pool = { pacesStarts: true,
    async setAdmissionAllowed(allowed) { gates.push(allowed); }, async close() {},
    async attempt(context, callbacks) {
      contexts.push(context); callbacks.onStarted(); callbacks.onCapture({ captured: true });
      return { started: true, captured: true, verified: true, proof: structuralProof(prepared),
        validationPassed: true, seconds: 0.01 };
    },
  };
  service.blockClaimCatalog('journal-reset');
  assert.deepEqual(gates, [true]);
  assert.equal(service.engine.catalogBlocked, true); assert.equal(service.engine.preparedCapturesAllowed, true);
  assert.equal(service.engine.ready(job), true);
  const unprepared = service.engine.queue.get(bountyKey(f.rows[1]));
  assert.equal(service.engine.ready(unprepared), false, 'Only authenticated preparations may keep capturing.');
  service.engine.dispatch([key, job], service.engine.generation);
  await Promise.all([...service.engine.tasks]);
  assert.equal(contexts.length, 1);
  assert.equal(service.engine.state.attempts, 1); assert.equal(service.engine.state.completed, 0);
  assert.equal(service.engine.successCounts.get(key), 1n);
  f.winner = service.engine.pendingProofs.get(key);
  assert.equal(f.winner.proof, structuralProof(prepared));
  assert.equal(service.engine.submitting.size, 0);
  assert.equal(requests.some(request => request.method === 'sendrawtransaction'), false);
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  assert.equal(requests.some(request => request.method === 'sendrawtransaction'), false);
  return { gates, contexts };
}

test('compact pending/confirmed receipts retain the proof until canonical confirmation without downloading it', async t => {
  const f = await fixture(t), { service, state, requests, key, winner } = f;
  state.compactReceipts = true; await submitOnce(f);
  const saved = service.engine.acceptedProofs.get(key);
  saved.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.strictEqual(service.engine.acceptedProofs.get(key), saved);
  assert.equal(saved.pending.proof, winner.proof);
  assert.equal(requests.filter(r => r.method === 'gettransactionstatus').length, 1);
  assert.equal(requests.filter(r => r.method === 'gettransaction' && r.params.txid === saved.txid).length, 0);
  state.receipt = 'confirmed'; saved.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.equal(service.engine.acceptedProofs.has(key), false);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  assert.equal(requests.filter(r => r.method === 'gettransactionstatus').length, 2);
});

test('compact missing receipt replays the identical saved witness, counting acceptance once', async t => {
  const f = await fixture(t), { service, state, requests, key } = f;
  state.compactReceipts = true; await submitOnce(f);
  const saved = service.engine.acceptedProofs.get(key), raw = state.claimHex;
  state.receipt = 'missing'; saved.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  const job = service.engine.queue.get(key); assert.ok(job);
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  assert.deepEqual(requests.filter(r => r.method === 'sendrawtransaction').map(r => r.params.transaction_hex), [raw, raw]);
});

for (const override of [{ txid: hash(987) }, { confirmations: 99 }, { status: 'unknown' }, { block_hash: hash(789) }]) {
  test(`malformed compact receipt ${JSON.stringify(override)} never falls back or erases the proof`, async t => {
    const f = await fixture(t), { service, state, requests, key } = f;
    state.compactReceipts = true; await submitOnce(f);
    const saved = service.engine.acceptedProofs.get(key);
    state.receipt = 'confirmed'; state.receiptOverride = override;
    saved.due = 0; service.claimReceiptNext = 0; await service.syncBounties();
    assert.strictEqual(service.engine.acceptedProofs.get(key), saved);
    assert.equal(service.engine.state.completed, 1);
    assert.equal(requests.filter(r => r.method === 'gettransaction' && r.params.txid === saved.txid).length, 0);
    assert.notEqual(service.bountyCapabilities.claimStatus, false);
  });
}

test('a modified local saved proof cannot be discarded by a compact confirmation', async t => {
  const f = await fixture(t), { service, state, requests, key } = f;
  state.compactReceipts = true; await submitOnce(f);
  const saved = service.engine.acceptedProofs.get(key);
  saved.pending.proof += '00'; state.receipt = 'confirmed'; saved.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.strictEqual(service.engine.acceptedProofs.get(key), saved);
  assert.equal(requests.filter(r => r.method === 'gettransactionstatus').length, 0);
});

test('legacy receipt fallback is negotiated once without dropping witness validation', async t => {
  const f = await fixture(t), { service, requests, key } = f;
  await submitOnce(f);
  const saved = service.engine.acceptedProofs.get(key);
  for (let turn = 0; turn < 2; turn++) {
    saved.due = 0; service.claimReceiptNext = 0; await service.syncBounties();
    assert.strictEqual(service.engine.acceptedProofs.get(key), saved);
  }
  assert.equal(requests.filter(r => r.method === 'gettransactionstatus').length, 1);
  assert.equal(requests.filter(r => r.method === 'gettransaction' && r.params.txid === saved.txid).length, 2);
});

for (const code of [-32602, -32002, -32029]) test(`compact status ${code} is not a compatibility signal`, async t => {
  const f = await fixture(t), { service, key } = f;
  await submitOnce(f);
  const saved = service.engine.acceptedProofs.get(key), calls = [];
  const request = service.rpc.request.bind(service.rpc);
  service.rpc.request = async (method, params, options) => {
    calls.push(method);
    if (method === 'gettransactionstatus') throw Object.assign(new Error('Synthetic failure'), { code });
    return request(method, params, options);
  };
  await assert.rejects(service.readClaimReceipt(saved, () => {}), { code });
  assert.deepEqual(calls, ['gettransactionstatus']);
  assert.strictEqual(service.engine.acceptedProofs.get(key), saved);
  assert.notEqual(service.bountyCapabilities.claimStatus, false);
});

for (const transition of ['connection', 'proof']) test(`compact receipt rejects a ${transition} change during its read`, async t => {
  const f = await fixture(t), { service, state, key } = f;
  await submitOnce(f);
  const saved = service.engine.acceptedProofs.get(key);
  let release, entered;
  const enteredRead = new Promise(resolve => { entered = resolve; });
  const reply = new Promise(resolve => { release = resolve; });
  service.rpc.request = async () => { entered(); return reply; };
  const receipt = service.readClaimReceipt(saved, () => {});
  const rejected = assert.rejects(receipt);
  await enteredRead;
  if (transition === 'connection') service.bountyCapabilities = {};
  else saved.pending.proof += '00';
  release({ tip: state.tip, txid: saved.txid, status: 'confirmed', confirmations: 1, block_height: 0, block_hash: tip.hash });
  await rejected;
  assert.strictEqual(service.engine.acceptedProofs.get(key), saved);
});

test('wallet catalog barrier permits prepared TLS work but keeps its winner unsent until a coherent snapshot releases it', async t => {
  const f = await fixture(t), { service, requests, key } = f;
  const { gates, contexts } = await captureBehindCatalogBarrier(f);
  assert.equal(contexts[0].validation_time, tip.mediantime);
  const winner = service.engine.pendingProofs.get(key);
  await service.syncBounties();
  assert.equal(service.claimCatalogGate, null); assert.equal(service.engine.catalogBlocked, false);
  assert.strictEqual(service.engine.pendingProofs.get(key), winner);
  assert.equal(gates.at(-1), true);
  assert.ok(requests.some(request => request.method === 'getrecentblockhashes'));
  assert.equal(requests.some(request => request.method === 'sendrawtransaction'), false);
  await submitOnce(f);
  assert.equal(contexts.length, 1, 'The retained proof is submitted without another capture.');
});

for (const invalidation of ['spent', 'reorg', 'lock', 'disconnect']) {
test(`wallet catalog barrier never sends a retained winner after ${invalidation}`, async t => {
  const f = await fixture(t, { initialHeight: 1 }), { service, rows, state, requests, key } = f;
  await captureBehindCatalogBarrier(f);
  if (invalidation === 'spent') {
    rows[0].status = 'spent'; rows[0].spending_txid = hash(999);
    state.events = [{ type: 'spent', sequence: 1, txid: rows[0].txid, vout: 0, spending_txid: hash(999) }];
    await service.syncBounties();
  } else if (invalidation === 'reorg') {
    state.tip = { ...tip };
    await service.syncBounties();
  } else if (invalidation === 'lock') await service.lock();
  else {
    service.rpc.socket.destroy(); await until(() => state.disconnected === 1); await service.claimSuspending;
  }
  service.engine.retrySubmissions(service.engine.generation);
  await Promise.all([...service.engine.tasks]);
  assert.equal(requests.some(request => request.method === 'sendrawtransaction'), false);
  assert.equal(service.engine.state.completed, 0);
  assert.equal(service.engine.state.attempts, invalidation === 'lock' ? 0 : 1);
  if (invalidation === 'disconnect') {
    assert.equal(service.engine.enabled, false);
    assert.strictEqual(service.engine.pendingProofs.get(key), f.winner, 'Disconnect preserves the proof without authorizing transmission.');
    assert.equal(service.engine.successCounts.get(key), 1n);
  } else assert.equal(service.engine.pendingProofs.has(key), false);
  assert.equal(service.claimsReviewRequired, false);
});
}

test('wallet capture validation time uses current tip then retained anchor and only gated prepared context', async t => {
  const { service, prepared } = await fixture(t);
  const current = { ...tip, mediantime: tip.mediantime + 20 }, anchor = { ...tip, mediantime: tip.mediantime + 10 };
  service.claimWindow = { tip: anchor }; service.blockClaimCatalog('tip-confirmation');
  service.tip = current;
  assert.equal(service.engine.getValidationTime(prepared.context), current.mediantime);
  service.tip = null;
  assert.equal(service.engine.getValidationTime(prepared.context), anchor.mediantime);
  service.claimWindow = null;
  assert.equal(service.engine.getValidationTime(prepared.context), prepared.context.validation_time);
  service.releaseClaimCatalog();
  assert.throws(() => service.engine.getValidationTime(prepared.context), /invalid chain tip/);
  service.claimWindow = { tip: anchor };
  assert.throws(() => service.engine.getValidationTime(prepared.context), /invalid chain tip/,
    'An old anchor cannot supply validation time outside the resync barrier.');
  service.blockClaimCatalog('tip-confirmation');
  service.tip = { ...current, mediantime: 'private-invalid-time' };
  assert.throws(() => service.engine.getValidationTime(prepared.context), /invalid chain tip/);
  service.tip = null; service.claimWindow.tip = { ...anchor, genesis_hash: hash(888) };
  assert.throws(() => service.engine.getValidationTime(prepared.context), /invalid chain tip/,
    'Malformed current/anchor metadata must not silently fall back to a prepared context.');
});

for (const gated of [false, true]) test(`local RPC queue pressure after cancelled funding reads retries discovery ${gated ? 'behind the reset gate' : 'without a reset'} and preserves one winner`, async t => {
  const f = await fixture(t, { timeoutMs: 5000 }), { service, state, key, winner, job, requests } = f;
  const parents = Array.from({ length: 32 }, (_, index) => funding(index + 100));
  state.holdFundingEntries = new Map(parents.map(parent => [parent.bounty.txid, parent]));
  state.releaseFunding = [];
  for (const [index, parent] of parents.entries()) {
    const controller = new AbortController();
    const waiter = service.funding(parent.bounty.txid, { signal: controller.signal }).catch(error => error);
    await until(() => service.rpc.queuedRequests === index + 1);
    controller.abort();
    assert.equal((await waiter).name, 'AbortError');
  }
  await until(() => state.releaseFunding.length === 12);
  assert.equal(service.rpc.pending.size, 12); assert.equal(service.rpc.capacityWaiters.length, 20);
  assert.equal(service.fundingPending.size, 32, 'Cancelled consumers leave their shared funding reads owned until completion.');
  if (gated) service.blockClaimCatalog();
  const oldBlocks = service.claimBlocks, oldOutpoints = service.claimOutpoints, oldCursor = service.claimCursor;
  await assert.rejects(service.syncBounties(), error => error.code === 'RPC_QUEUE_FULL' && error.notSent === true && !error.unknownOutcome);
  await service.engine.stopping;
  assert.equal(service.engine.enabled || service.claimsResumePending, true,
    'Temporary local backpressure must not permanently disable claims on a live socket.');
  assert.ok(state.retries >= 1, 'Discovery queues a bounded retry without needing another block or user action.');
  assert.strictEqual(service.engine.pendingProofs.get(key), winner); assert.strictEqual(service.engine.queue.get(key), job);
  assert.strictEqual(service.claimBlocks, oldBlocks); assert.strictEqual(service.claimOutpoints, oldOutpoints);
  assert.equal(service.claimCursor, oldCursor); assert.equal(service.claimsReviewRequired, false);
  assert.equal(service.engine.state.attempts, 1); assert.equal(service.engine.state.completed, 0);
  assert.equal(service.engine.successCounts.get(key), 1n); assert.equal(state.disconnected, 0);
  assert.equal(requests.some(request => request.method === 'sendrawtransaction'), false);
  for (let index = 0; index < parents.length; index++) {
    await until(() => state.releaseFunding.length > index); state.releaseFunding[index]();
  }
  await until(() => service.rpc.queuedRequests === 0 && service.fundingPending.size === 0);
  if (service.engine.enabled) await service.syncBounties();
  else { await service.resumeClaims({ retryErrors: true }); await service.bountySync; }
  assert.equal(service.engine.enabled, true); assert.equal(service.claimsResumePending, false);
  assert.equal(service.claimCatalogGate, null); assert.equal(service.claimCursor, 'next-cursor-0');
  assert.strictEqual(service.engine.pendingProofs.get(key), winner);
  await submitOnce(f);
});

test('an unclassified discovery error is not retryable merely because its message resembles local queue pressure', async t => {
  const { service, state, key, winner } = await fixture(t);
  t.mock.method(service.rpc, 'request', async () => {
    throw Object.assign(new Error('Too many queued RPC requests; retry shortly.'), { notSent: true });
  });
  await assert.rejects(service.syncBounties(), /Too many queued RPC requests/);
  await service.engine.stopping;
  assert.equal(service.engine.enabled, false); assert.equal(service.claimsResumePending, false);
  assert.equal(state.retries, 0); assert.strictEqual(service.engine.pendingProofs.get(key), winner);
  assert.equal(service.engine.state.attempts, 1); assert.equal(service.engine.state.completed, 0);
});

for (const timeoutKind of ['idle', 'total-deadline']) {
test(`a real bounty stream ${timeoutKind} timeout preserves the winner, rejects partial publication and resumes one identical submission`, async t => {
  let deadlineTimers = 0;
  if (timeoutKind === 'total-deadline') {
    // Exercise the real fixed 180-second deadline without changing production
    // timeout settings or waiting three minutes. Other timers are untouched.
    const setTimer = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
      if (milliseconds === 180000) { deadlineTimers++; milliseconds = 250; }
      return setTimer(callback, milliseconds, ...args);
    });
  }
  const f = await fixture(t), { service, state, key, winner, job, requests, rows } = f;
  // A reset must start with a fresh private snapshot, not reuse the old block.
  service.claimCursor = null;
  const oldBlocks = service.claimBlocks, oldOutpoints = service.claimOutpoints;
  state.stallStream = true;
  await assert.rejects(service.syncBounties(), timeoutKind === 'idle'
    ? /Bounty transfer timed out/ : /Bounty transfer exceeded its total time limit/);
  if (timeoutKind === 'total-deadline') assert.equal(deadlineTimers, 1);
  await until(() => state.disconnected === 1); await service.claimSuspending;
  assert.strictEqual(service.claimBlocks, oldBlocks); assert.strictEqual(service.claimOutpoints, oldOutpoints);
  assert.equal(service.claimOutpoints.has(bountyKey(rows[2])), false, 'A streamed row is not published before the complete end frame.');
  assert.equal(service.claimCursor, null, 'The stream cursor is never a committed discovery cursor.');
  assert.strictEqual(service.engine.pendingProofs.get(key), winner); assert.strictEqual(service.engine.queue.get(key), job);
  assert.equal(service.engine.state.attempts, 1); assert.equal(service.engine.state.completed, 0);
  assert.equal(service.engine.successCounts.get(key), 1n);
  assert.equal(service.claimsResumePending, true); assert.ok(state.retries >= 1);
  assert.equal(service.claimsReviewRequired, false);
  assert.equal(requests.some(request => request.method === 'sendrawtransaction'), false);
  state.stallStream = false;
  await service.resumeClaims({ retryErrors: true }); await service.bountySync;
  assert.equal(service.claimCursor, 'next-cursor-0'); assert.equal(service.claimCatalogGate, null);
  assert.equal(service.claimOutpoints.has(bountyKey(rows[2])), true);
  assert.equal(service.engine.enabled, true); assert.equal(service.claimsResumePending, false);
  assert.strictEqual(service.engine.pendingProofs.get(key), winner);
  await submitOnce(f);
});
}

test('an endpoint edit cancels a proven-unsent reservation, preserves the winner and revalidates identical bytes on the replacement', async t => {
  const f = await fixture(t), { service, key, requests, winner, prepared } = f;
  const directory = await mkdtemp(join(tmpdir(), 'wallet-endpoint-claim-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  service.directory = directory; service.configOptions.network = 'testnet4';
  const originalPort = service.config.rpc.port, oldRpc = service.rpc;
  service.clientFactory = options => new RpcClient({ ...options, port: originalPort, timeoutMs: 500 });
  const connect = service.connectClient.bind(service);
  service.connectClient = () => {
    connect(); service.liveUpdates.start = () => {};
    service.bountyUpdates.close(); service.bountyUpdates = { request() {}, close() {} };
  };
  service.refresh = async () => {};
  oldRpc.cooldowns.set('sendrawtransaction', performance.now() + 60000);
  service.engine.retrySubmissions(service.engine.generation);
  await until(() => service.reserved.has(key));
  assert.equal(requests.some(request => request.method === 'sendrawtransaction'), false);
  await service.applyConfig({ rpc: { port: originalPort === 65535 ? originalPort - 1 : originalPort + 1 } });
  await service.bountySync;
  assert.notEqual(service.rpc, oldRpc); assert.equal(service.reserved.has(key), false);
  assert.strictEqual(service.engine.pendingProofs.get(key), winner);
  assert.equal(service.engine.state.attempts, 1); assert.equal(service.engine.state.completed, 0);
  const job = service.engine.queue.get(key); assert.ok(job);
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const sends = requests.filter(request => request.method === 'sendrawtransaction');
  assert.equal(sends.length, 1); assert.equal(sends[0].params.transaction_hex, attachClaimProof(prepared, winner.proof).hex);
  assert.strictEqual(job.prepared.rpc, service.rpc);
  assert.equal(requests.filter(request => request.method === 'gettransaction' && request.params.txid === prepared.bounty.txid).length, 2,
    'The replacement endpoint must reauthenticate the parent, not trust old cached bytes.');
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
});

for (const lateOutcome of ['ack', 'rejection', 'ambiguous-error']) test(`confirmation of a revalidated endpoint proposal is not resurrected by its late ${lateOutcome}`, async t => {
  const f = await fixture(t), { service, key, state, rows, requests, winner, prepared } = f;
  const directory = await mkdtemp(join(tmpdir(), 'wallet-endpoint-confirmation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  service.directory = directory; service.configOptions.network = 'testnet4';
  const originalPort = service.config.rpc.port, oldRpc = service.rpc;
  service.clientFactory = options => new RpcClient({ ...options, port: originalPort, timeoutMs: 500 });
  const connect = service.connectClient.bind(service);
  service.connectClient = () => {
    connect(); service.liveUpdates.start = () => {};
    service.bountyUpdates.close(); service.bountyUpdates = { request() {}, close() {} };
  };
  service.refresh = async () => {};
  oldRpc.cooldowns.set('sendrawtransaction', performance.now() + 60000);
  service.engine.retrySubmissions(service.engine.generation);
  await until(() => service.reserved.has(key));
  await service.applyConfig({ rpc: { port: originalPort === 65535 ? originalPort - 1 : originalPort + 1 } });
  await service.bountySync;
  const job = service.engine.queue.get(key);
  assert.strictEqual(job.prepared, prepared);
  assert.equal(service.engine.acceptedProofs.has(key), false);
  state.holdClaim = true;
  const sending = service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  await until(() => typeof state.heldClaim === 'function');
  assert.notStrictEqual(job.prepared, prepared, 'Endpoint revalidation must produce a new context owner.');
  assert.strictEqual(job.prepared.rpc, service.rpc);
  rows[0].status = 'pending_spend'; rows[0].spending_txid = prepared.txid;
  state.events = [{ type: 'pending_spend', sequence: 1, txid: rows[0].txid, vout: 0, spending_txid: prepared.txid }];
  await service.syncBounties();
  assert.strictEqual(service.engine.acceptedProofs.get(key)?.prepared, job.prepared);
  state.receipt = 'confirmed'; service.engine.acceptedProofs.get(key).due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.equal(service.engine.acceptedProofs.has(key), false);
  assert.equal(service.engine.state.completed, 1);
  state.heldClaim(lateOutcome === 'ack' ? null : lateOutcome === 'rejection'
    ? { code: -32020, message: 'Late policy rejection.', data: { node_code: -26 } }
    : { code: -32002, message: 'Late uncertain backend response.' });
  await sending;
  assert.equal(service.engine.acceptedProofs.has(key), false, 'The late response must not resurrect an already-confirmed witness owner.');
  assert.equal(service.engine.queue.has(key), false); assert.equal(service.engine.pendingProofs.has(key), false);
  assert.equal(service.reserved.has(key), true); assert.equal(service.claimsReviewRequired, false);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  assert.equal(service.engine.successCounts.get(key), 1n);
  const sends = requests.filter(request => request.method === 'sendrawtransaction');
  assert.equal(sends.length, 1); assert.equal(sends[0].params.transaction_hex, attachClaimProof(prepared, winner.proof).hex);
});

test('an explicit rejection retains the same winner and releases only its unsent bounty reservation', async t => {
  const f = await fixture(t), { service, key, state, winner, job, requests } = f;
  state.rejectClaim = true;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  assert.equal(service.reserved.has(key), false); assert.strictEqual(service.engine.pendingProofs.get(key), winner);
  assert.equal(service.engine.state.completed, 0); assert.equal(service.claimsReviewRequired, false);
  state.rejectClaim = false;
  await service.syncBounties();
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const sends = requests.filter(request => request.method === 'sendrawtransaction');
  assert.equal(sends.length, 2); assert.equal(sends[0].params.transaction_hex, sends[1].params.transaction_hex);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
});

test('a rejected winner survives a transient competing mempool spend and reopens with its original proof', async t => {
  const f = await fixture(t), { service, key, state, winner, job, requests, rows } = f;
  state.rejectClaim = true;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  state.events = [{ type: 'pending_spend', sequence: 1, txid: rows[0].txid, vout: 0, spending_txid: hash(999) }];
  rows[0].status = 'pending_spend'; rows[0].spending_txid = hash(999);
  await service.syncBounties();
  assert.equal(service.engine.queue.has(key), false);
  rows[0].status = 'available'; rows[0].spending_txid = null;
  state.events = [{ type: 'available_again', sequence: 2, txid: rows[0].txid, vout: 0, block_hash: tip.hash }];
  state.rejectClaim = false; state.receipt = 'missing'; service.claimReceiptNext = 0;
  for (const saved of service.engine.acceptedProofs.values()) saved.due = 0;
  await service.syncBounties();
  assert.equal(service.engine.pendingProofs.get(key)?.proof, winner.proof);
  const replay = service.engine.queue.get(key); assert.ok(replay?.winner);
  await service.engine.submitVerified(replay, new AbortController(), service.engine.generation);
  const sends = requests.filter(request => request.method === 'sendrawtransaction');
  assert.equal(sends.length, 2); assert.equal(sends[0].params.transaction_hex, sends[1].params.transaction_hex);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
});

for (const waitingForSlot of [false, true]) for (const nextState of ['available', 'spent']) test(`a verified winner awaiting its first submission ${waitingForSlot ? 'at RPC quota' : 'in the queue'} survives a competing pending spend, then respects ${nextState}`, async t => {
  const f = await fixture(t), { service, key, state, winner, requests, rows, prepared } = f;
  if (waitingForSlot) {
    service.rpc.cooldowns.set('sendrawtransaction', performance.now() + 60000);
    service.engine.retrySubmissions(service.engine.generation);
    await until(() => service.reserved.has(key));
  }
  state.events = [{ type: 'pending_spend', sequence: 1, txid: rows[0].txid, vout: 0, spending_txid: hash(999) }];
  rows[0].status = 'pending_spend'; rows[0].spending_txid = hash(999);
  await service.syncBounties();
  await until(() => service.engine.tasks.size === 0);
  assert.equal(service.reserved.has(key), false, 'A proven-unsent queue cancellation releases its local reservation only.');
  assert.equal(requests.filter(request => request.method === 'sendrawtransaction').length, 0);
  assert.equal(service.engine.queue.has(key), false);
  assert.equal(service.engine.acceptedProofs.get(key)?.pending.proof, winner.proof);
  rows[0].status = nextState; rows[0].spending_txid = nextState === 'available' ? null : hash(999);
  state.events = [{ type: nextState === 'available' ? 'available_again' : 'spent', sequence: 2, txid: rows[0].txid, vout: 0,
    block_hash: tip.hash, ...(nextState === 'spent' ? { spending_txid: hash(999) } : {}) }];
  state.receipt = 'missing'; service.claimReceiptNext = 0; service.engine.acceptedProofs.get(key).due = 0;
  service.rpc.cooldowns.delete('sendrawtransaction');
  await service.syncBounties();
  if (nextState === 'available') {
    const replay = service.engine.queue.get(key); assert.ok(replay?.winner);
    assert.equal(service.engine.pendingProofs.get(key)?.proof, winner.proof);
    await service.engine.submitVerified(replay, new AbortController(), service.engine.generation);
    const sends = requests.filter(request => request.method === 'sendrawtransaction');
    assert.equal(sends.length, 1); assert.equal(sends[0].params.transaction_hex, attachClaimProof(prepared, winner.proof).hex);
    assert.equal(service.engine.state.completed, 1);
  } else {
    assert.equal(service.engine.queue.has(key), false);
    assert.equal(requests.filter(request => request.method === 'sendrawtransaction').length, 0);
    assert.equal(service.engine.state.completed, 0);
  }
  assert.equal(service.engine.state.attempts, 1);
});

test('an exact confirmed receipt after an explicit rejection credits first acceptance once and removes the pending retry', async t => {
  const f = await fixture(t), { service, key, state, job, requests } = f;
  state.rejectClaim = true;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  assert.equal(service.engine.state.completed, 0);
  state.claimHex = requests.find(request => request.method === 'sendrawtransaction').params.transaction_hex;
  state.receipt = 'confirmed'; service.engine.acceptedProofs.get(key).due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.equal(service.engine.acceptedProofs.has(key), false); assert.equal(service.engine.pendingProofs.has(key), false);
  assert.equal(service.engine.queue.has(key), false); assert.equal(service.engine.state.completed, 1);
  assert.equal(service.reserved.has(key), true);
  await service.syncBounties();
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  assert.equal(requests.filter(request => request.method === 'sendrawtransaction').length, 1);
});

for (const lateOutcome of ['ack', 'rejection', 'ambiguous-error']) test(`confirmation after a retry leaves the queue counts once despite a later ${lateOutcome}`, async t => {
  const f = await fixture(t), { service, key, state, job, rows } = f;
  state.rejectClaim = true;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  state.rejectClaim = false; state.holdClaim = true;
  const replay = service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  await until(() => typeof state.heldClaim === 'function');
  state.events = [{ type: 'pending_spend', sequence: 1, txid: rows[0].txid, vout: 0, spending_txid: job.prepared.txid }];
  rows[0].status = 'pending_spend'; rows[0].spending_txid = job.prepared.txid;
  state.receipt = 'confirmed'; service.engine.acceptedProofs.get(key).due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.equal(service.engine.queue.has(key), false); assert.equal(service.engine.state.completed, 1);
  state.heldClaim(lateOutcome === 'ack' ? null : lateOutcome === 'rejection'
    ? { code: -32020, message: 'Late policy rejection.', data: { node_code: -26 } }
    : { code: -32002, message: 'Late uncertain backend response.' });
  await replay;
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  assert.equal(service.engine.acceptedProofs.has(key), false);
  assert.equal(service.claimsReviewRequired, false); assert.equal(service.reserved.has(key), true);
});

test('another validly bound witness with the same transaction ID can confirm the claim without replacing saved replay bytes', async t => {
  const f = await fixture(t), { service, key, state, job, prepared, winner } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const saved = service.engine.acceptedProofs.get(key);
  const alternate = winner.proof.slice(0, -8) + '0f00000101';
  const observed = attachClaimProof(prepared, alternate);
  assert.equal(observed.txid, prepared.txid); assert.notEqual(observed.hex, state.claimHex);
  state.receiptOverride = { transaction: { hex: observed.hex } };
  saved.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.strictEqual(service.engine.acceptedProofs.get(key), saved); assert.equal(saved.pending.proof, winner.proof);
  state.receipt = 'confirmed'; saved.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.equal(service.engine.acceptedProofs.has(key), false); assert.equal(service.engine.state.completed, 1);
});

for (const alteration of ['challenge', 'framing', 'extra-stack-item']) test(`a receipt with the same txid but invalid ${alteration} witness cannot discard preserved work`, async t => {
  const f = await fixture(t), { service, key, state, job } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const saved = service.engine.acceptedProofs.get(key), transaction = parseTransaction(state.claimHex);
  if (alteration === 'extra-stack-item') transaction.inputs[0].witness.push('00');
  else {
    const bytes = Buffer.from(transaction.inputs[0].witness[0], 'hex');
    bytes[alteration === 'challenge' ? 7 : 1] ^= 1;
    transaction.inputs[0].witness[0] = bytes.toString('hex');
  }
  assert.equal(transactionId(transaction), saved.txid);
  state.receipt = 'confirmed'; state.receiptOverride = { transaction: { hex: serializeTransaction(transaction).toString('hex') } };
  saved.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.strictEqual(service.engine.acceptedProofs.get(key), saved);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.reserved.has(key), true);
});

test('a mempool ACK survives receipt failures and eviction, replaying one identical witness without counting a second claim', async t => {
  const f = await fixture(t), { service, key, state, job, requests, winner, rows } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  assert.equal(service.engine.state.completed, 1);
  assert.equal(service.engine.acceptedProofs.get(key).pending.proof, winner.proof);
  for (const receipt of ['pending', 'backend-error']) {
    state.receipt = receipt; service.engine.acceptedProofs.get(key).due = 0; service.claimReceiptNext = 0;
    await service.syncBounties();
    assert.equal(service.engine.queue.has(key), false); assert.equal(service.reserved.has(key), true);
    assert.equal(service.engine.acceptedProofs.has(key), true);
  }
  state.receipt = 'missing'; service.engine.acceptedProofs.get(key).due = 0; service.claimReceiptNext = 0;
  state.events = [{ type: 'available_again', sequence: 1, txid: rows[0].txid, vout: 0, block_hash: tip.hash }];
  await service.syncBounties();
  assert.equal(service.reserved.has(key), false);
  const replay = service.engine.queue.get(key); assert.ok(replay);
  assert.equal(service.engine.pendingProofs.get(key).proof, winner.proof);
  await service.engine.submitVerified(replay, new AbortController(), service.engine.generation);
  await service.engine.submitVerified(replay, new AbortController(), service.engine.generation);
  const sends = requests.filter(request => request.method === 'sendrawtransaction');
  assert.equal(sends.length, 2); assert.equal(sends[0].params.transaction_hex, sends[1].params.transaction_hex);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  state.receipt = 'confirmed'; service.engine.acceptedProofs.get(key).due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.equal(service.engine.acceptedProofs.has(key), false);
  assert.equal(service.engine.state.completed, 1);
});

for (const invalidation of ['none', 'spent', 'pending_spend', 'reorg']) test(`an ACK witness aged beyond 600 blocks is retained; replay respects ${invalidation} invalidation`, async t => {
  const f = await fixture(t), { service, key, state, job, requests, rows } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const accepted = service.engine.acceptedProofs.get(key);
  state.tip = { ...tip, height: 600, hash: hash(700) };
  service.config.claims.lookbackBlocks = 1;
  if (invalidation === 'spent' || invalidation === 'pending_spend') {
    state.events = [{ type: invalidation, sequence: 1, txid: rows[0].txid, vout: 0, spending_txid: hash(990) }];
  } else if (invalidation === 'reorg') {
    // A retained funding block replaced at a height still in the canonical
    // window must invalidate its old witness, not become ordinary aging.
    accepted.bounty = { ...accepted.bounty, block_height: 1, block_hash: hash(999) };
    service.claimOutpoints.delete(key);
    service.claimBlocks.clear();
  }
  state.receipt = 'missing'; accepted.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.equal(service.engine.acceptedProofs.has(key), true);
  if (invalidation !== 'none') {
    assert.equal(service.engine.queue.has(key), false);
    assert.equal(accepted.invalidated, true);
    assert.equal(requests.filter(request => request.method === 'sendrawtransaction').length, 1);
  } else {
    const replay = service.engine.queue.get(key); assert.ok(replay?.retired);
    assert.equal(replay.revalidateClaim, true);
    await service.engine.submitVerified(replay, new AbortController(), service.engine.generation);
    const sends = requests.filter(request => request.method === 'sendrawtransaction');
    assert.equal(sends.length, 2); assert.equal(sends[0].params.transaction_hex, sends[1].params.transaction_hex);
    assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  }
});

test('a receipt contradicting the validated block hash cannot discard the ACK witness', async t => {
  const f = await fixture(t), { service, key, state, job } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const accepted = service.engine.acceptedProofs.get(key);
  state.receipt = 'confirmed'; state.receiptOverride = { block_hash: hash(777) };
  accepted.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.strictEqual(service.engine.acceptedProofs.get(key), accepted);
  assert.equal(service.reserved.has(key), true); assert.equal(service.engine.queue.has(key), false);
});

for (const outcome of ['ACK', 'rejection']) for (const invalidation of ['spent', 'competing-pending', 'own-pending', 'spent-then-available']) test(`a late first ${outcome} preserves ${invalidation} evidence before the bounty ages outside discovery`, async t => {
  const f = await fixture(t), { service, key, state, job, rows, requests, winner } = f;
  state.holdClaim = true;
  const submission = service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  await until(() => typeof state.heldClaim === 'function');
  const status = invalidation.startsWith('spent') ? 'spent' : 'pending_spend';
  const spendingTxid = invalidation === 'own-pending' ? job.prepared.txid : hash(999);
  rows[0].status = status; rows[0].spending_txid = spendingTxid;
  state.events = [{ type: status, sequence: 1, txid: rows[0].txid, vout: 0, spending_txid: spendingTxid }];
  await service.syncBounties();
  assert.equal(job.unavailable, true); assert.equal(service.engine.queue.has(key), false);
  if (invalidation === 'spent-then-available') {
    rows[0].status = 'available'; rows[0].spending_txid = null;
    state.events = [{ type: 'available_again', sequence: 2, txid: rows[0].txid, vout: 0, block_hash: tip.hash }];
    await service.syncBounties();
  }
  state.heldClaim(outcome === 'ACK' ? null : { code: -32020, message: 'Late rejection.', data: { node_code: -26 } }); await submission;
  const accepted = service.engine.acceptedProofs.get(key);
  assert.equal(accepted.pending.proof, winner.proof);
  await service.engine.stop(); service.engine.start();
  state.tip = { ...tip, height: 600, hash: hash(700) }; service.config.claims.lookbackBlocks = 1;
  state.receipt = 'missing'; accepted.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  const replayAllowed = ['own-pending', 'spent-then-available'].includes(invalidation);
  assert.equal(service.engine.queue.has(key), replayAllowed,
    'Window aging must not erase a previously observed competing spend; our own reversible mempool spend is different.');
  assert.equal(accepted.invalidated, !replayAllowed);
  assert.equal(service.engine.state.completed, Number(outcome === 'ACK')); assert.equal(service.engine.state.attempts, 1);
  assert.equal(service.claimsReviewRequired, false);
  assert.equal(requests.filter(request => request.method === 'sendrawtransaction').length, 1);
  if (replayAllowed) {
    state.holdClaim = false;
    await service.engine.submitVerified(service.engine.queue.get(key), new AbortController(), service.engine.generation);
    const sends = requests.filter(request => request.method === 'sendrawtransaction');
    assert.equal(sends.length, 2); assert.equal(sends[0].params.transaction_hex, sends[1].params.transaction_hex);
    assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  } else {
    assert.strictEqual(service.engine.acceptedProofs.get(key), accepted);
    assert.equal(service.reserved.has(key), outcome === 'ACK');
  }
});

test('a funding transaction reminted before its first ACK keeps the new coherent block metadata after aging', async t => {
  const f = await fixture(t, { initialHeight: 1, initialHash: hash(901) });
  const { service, key, state, job, rows, requests, winner, prepared } = f;
  state.holdClaim = true;
  const submission = service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  await until(() => typeof state.heldClaim === 'function');
  // The old block at height 1 is replaced; identical immutable funding is now
  // mined in block 2. The signed claim must not change with its block metadata.
  state.tip = { ...tip, height: 2, hash: hash(102) };
  rows[0] = { ...rows[0], block_height: 2, block_hash: hash(102) };
  await service.syncBounties();
  assert.equal(job.unavailable, true);
  assert.equal(service.claimOutpoints.get(key).block_height, 2);
  state.heldClaim(); await submission;
  const accepted = service.engine.acceptedProofs.get(key);
  service.config.claims.lookbackBlocks = 1;
  state.tip = { ...tip, height: 3, hash: hash(103) };
  await service.syncBounties();
  assert.equal(service.claimOutpoints.has(key), false);
  state.tip = { ...tip, height: 4, hash: hash(104) };
  state.receipt = 'missing'; accepted.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  const replay = service.engine.queue.get(key);
  assert.ok(replay?.winner, 'The old orphan block cannot invalidate funding already reauthenticated in the replacement snapshot.');
  assert.equal(accepted.bounty.block_height, 2); assert.equal(accepted.bounty.block_hash, hash(102));
  assert.equal(accepted.invalidated, false); assert.equal(accepted.pending.proof, winner.proof);
  assert.equal(prepared.bounty.block_height, 1); assert.equal(prepared.bounty.block_hash, hash(901));
  state.holdClaim = false;
  await service.engine.submitVerified(replay, new AbortController(), service.engine.generation);
  const sends = requests.filter(request => request.method === 'sendrawtransaction');
  assert.equal(sends.length, 2); assert.equal(sends[0].params.transaction_hex, sends[1].params.transaction_hex);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
});

test('a claimed confirmation at height zero must match pinned genesis even after genesis leaves the discovery window', async t => {
  const f = await fixture(t), { service, state, job, key } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const accepted = service.engine.acceptedProofs.get(key);
  state.tip = { ...tip, height: 603, hash: hash(703) };
  service.config.claims.lookbackBlocks = 1;
  state.receipt = 'confirmed'; state.receiptOverride = { block_height: 0, block_hash: hash(777) };
  accepted.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.equal(service.claimWindow.blocks.some(block => block.height === 0), false);
  assert.equal(service.engine.acceptedProofs.get(key) === accepted, true, 'An impossible genesis block cannot compact the only retained witness.');
  assert.equal(service.reserved.has(key), true); assert.equal(service.engine.state.completed, 1);
  assert.equal(service.engine.pendingProofs.has(key), false);
});

for (const [name, override] of [
  ['missing confirmation height', () => ({ block_height: undefined })],
  ['missing confirmation block', () => ({ block_hash: undefined })],
  ['contradictory transaction ID', hex => ({ transaction: { hex, txid: hash(777) } })],
  ['contradictory embedded block', hex => ({ transaction: { hex, blockhash: hash(777) } })],
  ['zero confirmations on confirmed', hex => ({ transaction: { hex, confirmations: 0 } })],
  ['noninteger confirmations', hex => ({ transaction: { hex, confirmations: 1.5 } })],
  ['pending with positive confirmations', hex => ({ status: 'pending', transaction: { hex, confirmations: 1 } })],
  ['pending with confirmed block metadata', hex => ({ status: 'pending', transaction: { hex, blockhash: tip.hash } })],
]) test(`receipt envelope ${name} cannot compact a retained ACK or change counters`, async t => {
  const f = await fixture(t), { service, state, job, key, requests } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const accepted = service.engine.acceptedProofs.get(key);
  state.receipt = 'confirmed'; state.receiptOverride = override(state.claimHex);
  accepted.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.equal(service.engine.acceptedProofs.get(key) === accepted, true);
  assert.equal(service.reserved.has(key), true); assert.equal(service.engine.pendingProofs.has(key), false);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  assert.equal(requests.filter(request => request.method === 'sendrawtransaction').length, 1);
});

test('a delayed missing receipt from before a replay ACK cannot reopen or unreserve that newer acceptance', async t => {
  const f = await fixture(t), { service, key, state, job, requests } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  state.receipt = 'missing'; service.engine.acceptedProofs.get(key).due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  const replay = service.engine.queue.get(key); assert.ok(replay);
  state.holdReceipt = true;
  const previous = service.engine.acceptedProofs.get(key); previous.due = 0; service.claimReceiptNext = 0;
  const receipt = service.reconcileAcceptedClaims(() => {});
  await until(() => typeof state.heldReceipt === 'function');
  await service.engine.submitVerified(replay, new AbortController(), service.engine.generation);
  const current = service.engine.acceptedProofs.get(key); assert.notStrictEqual(current, previous);
  state.heldReceipt(); await receipt;
  assert.strictEqual(service.engine.acceptedProofs.get(key), current);
  assert.equal(service.engine.queue.has(key), false); assert.equal(service.engine.pendingProofs.has(key), false);
  assert.equal(service.reserved.has(key), true);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  assert.equal(requests.filter(request => request.method === 'sendrawtransaction').length, 2);
});

test('a receipt already in flight before a reset notification cannot compact the preserved proof against the old catalog', async t => {
  const f = await fixture(t), { service, key, state, job, requests } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const accepted = service.engine.acceptedProofs.get(key);
  state.holdReceipt = true; accepted.due = 0; service.claimReceiptNext = 0;
  const pending = service.syncBounties();
  await until(() => typeof state.heldReceipt === 'function');
  service.walletUpdates.close(); service.walletUpdates = { request() {}, close() {} };
  service.liveUpdates.onChange({ reset: true, bounties: true, tip });
  state.heldReceipt({ tip, status: 'confirmed', block_height: 0, block_hash: tip.hash,
    transaction: { hex: state.claimHex } });
  await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
  assert.strictEqual(service.engine.acceptedProofs.get(key), accepted);
  assert.ok(service.claimCatalogGate); assert.equal(service.engine.state.completed, 1);
  assert.equal(requests.filter(request => request.method === 'sendrawtransaction').length, 1);
});

test('a validated confirmation cancels the same queued replay without releasing its confirmed reservation or recounting', async t => {
  const f = await fixture(t), { service, key, state, job, requests } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  state.receipt = 'missing'; service.engine.acceptedProofs.get(key).due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.ok(service.engine.queue.has(key));
  service.rpc.cooldowns.set('sendrawtransaction', performance.now() + 60000);
  service.engine.retrySubmissions(service.engine.generation);
  await until(() => service.reserved.has(key));
  state.receipt = 'confirmed'; service.engine.acceptedProofs.get(key).due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  await until(() => service.engine.tasks.size === 0);
  assert.equal(service.engine.queue.has(key), false); assert.equal(service.engine.pendingProofs.has(key), false);
  assert.equal(service.engine.acceptedProofs.has(key), false); assert.equal(service.reserved.has(key), true);
  assert.equal(service.engine.state.completed, 1); assert.equal(service.engine.state.attempts, 1);
  assert.equal(requests.filter(request => request.method === 'sendrawtransaction').length, 1);
});

test('retained ACK witnesses consume preparation capacity and cannot be evicted for new work', async t => {
  const f = await fixture(t), { service, key, job } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const record = service.engine.acceptedProofs.get(key);
  for (let index = 1; index < 256; index++) service.engine.acceptedProofs.set(`${hash(index + 1000)}:0`, record);
  assert.equal(service.engine.cachePrepared(`${hash(9999)}:0`, {}), false);
  assert.equal(service.engine.acceptedProofs.size, 256);
  assert.strictEqual(service.engine.acceptedProofs.get(key), record);
});

async function confirmAtBlockTwo(f) {
  const { service, state, job, key, rows } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  state.tip = { ...tip, height: 2, hash: hash(102) };
  for (const row of rows) row.confirmations = 3;
  rows[0].status = 'spent'; rows[0].spending_txid = job.prepared.txid;
  state.events = [{ type: 'spent', sequence: 1, txid: rows[0].txid, vout: 0, spending_txid: job.prepared.txid }];
  state.receipt = 'confirmed'; state.receiptOverride = { block_height: 2, block_hash: hash(102) };
  service.engine.acceptedProofs.get(key).due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.equal(service.engine.acceptedProofs.has(key), false);
  assert.equal(service.reserved.has(key), true);
}

test('a confirmed claim orphaned by a reorg permits recapture without counting the same transaction ACK twice', async t => {
  const f = await fixture(t), { service, state, key, rows, requests } = f;
  await confirmAtBlockTwo(f);
  state.tip = { ...tip, height: 1, hash: hash(101) };
  for (const row of rows) row.confirmations = 2;
  rows[0].status = 'available'; rows[0].spending_txid = null;
  state.events = [{ type: 'resync_required', sequence: 2 }];
  state.receipt = 'missing'; delete state.receiptOverride;
  await service.syncBounties();
  assert.equal(service.reserved.has(key), false, 'A reorg-reopened bounty cannot remain reserved by a compacted confirmation.');
  assert.ok(service.engine.queue.has(key), 'The restored available bounty can be claimed again.');
  const recapture = service.engine.queue.get(key);
  recapture.prepared = await service.prepareAutomaticClaim(rows[0]);
  assert.equal(recapture.prepared.acceptanceCounted, true);
  service.engine.proposals.set(key, recapture.prepared);
  service.engine.pool = { async close() {}, attempt(context, options) {
    options.onStarted();
    const result = { started: true, captured: true, seconds: 0.01, cancelled: false,
      validationPassed: true, verified: true, proof: structuralProof(recapture.prepared) };
    options.onCapture(result); options.onResult(result); return result;
  } };
  service.engine.dispatch([key, recapture], service.engine.generation);
  await until(() => service.engine.tasks.size === 0);
  assert.equal(service.engine.state.attempts, 2, 'The compacted witness requires a fresh verified capture.');
  assert.equal(service.engine.state.completed, 1, 'Reaccepting the identical transaction is not a second success.');
  assert.equal(requests.filter(request => request.method === 'sendrawtransaction').length, 2);
  assert.equal(service.engine.acceptedProofs.get(key)?.pending.counted, true);
});

test('two reorgs with fees A to B to A and Stop/Start do not recount an already accepted transaction', async t => {
  const f = await fixture(t), { service, state, key, rows, requests, prepared } = f;
  await confirmAtBlockTwo(f);
  let sequence = 1;
  for (const rate of [3000, 1500]) {
    const completed = service.engine.state.completed;
    await service.engine.stop(); service.engine.start();
    assert.equal(service.engine.state.completed, completed);
    state.tip = { ...tip, height: 1, hash: hash(101) };
    for (const row of rows) row.confirmations = 2;
    rows[0].status = 'available'; rows[0].spending_txid = null;
    state.events = [{ type: 'resync_required', sequence: ++sequence }];
    state.receipt = 'missing'; delete state.receiptOverride;
    service.config.feeRate = rate;
    await service.syncBounties();
    const recapture = service.engine.queue.get(key);
    assert.ok(recapture);
    recapture.prepared = await service.prepareAutomaticClaim(rows[0]);
    service.engine.proposals.set(key, recapture.prepared);
    service.engine.pool = { async close() {}, attempt(context, options) {
      options.onStarted();
      const result = { started: true, captured: true, seconds: 0.01, cancelled: false,
        validationPassed: true, verified: true, proof: structuralProof(recapture.prepared) };
      options.onCapture(result); options.onResult(result); return result;
    } };
    service.engine.dispatch([key, recapture], service.engine.generation);
    await until(() => service.engine.tasks.size === 0);
    state.tip = { ...tip, height: 2, hash: hash(102) };
    for (const row of rows) row.confirmations = 3;
    rows[0].status = 'spent'; rows[0].spending_txid = recapture.prepared.txid;
    state.events = [{ type: 'spent', sequence: ++sequence, txid: rows[0].txid, vout: 0, spending_txid: recapture.prepared.txid }];
    state.receipt = 'confirmed'; state.receiptOverride = { block_height: 2, block_hash: hash(102) };
    service.engine.acceptedProofs.get(key).due = 0; service.claimReceiptNext = 0;
    await service.syncBounties();
  }
  const sent = requests.filter(request => request.method === 'sendrawtransaction');
  assert.equal(sent.length, 3);
  assert.equal(transactionId(parseTransaction(sent[0].params.transaction_hex)), prepared.txid);
  assert.equal(sent[0].params.transaction_hex, sent[2].params.transaction_hex);
  assert.notEqual(sent[0].params.transaction_hex, sent[1].params.transaction_hex);
  assert.equal(service.engine.state.attempts, 3);
  assert.equal(service.engine.state.completed, 2, 'Only the two distinct accepted transaction IDs are new successes.');
});

test('confirmed transaction ID capacity also preserves a replacement proof for the same outpoint', async t => {
  const f = await fixture(t), { service, state, key, rows } = f;
  await confirmAtBlockTwo(f);
  state.tip = { ...tip, height: 1, hash: hash(101) };
  for (const row of rows) row.confirmations = 2;
  rows[0].status = 'available'; rows[0].spending_txid = null;
  state.events = [{ type: 'resync_required', sequence: 2 }];
  state.receipt = 'missing'; delete state.receiptOverride;
  service.config.feeRate = 3000;
  await service.syncBounties();
  const replacement = service.engine.queue.get(key);
  replacement.prepared = await service.prepareAutomaticClaim(rows[0]); replacement.winner = true;
  assert.equal(replacement.prepared.acceptanceCounted, false);
  service.engine.proposals.set(key, replacement.prepared);
  service.engine.pendingProofs.set(key, { proof: structuralProof(replacement.prepared), context: replacement.prepared.context, due: 0, failures: 0 });
  await service.engine.submitVerified(replacement, new AbortController(), service.engine.generation);
  const saved = service.engine.acceptedProofs.get(key);
  service.engine.maxQueue = 1;
  state.tip = { ...tip, height: 2, hash: hash(102) };
  for (const row of rows) row.confirmations = 3;
  rows[0].status = 'spent'; rows[0].spending_txid = replacement.prepared.txid;
  state.events = [{ type: 'spent', sequence: 3, txid: rows[0].txid, vout: 0, spending_txid: replacement.prepared.txid }];
  state.receipt = 'confirmed'; state.receiptOverride = { block_height: 2, block_hash: hash(102) };
  saved.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.strictEqual(service.engine.acceptedProofs.get(key), saved, 'No confirmed-ID history eviction or proof loss at the limit.');
  assert.equal(saved.pending.proof, structuralProof(replacement.prepared));
  assert.equal(service.reserved.has(key), true); assert.equal(service.engine.state.completed, 2);
});

test('locking resets confirmed transaction ID history together with the session counters', async t => {
  const f = await fixture(t), { service, state, key, rows, prepared } = f;
  await confirmAtBlockTwo(f);
  await service.lock();
  assert.equal(service.engine.state.completed, 0); assert.equal(service.engine.state.attempts, 0);
  service.session = { data: {} }; service.engine.enabled = true;
  service.bountyUpdates.close(); service.bountyUpdates = { request() {}, close() {} };
  state.tip = tip; service.tip = tip;
  for (const row of rows) row.confirmations = 1;
  rows[0].status = 'available'; rows[0].spending_txid = null;
  state.receipt = 'missing'; delete state.receiptOverride;
  await service.syncBounties();
  assert.equal(service.reserved.has(key), false);
  const fresh = await service.prepareAutomaticClaim(rows[0]);
  assert.equal(fresh.txid, prepared.txid);
  assert.equal(fresh.acceptanceCounted, false, 'A new session must not inherit count suppression from the cleared counters.');
});

test('coherent funding reorg and remining preserve the exhausted capture budget without stale proposals', async t => {
  const f = await fixture(t), { service, state, key, rows } = f;
  const bounty = rows[0], factor = service.engine.factors.get(key);
  service.engine.remove(bounty.txid, bounty.vout);
  service.engine.successCounts.set(key, 3n);
  state.tip = { ...tip, height: 100, hash: hash(200) };
  for (const row of rows) row.confirmations = 101;
  bounty.block_height = 100; bounty.block_hash = hash(200); bounty.confirmations = 1;
  state.events = [{ type: 'resync_required', sequence: 1 }];
  await service.syncBounties();
  assert.equal(service.engine.queue.has(key), false);
  rows.shift();
  state.tip = { ...tip, height: 99, hash: hash(199) };
  for (const row of rows) row.confirmations = 100;
  state.events = [{ type: 'resync_required', sequence: 2 }];
  await service.syncBounties();
  assert.equal(service.claimOutpoints.has(key), false);
  assert.equal(service.engine.proposals.has(key), false); assert.equal(service.engine.pendingProofs.has(key), false);
  assert.equal(service.engine.successCounts.get(key), 3n);
  assert.equal(service.engine.factors.get(key), factor);
  state.tip = { ...tip, height: 101, hash: hash(201) };
  for (const row of rows) row.confirmations = 102;
  bounty.block_height = 101; bounty.block_hash = hash(201); bounty.confirmations = 1;
  rows.unshift(bounty); state.events = [{ type: 'resync_required', sequence: 3 }];
  await service.syncBounties();
  assert.equal(service.claimOutpoints.get(key).block_height, 101);
  assert.equal(service.engine.queue.has(key), false, 'Returning funding does not start a new successful-capture budget.');
  assert.equal(service.engine.successCounts.get(key), 3n); assert.equal(service.engine.factors.get(key), factor);
  assert.equal(service.engine.state.attempts, 1); assert.equal(service.engine.state.completed, 0);
});

test('a receipt ahead of discovery retains its witness until the coherent catalog catches up', async t => {
  const f = await fixture(t), { service, state, job, key, rows } = f;
  await service.engine.submitVerified(job, new AbortController(), service.engine.generation);
  const accepted = service.engine.acceptedProofs.get(key);
  state.receipt = 'confirmed'; state.receiptOverride = { tip: { ...tip, height: 1, hash: hash(101) }, block_height: 1, block_hash: hash(101) };
  accepted.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.strictEqual(service.engine.acceptedProofs.get(key), accepted);
  assert.equal(service.reserved.has(key), true); assert.equal(service.engine.queue.has(key), false);
  await service.syncBounties();
  assert.strictEqual(service.engine.acceptedProofs.get(key), accepted, 'The older discovery tip is not an orphaned confirmation.');
  state.tip = { ...tip, height: 1, hash: hash(101) };
  for (const row of rows) row.confirmations = 2;
  rows[0].status = 'spent'; rows[0].spending_txid = job.prepared.txid;
  state.events = [{ type: 'spent', sequence: 1, txid: rows[0].txid, vout: 0, spending_txid: job.prepared.txid }];
  accepted.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.equal(service.engine.acceptedProofs.has(key), false);
  assert.equal(service.reserved.has(key), true); assert.equal(service.engine.state.completed, 1);
});

test('full compact-confirmation metadata retains the next proof instead of evicting an older reorg marker', async t => {
  const f = await fixture(t), { service, state, key, rows } = f;
  await confirmAtBlockTwo(f);
  service.engine.maxQueue = 1;
  const secondKey = bountyKey(rows[1]), secondJob = service.engine.queue.get(secondKey);
  secondJob.prepared = await service.prepareAutomaticClaim(rows[1]); secondJob.winner = true;
  service.engine.proposals.set(secondKey, secondJob.prepared);
  service.engine.pendingProofs.set(secondKey, { proof: structuralProof(secondJob.prepared), context: secondJob.prepared.context, due: 0, failures: 0 });
  await service.engine.submitVerified(secondJob, new AbortController(), service.engine.generation);
  const saved = service.engine.acceptedProofs.get(secondKey);
  rows[1].status = 'spent'; rows[1].spending_txid = secondJob.prepared.txid;
  state.events = [{ type: 'spent', sequence: 2, txid: rows[1].txid, vout: 0, spending_txid: secondJob.prepared.txid }];
  saved.due = 0; service.claimReceiptNext = 0;
  await service.syncBounties();
  assert.strictEqual(service.engine.acceptedProofs.get(secondKey), saved);
  assert.equal(service.reserved.has(secondKey), true);
  state.tip = { ...tip, height: 1, hash: hash(101) };
  for (const row of rows) row.confirmations = 2;
  rows[0].status = 'available'; rows[0].spending_txid = null;
  state.events = [{ type: 'resync_required', sequence: 3 }];
  await service.syncBounties();
  assert.equal(service.reserved.has(key), false, 'Capacity did not silently discard the older orphan-detection marker.');
  assert.equal(service.engine.completed.has(key), false);
  assert.equal((await service.prepareAutomaticClaim(rows[0])).acceptanceCounted, true);
  assert.equal(service.engine.state.completed, 2);
});

for (const condition of ['same-chain', 'aged-out', 'pending-spend', 'incomplete-reset']) test(`compacted confirmation is not unreserved for ${condition}`, async t => {
  const f = await fixture(t), { service, state, key, rows } = f;
  await confirmAtBlockTwo(f);
  const height = condition === 'aged-out' ? 603 : condition === 'same-chain' ? 2 : 1;
  state.tip = { ...tip, height, hash: hash(height + 100) };
  for (const row of rows) row.confirmations = height + 1;
  rows[0].status = condition === 'pending-spend' ? 'pending_spend' : 'available';
  rows[0].spending_txid = condition === 'pending-spend' ? hash(999) : null;
  state.events = [{ type: 'resync_required', sequence: 2 }];
  state.receipt = 'missing'; delete state.receiptOverride;
  if (condition === 'incomplete-reset') {
    state.stallStream = true;
    await assert.rejects(service.syncBounties(), /Bounty transfer timed out/);
  } else await service.syncBounties();
  assert.equal(service.reserved.has(key), true);
  assert.equal(service.engine.completed.has(key), true);
  assert.equal(service.engine.queue.has(key), false);
  assert.equal(service.engine.state.completed, 1);
});

test('a real -32002 funding read for another bounty cannot erase or duplicate an existing winner', async t => {
  const f = await fixture(t), { service, rows, state, key, winner, job } = f;
  const generation = service.engine.generation, cursor = service.claimCursor, blocks = service.claimBlocks;
  state.failingFunding = rows[1].txid;
  await assert.rejects(service.prepareAutomaticClaim(rows[1]), error => {
    assert.equal(error.code, -32002); assert.notEqual(error.unknownOutcome, true); return true;
  });
  assert.equal(service.fundingPending.size, 0); assert.equal(service.engine.generation, generation);
  assert.equal(service.engine.enabled, true); assert.equal(service.claimsReviewRequired, false);
  assert.strictEqual(service.engine.pendingProofs.get(key), winner); assert.strictEqual(service.engine.queue.get(key), job);
  assert.strictEqual(service.claimBlocks, blocks); assert.equal(service.claimCursor, cursor);
  assert.equal(service.engine.state.attempts, 1); assert.equal(service.engine.state.completed, 0);
  assert.equal(service.engine.successCounts.get(key), 1n);
  state.failingFunding = null;
  assert.equal((await service.prepareAutomaticClaim(rows[1])).bounty.txid, rows[1].txid);
  await submitOnce(f);
});
