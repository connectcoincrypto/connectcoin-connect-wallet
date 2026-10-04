import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAccount, verifySchnorr } from '../src/core/crypto.mjs';
import { buildPaymentInWorker } from '../src/core/payment-builder.mjs';
import { COIN, MAX_PAYMENT_INPUTS, MAX_PAYMENT_PARENT_HEX_BYTES, buildPayment, dustThreshold, selectPaymentFunding, serializeTransaction, signatureHash, transactionId, transactionVsize, validatePaymentFundingPayload } from '../src/core/transaction.mjs';

// Published BIP39 vector; never use a real wallet, RPC server or broadcast.
const mnemonic = `${'abandon '.repeat(11)}about`;
const account = deriveAccount(mnemonic);
const recipient = deriveAccount(mnemonic, { index: 1 });

function fixture(count = 1, value = COIN, gross = value * BigInt(count)) {
  const parents = Array.from({ length: count }, (_, index) => ({
    version: 2, locktime: index,
    inputs: [{ txid: '01'.repeat(32), vout: 0, scriptSig: '', sequence: 0xffffffff, witness: [] }],
    outputs: [{ type: 1, amount: String(value), publicKey: account.publicKey }],
  }));
  return { parents, options: {
    utxos: parents.map(parent => ({ txid: transactionId(parent), vout: 0, amount: String(value),
      rawTransaction: serializeTransaction(parent).toString('hex'), privateKey: account.privateKey })),
    outputs: [{ address: recipient.address, amount: String(gross) }], changeAddress: account.address,
    subtractFeeFromAmount: true,
  } };
}

function assertAccounting(payment) {
  assert.equal(BigInt(payment.inputTotal), BigInt(payment.total) + BigInt(payment.fee) + BigInt(payment.change));
  assert.equal(BigInt(payment.total), BigInt(payment.transaction.outputs[0].amount));
  assert.equal(BigInt(payment.fee), BigInt(payment.vsize) * 1500n);
  assert.equal(payment.vsize, transactionVsize(payment.transaction));
}

test('omitted/false fee deduction retains the previous sender-pays-fee behavior', () => {
  const { options } = fixture(1, 2n * COIN, COIN);
  delete options.subtractFeeFromAmount;
  const implicit = selectPaymentFunding(options);
  const explicit = selectPaymentFunding({ ...options, subtractFeeFromAmount: false });
  assert.deepEqual(implicit, explicit);
  assert.equal(explicit.total, String(COIN));
  assert.equal(explicit.requestedTotal, String(COIN));
  assert.equal(explicit.subtractFeeFromAmount, false);
  assert.equal(BigInt(explicit.change) + BigInt(explicit.fee), COIN);
  assert.throws(() => buildPayment({ ...options, outputs: [{ address: recipient.address, amount: String(2n * COIN) }] }), /Insufficient verified funds/);
});

test('all balance produces one output, no change, and subtracts the exact fee', () => {
  const { options, parents } = fixture(2, COIN);
  const payment = buildPayment(options);
  assert.equal(payment.selected.length, 2);
  assert.equal(payment.transaction.outputs.length, 1);
  assert.equal(payment.change, '0');
  assert.equal(payment.requestedTotal, String(2n * COIN));
  assert.equal(payment.subtractFeeFromAmount, true);
  assertAccounting(payment);
  const spent = parents.map(parent => parent.outputs[0]);
  for (let index = 0; index < 2; index++) assert.equal(verifySchnorr(
    Buffer.from(payment.transaction.inputs[index].witness[0], 'hex'),
    signatureHash(payment.transaction, spent, index), account.publicKey), true);
});

test('deduction covers the gross amount and returns change without increasing the debit', () => {
  const { options } = fixture(2, 2n * COIN, COIN);
  const payment = buildPayment(options);
  assert.equal(payment.selected.length, 1, 'do not consume unneeded UTXOs');
  assert.equal(payment.change, String(COIN));
  assert.equal(payment.requestedTotal, String(COIN));
  assert.equal(BigInt(payment.total) + BigInt(payment.fee), COIN);
  assertAccounting(payment);
});

test('dust change becomes spendable rather than an extra fee, with exact net accounting', () => {
  const { options } = fixture(1, COIN + 1n, COIN);
  const payment = buildPayment(options);
  const minimumChange = dustThreshold(payment.transaction.outputs[1]);
  assert.equal(BigInt(payment.change), minimumChange);
  assert.equal(BigInt(payment.total), COIN - BigInt(payment.fee) - (minimumChange - 1n));
  assert.equal(payment.requestedTotal, String(COIN));
  assertAccounting(payment);
});

test('deducting fees is explicit and single-recipient, never truthy-string enabled', () => {
  const { options } = fixture();
  for (const value of ['true', 'false', 1, 0, null, {}, []]) assert.throws(
    () => selectPaymentFunding({ ...options, subtractFeeFromAmount: value }), /must be a boolean/);
  assert.throws(() => selectPaymentFunding({ ...options, outputs: [...options.outputs, ...options.outputs] }), /exactly one recipient/);
});

test('negative, zero and dust net recipients are rejected after the subtraction', () => {
  const standard = selectPaymentFunding(fixture().options);
  const fee = BigInt(standard.fee);
  const minimum = dustThreshold({ type: 1, amount: '0', publicKey: recipient.publicKey });
  for (const amount of [fee - 1n, fee, fee + minimum - 1n]) assert.throws(
    () => buildPayment(fixture(1, amount).options), /after deducting the fee.*dust/);
  const threshold = buildPayment(fixture(1, fee + minimum).options);
  assert.equal(BigInt(threshold.total), minimum);
  assertAccounting(threshold);
  assert.throws(() => buildPayment({ ...fixture().options, maxFee: '1' }), /fee exceeds/);
  assert.throws(() => buildPayment(fixture(1, COIN, COIN + 1n).options), /Insufficient verified funds/);
});

test('P2C reward is also reduced and checked against its own dust threshold', () => {
  const { options } = fixture();
  options.outputs = [{ domain: 'example.com', amount: String(COIN), expectedConnections: '1' }];
  const payment = buildPayment(options);
  assert.equal(payment.transaction.outputs[0].type, 2);
  assertAccounting(payment);
  const minimum = dustThreshold(payment.transaction.outputs[0]);
  const low = fixture(1, BigInt(payment.fee) + minimum - 1n).options;
  low.outputs = [{ ...options.outputs[0], amount: low.outputs[0].amount }];
  assert.throws(() => buildPayment(low), /after deducting the fee.*dust/);
});

test('257 fragmented inputs can be swept and every output amount remains verified', () => {
  const { options, parents } = fixture(257, COIN / 100n);
  const payment = buildPayment(options);
  assert.equal(payment.selected.length, 257);
  assert.equal(payment.change, '0');
  assertAccounting(payment);
  const spent = parents.map(parent => parent.outputs[0]);
  for (const index of [0, 128, 256]) assert.equal(verifySchnorr(
    Buffer.from(payment.transaction.inputs[index].witness[0], 'hex'),
    signatureHash(payment.transaction, spent, index), account.publicKey), true);
  const dishonest = { ...options, utxos: options.utxos.map((utxo, index) => index === 0 ? { ...utxo, amount: String(COIN) } : utxo) };
  assert.throws(() => buildPayment(dishonest), /amount does not match/);
});

function publicCandidates(count, value = COIN) {
  return Array.from({ length: count }, (_, index) => ({
    txid: (index + 1).toString(16).padStart(64, '0'), vout: 0, amount: String(value),
    get privateKey() { throw new Error('Oversized plan read a private key'); },
    get rawTransaction() { throw new Error('Oversized plan parsed a funding parent'); },
  }));
}

test('exact weight bound accepts 1,738 one-output inputs but rejects change before signing', () => {
  assert.equal(MAX_PAYMENT_INPUTS, 1738);
  const options = { utxos: publicCandidates(MAX_PAYMENT_INPUTS),
    outputs: [{ address: recipient.address, amount: String(BigInt(MAX_PAYMENT_INPUTS) * COIN) }],
    changeAddress: account.address, subtractFeeFromAmount: true };
  const selected = selectPaymentFunding(options);
  assert.equal(selected.selected.length, MAX_PAYMENT_INPUTS);
  assert.equal(selected.vsize, 99989);
  assert.equal(selected.change, '0');
  const withChange = { ...options, outputs: [{ ...options.outputs[0], amount: String(BigInt(MAX_PAYMENT_INPUTS) * COIN - COIN / 2n) }] };
  assert.throws(() => buildPayment(withChange), /standard transaction weight limit/);
  assert.throws(() => buildPayment({ ...withChange, subtractFeeFromAmount: false }), /standard transaction weight limit/);
  const fewer = { ...withChange, utxos: options.utxos.slice(1),
    outputs: [{ ...withChange.outputs[0], amount: String(BigInt(MAX_PAYMENT_INPUTS - 1) * COIN - COIN / 2n) }] };
  assert.equal(selectPaymentFunding(fewer).selected.length, MAX_PAYMENT_INPUTS - 1);
  assert.throws(() => buildPayment({ ...options, utxos: publicCandidates(MAX_PAYMENT_INPUTS + 1) }), /input\/output count/);
  const largeOutput = { ...options, outputs: [{ domain: 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(61), amount: options.outputs[0].amount }] };
  assert.throws(() => buildPayment(largeOutput), /standard transaction weight limit/);
});

function sharedParent(count = 257) {
  const parent = { version: 2, locktime: 0,
    inputs: [{ txid: '01'.repeat(32), vout: 0, scriptSig: '', sequence: 0xffffffff, witness: ['02' + 'ab'.repeat(16383)] }],
    outputs: Array.from({ length: count }, () => ({ type: 1, amount: String(COIN), publicKey: account.publicKey })),
  };
  const txid = transactionId(parent), hex = serializeTransaction(parent).toString('hex');
  return { parent, options: {
    utxos: parent.outputs.map((output, vout) => ({ txid, vout, amount: output.amount, account: { index: 0, change: 0 } })),
    parents: [{ txid, hex }], mnemonic,
    outputs: [{ address: recipient.address, amount: String(COIN * BigInt(count)) }], changeAddress: account.address,
    subtractFeeFromAmount: true,
  } };
}

test('a compact worker payload shares one large parent across 257 inputs and verifies signatures', async () => {
  const { parent, options } = sharedParent();
  assert.equal(options.parents.length, 1);
  assert.equal(options.utxos.some(utxo => 'rawTransaction' in utxo), false);
  const payment = await buildPaymentInWorker(options);
  assert.equal(payment.selected.length, 257);
  assertAccounting(payment);
  for (const index of [0, 128, 256]) assert.equal(verifySchnorr(
    Buffer.from(payment.transaction.inputs[index].witness[0], 'hex'),
    signatureHash(payment.transaction, parent.outputs, index), account.publicKey), true);
});

test('a reused parent still validates every input amount, index, claimed txid and owner', async () => {
  const { options } = sharedParent(2);
  const mutate = update => ({ ...options, utxos: options.utxos.map((utxo, index) => index === 1 ? update(utxo) : utxo) });
  await assert.rejects(buildPaymentInWorker(mutate(utxo => ({ ...utxo, amount: String(2n * COIN) }))), /amount does not match/);
  await assert.rejects(buildPaymentInWorker(mutate(utxo => ({ ...utxo, vout: 2 }))), /does not exist/);
  await assert.rejects(buildPaymentInWorker(mutate(utxo => ({ ...utxo, account: { index: 1, change: 0 } }))), /not owned/);
  const wrongId = { ...options, utxos: options.utxos.map(utxo => ({ ...utxo, txid: 'ff'.repeat(32) })),
    parents: [{ ...options.parents[0], txid: 'ff'.repeat(32) }] };
  await assert.rejects(buildPaymentInWorker(wrongId), /ID does not match/);
  // A txid does not commit witnesses: do not cache by txid alone and skip a
  // malformed different raw parent supplied for another input with that id.
  const legacy = { ...options, parents: undefined, utxos: options.utxos.map((utxo, index) => ({ ...utxo,
    rawTransaction: options.parents[0].hex + (index ? '00' : '') })) };
  await assert.rejects(buildPaymentInWorker(legacy), /Trailing transaction data/);
});

test('funding memory cap counts repeated legacy hex before worker cloning or key access', async () => {
  assert.equal(MAX_PAYMENT_PARENT_HEX_BYTES, 64 * 1024 * 1024);
  const raw = '00'.repeat(4_000_000);
  const tooLarge = { utxos: Array.from({ length: 9 }, (_, vout) => ({
    txid: '01'.repeat(32), vout, amount: String(COIN), rawTransaction: raw,
  })), get mnemonic() { throw new Error('Pre-clone budget check accessed seed'); } };
  await assert.rejects(buildPaymentInWorker(tooLarge), /funding data exceeds the local memory limit/);
  const compact = { utxos: tooLarge.utxos.map(({ rawTransaction, ...utxo }) => utxo), parents: [{ txid: '01'.repeat(32), hex: raw }] };
  assert.equal(validatePaymentFundingPayload(compact).size, 1, 'one shared raw is counted once on the new wire');
  const manyParents = { utxos: [{ txid: '01'.repeat(32), vout: 0 }], parents: Array.from({ length: 9 }, (_, index) => ({
    txid: (index + 1).toString(16).padStart(64, '0'), hex: raw,
  })) };
  await assert.rejects(buildPaymentInWorker(manyParents), /funding data exceeds the local memory limit/);
});

test('compact funding rejects duplicate, missing and conflicting parents', async () => {
  const { options } = sharedParent(2);
  await assert.rejects(buildPaymentInWorker({ ...options, parents: [...options.parents, ...options.parents] }), /Duplicate funding parent/);
  await assert.rejects(buildPaymentInWorker({ ...options, parents: undefined }), /Missing funding parent/);
  await assert.rejects(buildPaymentInWorker({ ...options, parents: [{ ...options.parents[0], txid: 'ff'.repeat(32) }] }), /Missing funding parent/);
  const conflict = { ...options, utxos: options.utxos.map(utxo => ({ ...utxo, rawTransaction: options.parents[0].hex + '00' })) };
  await assert.rejects(buildPaymentInWorker(conflict), /Conflicting funding transaction bytes/);
});

test.after(() => { account.privateKey.fill(0); recipient.privateKey.fill(0); });
