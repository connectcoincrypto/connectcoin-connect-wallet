import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletService } from '../src/core/wallet-service.mjs';
import { GENESIS } from '../src/core/config.mjs';
import { deriveAccount, verifySchnorr } from '../src/core/crypto.mjs';
import { COIN, parseTransaction, serializeTransaction, signatureHash, transactionId } from '../src/core/transaction.mjs';

const mnemonic = 'abandon '.repeat(11) + 'about'; // Public test vector only.
const account = deriveAccount(mnemonic);
const funding = { version: 2, inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff, scriptSig: '0101', sequence: 0xffffffff, witness: [] }],
  outputs: [{ type: 1, amount: (10n * COIN).toString(), publicKey: account.publicKey }], locktime: 0 };
const raw = serializeTransaction(funding).toString('hex');
const bounty = { domain: 'EXAMPLE.com', amount: '1', expectedConnections: '1024' };
const tip = { chain: 'testnet4', height: 5, hash: 'ab'.repeat(32), mediantime: 1800000000, genesis_hash: GENESIS.testnet4 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, rsaProbe) {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-rsa-service-'));
  const broadcasts = [], fundingBatches = [];
  const service = new WalletService({ directory, network: 'testnet4', rsaProbe, clientFactory: () => {
    const rpc = new EventEmitter(); rpc.close = () => {};
    rpc.request = async (method, params) => {
      if (method === 'getaddressutxos') return { tip, address: params.address, unit: 'connects', next_cursor: null,
        items: params.address === account.address ? [{ txid: transactionId(funding), vout: 0, amount: funding.outputs[0].amount, status: 'confirmed', mature: true }] : [] };
      if (method === 'gettransactions') {
        assert.deepEqual(params, { txids: [transactionId(funding)] });
        fundingBatches.push(params.txids);
        return { tip, transactions: [{ txid: transactionId(funding), hex: raw }], remaining: [] };
      }
      assert.equal(method, 'sendrawtransaction'); broadcasts.push(params.transaction_hex);
      return { txid: transactionId(parseTransaction(params.transaction_hex)) };
    };
    return rpc;
  } });
  await service.initialize(); clearInterval(service.timer);
  service.session = { data: { mnemonic, receiveIndex: 0, changeIndex: 0 }, password: 'not-used-in-test' };
  await service.buildAccounts();
  service.utxos = [{ txid: transactionId(funding), vout: 0, amount: funding.outputs[0].amount, status: 'confirmed', mature: true, account: { index: 0, change: 0 } }];
  service.refresh = async () => {};
  service.ensureNetwork = async () => {};
  service.persist = async () => {};
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, broadcasts, fundingBatches };
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
  const { service, broadcasts, fundingBatches } = await fixture(t, async (input, options) => {
    calls.push(input); assert.equal(options.signal.aborted, false);
    return { verified: true, status: 'verified' };
  });
  const before = Math.floor(Date.now() / 1000);
  const review = await service.previewSend(bounty);
  assert.deepEqual(fundingBatches, [[transactionId(funding)]]);
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

test('invalid bounty details fail locally before waiting for an unavailable RPC', async t => {
  let networkCalls = 0, probeCalls = 0;
  const { service, fundingBatches } = await fixture(t, async () => { probeCalls++; });
  service.ensureNetwork = async () => { networkCalls++; throw new Error('Synthetic offline RPC'); };
  for (const [changes, expectedError] of [
    [{ domain: 'https://example.com/path' }, /Use a domain name, not a URL/],
    [{ domain: 'example..com' }, /Invalid domain name/],
    [{ expectedConnections: '0' }, /Expected connections must be a positive integer string/],
    [{ expectedConnections: '9'.repeat(78) }, /Expected connections must be a positive integer string/],
    [{ expectedConnections: 1n << 257n }, /Expected connections is out of range/],
  ]) {
    await assert.rejects(service.previewSend({ ...bounty, ...changes }), expectedError);
    assert.equal(service.preview, null);
    assert.equal(service.sendPreparation, null);
  }
  assert.equal(networkCalls, 0);
  assert.equal(probeCalls, 0);
  assert.deepEqual(fundingBatches, []);
});

test('bounty preflight preserves domain normalization and nullish work defaults', async t => {
  const calls = [];
  const { service, broadcasts } = await fixture(t, async input => {
    calls.push(input.domain); return { verified: false, status: 'failed' };
  });
  for (const [domain, expectedConnections, normalized, target] of [
    ['EXAMPLE.com', undefined, 'example.com', 'ff'.repeat(32)],
    ['BÜCHER.example', null, 'xn--bcher-kva.example', 'ff'.repeat(32)],
    ['local', 1n, 'local', 'ff'.repeat(32)],
    ['example.com', 1n << 256n, 'example.com', '00'.repeat(32)],
  ]) {
    const review = await service.previewSend({ ...bounty, domain, expectedConnections });
    assert.equal(review.address, normalized);
    assert.equal(review.expectedConnections, String(expectedConnections ?? '1'));
    const output = parseTransaction(service.preview.hex).outputs[0];
    assert.equal(output.domain, normalized);
    assert.equal(output.target, target);
    assert.equal(calls.at(-1), normalized);
  }
  assert.equal(calls.length, 4);
  assert.deepEqual(broadcasts, []);
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

test('cancelling a review stops waiting for pending UTXO funding and discards a late reply', async t => {
  const gate = deferred(), entered = deferred(); let calls = 0, fundingCompleted = false, signal;
  const { service, broadcasts } = await fixture(t, async () => { calls++; });
  service.page = (method, _address, options) => {
    assert.equal(method, 'getaddressutxos');
    signal = options.signal; entered.resolve();
    return gate.promise.then(() => { fundingCompleted = true; return []; });
  };
  const pending = service.previewSend(bounty), rejected = assert.rejects(pending, /cancelled/);
  await entered.promise;
  service.cancelSendPreview();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(fundingCompleted, false); assert.equal(calls, 0); assert.equal(service.preview, null);
  gate.resolve(); await gate.promise;
  assert.equal(fundingCompleted, true); assert.equal(calls, 0); assert.equal(service.preview, null);
  assert.deepEqual(broadcasts, []);
});

test.after(() => account.privateKey.fill(0));
