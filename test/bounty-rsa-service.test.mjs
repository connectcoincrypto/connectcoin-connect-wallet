import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletService } from '../src/core/wallet-service.mjs';
import { deriveAccount, verifySchnorr } from '../src/core/crypto.mjs';
import { COIN, parseTransaction, serializeTransaction, signatureHash, transactionId } from '../src/core/transaction.mjs';

const mnemonic = 'abandon '.repeat(11) + 'about'; // Public test vector only.
const account = deriveAccount(mnemonic);
const funding = { version: 2, inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff, scriptSig: '0101', sequence: 0xffffffff, witness: [] }],
  outputs: [{ type: 1, amount: (10n * COIN).toString(), publicKey: account.publicKey }], locktime: 0 };
const raw = serializeTransaction(funding).toString('hex');
const bounty = { domain: 'EXAMPLE.com', amount: '1', expectedConnections: '1024' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, rsaProbe) {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-rsa-service-'));
  const broadcasts = [];
  const service = new WalletService({ directory, rsaProbe, clientFactory: () => {
    const rpc = new EventEmitter(); rpc.close = () => {};
    rpc.request = async (method, params) => {
      assert.equal(method, 'sendrawtransaction'); broadcasts.push(params.transaction_hex);
      return { txid: transactionId(parseTransaction(params.transaction_hex)) };
    };
    return rpc;
  } });
  await service.initialize(); clearInterval(service.timer);
  service.session = { data: { mnemonic, receiveIndex: 0, changeIndex: 0 }, password: 'not-used-in-test' };
  service.buildAccounts();
  service.utxos = [{ txid: transactionId(funding), vout: 0, amount: funding.outputs[0].amount, status: 'confirmed', mature: true, account: { index: 0, change: 0 } }];
  service.refresh = async () => {};
  service.ensureNetwork = async () => {};
  service.persist = async () => {};
  service.funding = async () => raw;
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, broadcasts };
}

function checkSigned(service, review, mask) {
  const tx = parseTransaction(service.preview.hex);
  assert.equal(tx.outputs[0].mask, mask);
  assert.equal(tx.outputs[0].domain, 'example.com');
  assert.equal(review.address, 'example.com');
  assert.equal(review.signatureAlgorithmsMask, mask);
  assert.equal(review.txid, transactionId(tx));
  assert.equal(verifySchnorr(Buffer.from(tx.inputs[0].witness[0], 'hex'), signatureHash(tx, funding.outputs, 0), account.publicKey), true);
}

test('authenticated RSA selects mask 6, signs it and broadcasts those exact frozen bytes', async t => {
  const calls = [];
  const { service, broadcasts } = await fixture(t, async (input, options) => {
    calls.push(input); assert.equal(options.signal.aborted, false);
    return { verified: true, status: 'verified' };
  });
  const before = Math.floor(Date.now() / 1000);
  const review = await service.previewSend(bounty);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['domain', 'rootVersion', 'validationTime']);
  assert.equal(calls[0].domain, 'example.com'); assert.equal(calls[0].rootVersion, 1);
  assert.ok(calls[0].validationTime >= before && calls[0].validationTime <= Math.floor(Date.now() / 1000));
  assert.equal(review.rsaProbeStatus, 'verified'); assert.equal(review.expectedConnections, '1024');
  checkSigned(service, review, 6);
  const expectedHex = service.preview.hex;
  assert.equal(broadcasts.length, 0);
  await service.confirmSend({ previewId: review.previewId, signatureAlgorithmsMask: 7 });
  assert.deepEqual(broadcasts, [expectedHex]); assert.equal(calls.length, 1);
});

for (const status of ['failed', 'timeout', 'unavailable', 'busy']) {
  test(`${status} keeps mask 7 and accurately exposes the fallback in the review`, async t => {
    const { service, broadcasts } = await fixture(t, async () => ({ verified: false, status }));
    const review = await service.previewSend(bounty);
    checkSigned(service, review, 7); assert.equal(review.rsaProbeStatus, status);
    assert.equal(broadcasts.length, 0);
  });
}

test('helper exceptions and inconsistent success cannot select RSA-only', async t => {
  const { service } = await fixture(t, async () => { throw new Error('untrusted TLS error'); });
  for (const probe of [service.rsaProbe, async () => ({ verified: 'yes', status: 'verified' }), async () => ({ verified: true, status: 'failed' }), async () => undefined]) {
    service.rsaProbe = probe;
    const review = await service.previewSend(bounty);
    checkSigned(service, review, 7); assert.equal(review.rsaProbeStatus, 'failed');
    assert.ok(!JSON.stringify(review).includes('untrusted'));
  }
});

test('ordinary payments never probe and invalid bounties never open a TLS connection', async t => {
  let calls = 0;
  const { service } = await fixture(t, async () => { calls++; return { verified: true, status: 'verified' }; });
  const review = await service.previewSend({ address: account.address, amount: '1' });
  assert.equal(review.type, 'payment'); assert.equal(review.signatureAlgorithmsMask, undefined);
  for (const changes of [{ domain: 'https://example.com' }, { expectedConnections: '0' }, { feeRate: 1 }, { amount: '20' }]) {
    await assert.rejects(service.previewSend({ ...bounty, ...changes }));
    assert.equal(service.preview, null);
  }
  assert.equal(calls, 0);
});

for (const reason of ['cancel', 'lock', 'disconnect', 'RPC settings']) {
  test(`${reason} cancels the probe and a late success cannot revive its preview`, async t => {
    const started = deferred(), finish = deferred(); let signal;
    const { service, broadcasts } = await fixture(t, async (_input, options) => { signal = options.signal; started.resolve(); return finish.promise; });
    const pending = service.previewSend(bounty);
    const rejected = assert.rejects(pending, /cancelled|locked/);
    await started.promise;
    if (reason === 'lock') await service.lock();
    else if (reason === 'disconnect') service.rpc.emit('disconnected');
    else if (reason === 'RPC settings') await service.saveConfig({ rpc: { port: 18001 } });
    else service.cancelSendPreview();
    assert.equal(signal.aborted, true);
    finish.resolve({ verified: true, status: 'verified' });
    await rejected;
    assert.equal(service.preview, null); assert.equal(broadcasts.length, 0);
  });
}

test('newer review supersedes an in-flight probe without the old result overwriting it', async t => {
  const started = deferred(), finish = deferred(); let signal, count = 0;
  const { service } = await fixture(t, async (_input, options) => {
    if (++count === 1) { signal = options.signal; started.resolve(); return finish.promise; }
    return { verified: false, status: 'timeout' };
  });
  const first = service.previewSend(bounty), rejected = assert.rejects(first, /cancelled/);
  await started.promise;
  const review = await service.previewSend(bounty);
  assert.equal(signal.aborted, true);
  finish.resolve({ verified: true, status: 'verified' }); await rejected;
  assert.equal(service.preview.previewId, review.previewId); checkSigned(service, review, 7);
  service.cancelSendPreview();
  await assert.rejects(service.confirmSend({ previewId: review.previewId }), /expired/);
});

test('cancelling a review stops waiting for a shared refresh without cancelling that refresh', async t => {
  const gate = deferred(); let calls = 0, refreshCompleted = false;
  const { service } = await fixture(t, async () => { calls++; });
  service.refresh = () => gate.promise.then(() => { refreshCompleted = true; });
  const pending = service.previewSend(bounty), rejected = assert.rejects(pending, /cancelled/);
  service.cancelSendPreview();
  await rejected;
  assert.equal(refreshCompleted, false); assert.equal(calls, 0); assert.equal(service.preview, null);
  gate.resolve(); await service.refresh();
  assert.equal(refreshCompleted, true);
});

test.after(() => account.privateKey.fill(0));
