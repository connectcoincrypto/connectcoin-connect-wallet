import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAccount, sha256, taggedHash, verifySchnorr } from '../src/core/crypto.mjs';
import { MAX_PAYMENT_INPUTS, buildPayment, outputPayload, selectPaymentFunding, serializeOutput, serializeTransaction, signatureHash, transactionId, transactionVsize } from '../src/core/transaction.mjs';

// Published BIP39 test vector only. No wallet files, real keys or network calls.
const mnemonic = `${'abandon '.repeat(11)}about`;
const account = deriveAccount(mnemonic);
const destination = deriveAccount(mnemonic, { index: 1 });
const value = 100_000_000n;

function fixture(count) {
  const parents = Array.from({ length: count }, (_, index) => ({
    version: 2, locktime: 0,
    inputs: [{ txid: (index + 1).toString(16).padStart(64, '0'), vout: 0, scriptSig: '', sequence: 0xffffffff, witness: ['02' + '00'.repeat(8191)] }],
    outputs: [{ type: 1, amount: value.toString(), publicKey: account.publicKey }],
  }));
  const utxos = parents.map(parent => ({ txid: transactionId(parent), vout: 0, amount: value.toString(),
    rawTransaction: serializeTransaction(parent).toString('hex'), privateKey: account.privateKey }));
  return { parents, options: { utxos, outputs: [{ address: destination.address, amount: (value * BigInt(count) - 50_000_000n).toString() }], changeAddress: account.address } };
}

function referenceSighash(tx, spent, index) {
  const u32 = value => { const result = Buffer.alloc(4); result.writeUInt32LE(value); return result; };
  const i64 = value => { const result = Buffer.alloc(8); result.writeBigInt64LE(BigInt(value)); return result; };
  return taggedHash('TapSighash', Buffer.concat([
    Buffer.from([0, 0]), u32(tx.version), u32(tx.locktime),
    sha256(Buffer.concat(tx.inputs.map(input => Buffer.concat([Buffer.from(input.txid, 'hex').reverse(), u32(input.vout)])))),
    sha256(Buffer.concat(spent.map(output => i64(output.amount)))),
    sha256(Buffer.concat(spent.map(outputPayload))),
    sha256(Buffer.concat(tx.inputs.map(input => u32(input.sequence)))),
    sha256(Buffer.concat(tx.outputs.map(serializeOutput))),
    Buffer.from([0]), u32(index),
  ]));
}

test('public selection reads neither private keys nor raw parents and stops at the required funds', () => {
  const { options } = fixture(4);
  options.outputs[0].amount = '100000';
  const publicOnly = options.utxos.map(({ txid, vout, amount }) => ({ txid, vout, amount,
    get privateKey() { throw new Error('Selection accessed a private key'); },
    get rawTransaction() { throw new Error('Selection fetched unneeded funding'); },
  }));
  const selected = selectPaymentFunding({ ...options, utxos: publicOnly });
  assert.equal(selected.selected.length, 1);
  assert.equal(selected.selected[0], publicOnly[0]);
  assert.equal(selected.inputTotal, value.toString());
  assert.equal(BigInt(selected.fee) + BigInt(selected.total) + BigInt(selected.change), value);
});

for (const count of [1, 252, 253, 256]) test(`exact linear fee estimate matches serialization with ${count} inputs`, () => {
  const { options } = fixture(count);
  const selected = selectPaymentFunding(options);
  const payment = buildPayment(options);
  assert.equal(payment.selected.length, count);
  assert.equal(payment.vsize, selected.vsize);
  assert.equal(payment.vsize, transactionVsize(payment.transaction));
  assert.equal(BigInt(payment.fee), BigInt(payment.vsize) * 1500n);
  assert.equal(BigInt(payment.fee) + BigInt(payment.total) + BigInt(payment.change), value * BigInt(count));
});

test('no-change sizing keeps the exact witness rounding and includes unused dust in the fee', () => {
  for (const count of [1, 2, 253]) {
    const { options } = fixture(count);
    const dummy = { version: 2, locktime: 0,
      inputs: options.utxos.map(utxo => ({ txid: utxo.txid, vout: utxo.vout, scriptSig: '', sequence: 0xfffffffd, witness: ['00'.repeat(64)] })),
      outputs: [{ type: 1, amount: '1000', publicKey: destination.publicKey }],
    };
    const vsize = transactionVsize(dummy);
    const fee = BigInt(vsize) * 1500n + 100n;
    options.outputs[0].amount = (value * BigInt(count) - fee).toString();
    const selected = selectPaymentFunding(options);
    const payment = buildPayment(options);
    assert.equal(selected.change, '0');
    assert.equal(payment.transaction.outputs.length, 1);
    assert.equal(payment.change, '0');
    assert.equal(BigInt(payment.fee), fee);
    assert.equal(payment.vsize, vsize);
    assert.equal(transactionVsize(payment.transaction), vsize);
  }
});

test('cached signing matches the independent precomputation-free digest for every input', () => {
  const { options, parents } = fixture(16);
  const payment = buildPayment(options);
  const spent = parents.map(parent => parent.outputs[0]);
  for (let index = 0; index < payment.selected.length; index++) {
    const digest = referenceSighash(payment.transaction, spent, index);
    assert.deepEqual(signatureHash(payment.transaction, spent, index), digest);
    assert.equal(verifySchnorr(Buffer.from(payment.transaction.inputs[index].witness[0], 'hex'), digest, account.publicKey), true);
  }
  const previous = signatureHash(payment.transaction, spent, 0);
  payment.transaction.outputs[0].amount = '1000';
  assert.notDeepEqual(signatureHash(payment.transaction, spent, 0), previous, 'no cache may survive a transaction mutation');
});

test('public selection never substitutes for raw funding/amount/ownership checks', () => {
  const { options } = fixture(1);
  const changedAmount = { ...options, utxos: [{ ...options.utxos[0], amount: (value + 1n).toString() }] };
  assert.equal(selectPaymentFunding(changedAmount).selected.length, 1);
  assert.throws(() => buildPayment(changedAmount), /amount does not match/);
  const otherKey = { ...options, utxos: [{ ...options.utxos[0], privateKey: destination.privateKey }] };
  assert.throws(() => buildPayment(otherKey), /not owned/);
  const otherParent = { ...options, utxos: [{ ...options.utxos[0], txid: 'aa'.repeat(32) }] };
  assert.throws(() => buildPayment(otherParent), /ID does not match/);
});

test('selection preserves duplicate, insufficient-funds, input-count and fee guards', () => {
  const { options } = fixture(2);
  assert.throws(() => selectPaymentFunding({ ...options, utxos: [options.utxos[0], options.utxos[0]] }), /Duplicate funding/);
  assert.throws(() => selectPaymentFunding({ ...options, utxos: [options.utxos[0], { ...options.utxos[0], txid: options.utxos[0].txid.toUpperCase() }] }), /Duplicate funding/);
  assert.throws(() => selectPaymentFunding({ ...options, utxos: options.utxos.slice(0, 1) }), /Insufficient/);
  assert.throws(() => selectPaymentFunding({ ...options, utxos: Array(MAX_PAYMENT_INPUTS + 1).fill(options.utxos[0]) }), /input\/output count/);
  assert.throws(() => selectPaymentFunding({ ...options, maxFee: '1' }), /fee exceeds/);
});

test.after(() => { account.privateKey.fill(0); destination.privateKey.fill(0); });
