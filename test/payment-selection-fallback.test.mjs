import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAccount, verifySchnorr } from '../src/core/crypto.mjs';
import { buildPayment, selectPaymentFunding, serializeTransaction, signatureHash, transactionId } from '../src/core/transaction.mjs';

// Published test mnemonic and synthetic funding only. No profile or network.
const owner = deriveAccount(`${'abandon '.repeat(11)}about`);
const funding = amount => ({ version: 2, locktime: Number(amount),
  inputs: [{ txid: '01'.repeat(32), vout: 0, scriptSig: '', sequence: 0xffffffff, witness: [] }],
  outputs: [{ type: 1, amount, publicKey: owner.publicKey }],
});
const candidate = amount => {
  const parent = funding(amount);
  return { txid: transactionId(parent), vout: 0, amount,
    rawTransaction: serializeTransaction(parent).toString('hex'), privateKey: owner.privateKey };
};

test('fee deduction can use an exact smaller coin when change would leave a dust recipient', () => {
  const exact = candidate('200000'), larger = candidate('300000');
  const options = { outputs: [{ address: owner.address, amount: exact.amount }],
    changeAddress: owner.address, subtractFeeFromAmount: true };
  const baseline = buildPayment({ ...options, utxos: [exact] });
  assert.equal(baseline.total, '36500');
  assert.equal(baseline.fee, '163500');
  assert.equal(baseline.change, '0');
  for (const utxos of [[larger, exact], [exact, larger]]) {
    const selection = selectPaymentFunding({ ...options, utxos });
    assert.equal(selection.selected.length, 1);
    assert.equal(selection.selected[0].txid, exact.txid);
    const payment = buildPayment({ ...options, utxos });
    assert.equal(payment.total, baseline.total);
    assert.equal(payment.fee, baseline.fee);
    assert.equal(payment.change, '0');
    assert.equal(verifySchnorr(Buffer.from(payment.transaction.inputs[0].witness[0], 'hex'),
      signatureHash(payment.transaction, [funding(exact.amount).outputs[0]], 0), owner.publicKey), true);
  }
});

test('sender-pays selection still prefers a larger coin that covers the separate fee', () => {
  const exact = candidate('200000'), larger = candidate('500000');
  const options = { outputs: [{ address: owner.address, amount: exact.amount }], changeAddress: owner.address };
  const selection = selectPaymentFunding({ ...options, utxos: [exact, larger] });
  assert.equal(selection.selected.length, 1);
  assert.equal(selection.selected[0].txid, larger.txid);
  const payment = buildPayment({ ...options, utxos: [exact, larger] });
  assert.equal(payment.total, '200000');
  assert.equal(payment.fee, '225000');
  assert.equal(payment.change, '75000');
});

test('an exact coin cannot bypass fee or recipient dust limits', () => {
  const exact = candidate('163500'), larger = candidate('500000');
  const options = { outputs: [{ address: owner.address, amount: exact.amount }],
    changeAddress: owner.address, subtractFeeFromAmount: true };
  assert.throws(() => buildPayment({ ...options, utxos: [larger, exact] }), /after deducting the fee/);
  assert.throws(() => buildPayment({ ...options, utxos: [larger] }), /after deducting the fee/);
  const viableExact = candidate('200000');
  assert.throws(() => buildPayment({ ...options, outputs: [{ address: owner.address, amount: viableExact.amount }],
    utxos: [larger, viableExact], maxFee: '100000' }), /fee exceeds the wallet safety limit/);
});

test('exact-match preference does not trust a forged funding amount', () => {
  const smaller = candidate('199999'), larger = candidate('500000');
  assert.throws(() => buildPayment({ utxos: [larger, { ...smaller, amount: '200000' }],
    outputs: [{ address: owner.address, amount: '200000' }],
    changeAddress: owner.address, subtractFeeFromAmount: true }), /amount/);
});

test.after(() => owner.privateKey.fill(0));
