import assert from 'node:assert/strict';
import test from 'node:test';
import { Session } from 'node:inspector/promises';
import { deriveAccount, verifySchnorr } from '../src/core/crypto.mjs';
import { buildPaymentInWorker } from '../src/core/payment-builder.mjs';
import { COIN, MAX_MONEY, parseTransaction, serializeTransaction, signatureHash, transactionIdFromRaw } from '../src/core/transaction.mjs';

// Published BIP39 vector and synthetic parents only; no profile, RPC or broadcast.
const mnemonic = `${'abandon '.repeat(11)}about`;
const owner = deriveAccount(mnemonic), other = deriveAccount(mnemonic, { index: 1 });
const output = { type: 1, amount: String(COIN), publicKey: owner.publicKey };
const parent = (count = 2000) => ({ version: 2, locktime: 0,
  inputs: [{ txid: '01'.repeat(32), vout: 0, scriptSig: '', sequence: 0xffffffff, witness: [] }],
  outputs: Array.from({ length: count }, () => ({ ...output })),
});

test('large repeated-key parents validate each distinct curve point once per parse and serialization', async t => {
  const transaction = parent(), bytes = serializeTransaction(transaction);
  // V8 function counters make this a deterministic work bound, independent of
  // CPU speed, without replacing the real curve validator or using a timeout.
  const profiler = new Session(); profiler.connect();
  t.after(async () => {
    await profiler.post('Profiler.stopPreciseCoverage');
    await profiler.post('Profiler.disable'); profiler.disconnect();
  });
  await profiler.post('Profiler.enable');
  await profiler.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  const validations = async () => {
    const { result } = await profiler.post('Profiler.takePreciseCoverage');
    return result.find(script => script.url.endsWith('/src/core/crypto.mjs'))?.functions
      .find(fn => fn.functionName === 'validatePublicKey')?.ranges[0].count ?? 0;
  };
  assert.deepEqual(parseTransaction(bytes.toString('hex')), transaction);
  assert.equal(await validations(), 1, 'canonical reserialization reuses the checked point');
  assert.deepEqual(serializeTransaction(transaction), bytes);
  assert.equal(await validations(), 1);
  transaction.outputs.at(-1).publicKey = other.publicKey;
  const changed = serializeTransaction(transaction);
  assert.equal(await validations(), 2, 'a different key receives its own complete curve validation');
  assert.deepEqual(parseTransaction(changed.toString('hex')), transaction);
  assert.equal(await validations(), 2, 'the next operation has a fresh validation cache');
});

function workerOptions(parents) {
  return { mnemonic, parents, utxos: parents.map(({ txid }) => ({ txid, vout: 0, amount: String(COIN), account: { index: 0, change: 0 } })),
    outputs: [{ address: other.address, amount: String(BigInt(parents.length) * COIN) }],
    changeAddress: owner.address, subtractFeeFromAmount: true };
}

test('a multi-parent sweep retains exact accounting and valid signatures after validation caching', async () => {
  const parents = Array.from({ length: 3 }, (_, index) => {
    const transaction = parent(); transaction.inputs[0].txid = (index + 1).toString(16).padStart(64, '0');
    const hex = serializeTransaction(transaction).toString('hex');
    return { hex, txid: transactionIdFromRaw(hex) };
  });
  const payment = await buildPaymentInWorker(workerOptions(parents));
  assert.equal(payment.selected.length, parents.length);
  assert.equal(payment.change, '0');
  assert.equal(BigInt(payment.inputTotal), BigInt(payment.total) + BigInt(payment.fee));
  assert.equal(BigInt(payment.total), BigInt(payment.transaction.outputs[0].amount));
  assert.equal(transactionIdFromRaw(payment.hex), payment.txid);
  for (let index = 0; index < parents.length; index++) assert.equal(verifySchnorr(
    Buffer.from(payment.transaction.inputs[index].witness[0], 'hex'),
    signatureHash(payment.transaction, parents.map(() => output), index), owner.publicKey), true);
});

test('an invalid nonselected parent public key remains rejected after valid repeated keys', async () => {
  const bytes = serializeTransaction(parent());
  // The final output's 32-byte key is followed only by the 4-byte locktime.
  bytes.fill(0xff, bytes.length - 36, bytes.length - 4);
  const hex = bytes.toString('hex'), txid = transactionIdFromRaw(hex);
  assert.throws(() => parseTransaction(hex));
  await assert.rejects(buildPaymentInWorker(workerOptions([{ hex, txid }])));
});

test('unselected output overflow and noncanonical parent bytes remain rejected', () => {
  const bytes = serializeTransaction(parent(2));
  const overflow = Buffer.from(bytes);
  overflow.writeBigInt64LE(MAX_MONEY, overflow.length - 45);
  assert.throws(() => parseTransaction(overflow.toString('hex')), /Total transaction outputs exceed/);
  assert.throws(() => parseTransaction(bytes.toString('hex') + '00'), /Trailing transaction data/);
  // One input and a 41-byte input body place the output count at offset 46.
  const overlongCount = Buffer.concat([bytes.subarray(0, 46), Buffer.from('fd0200', 'hex'), bytes.subarray(47)]);
  assert.throws(() => parseTransaction(overlongCount.toString('hex')), /Noncanonical/);
});

test.after(() => { owner.privateKey.fill(0); other.privateKey.fill(0); });
