import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAddress } from '../src/core/crypto.mjs';
import { MAX_MONEY, dustThreshold, selectPaymentFunding, serializeTransaction, transactionVsize } from '../src/core/transaction.mjs';

// Public curve generator only: selection never needs secret material or RPC.
const publicKey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const address = encodeAddress(publicKey);
const value = 1_000_000_000_000n;
const domains = ['a', 'a'.repeat(63), `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`];
const templates = [{ type: 1, publicKey }, ...domains.map(domain => ({ type: 2, domain, target: 'ff'.repeat(32), rootVersion: 1, mask: 7 }))];
const asRecipient = (output, amount) => ({ amount: String(amount), ...(output.type === 1 ? { address }
  : { domain: output.domain, target: output.target, rootVersion: output.rootVersion, mask: output.mask }) });
const candidates = count => Array.from({ length: count }, (_, index) => ({
  txid: (index + 1).toString(16).padStart(64, '0'), vout: index, amount: String(value),
  get rawTransaction() { throw new Error('Public boundary selection must not access a parent'); },
  get privateKey() { throw new Error('Public boundary selection must not access a key'); },
}));
const transaction = (utxos, outputs) => ({ version: 2, locktime: 0,
  inputs: utxos.map(({ txid, vout }) => ({ txid, vout, scriptSig: '', sequence: 0xfffffffd, witness: ['00'.repeat(64)] })), outputs,
});

test('fee-deducted boundary matrix matches independently serialized weight and exact conservation', () => {
  let accepted = 0, oversized = 0;
  const changeDust = dustThreshold({ type: 1, publicKey, amount: '0' });
  for (const count of [1, 2, 252, 253, 1737, 1738]) for (const feeRate of [1201, 1500, 1000000]) {
    const utxos = candidates(count), inputTotal = value * BigInt(count);
    for (const output of templates) for (const remainder of [0n, 1n, changeDust - 1n, changeDust, value / 2n]) {
      const gross = inputTotal - remainder;
      const change = remainder === 0n ? 0n : remainder < changeDust ? changeDust : remainder;
      const reference = transaction(utxos, [{ ...output, amount: String(gross) },
        ...(change ? [{ type: 1, publicKey, amount: String(change) }] : [])]);
      const base = serializeTransaction(reference, { witness: false }).length;
      const full = serializeTransaction(reference).length;
      const weight = base * 3 + full;
      const options = { utxos, outputs: [asRecipient(output, gross)], changeAddress: address,
        subtractFeeFromAmount: true, feeRate, maxFee: String(MAX_MONEY) };
      if (weight > 400000) {
        assert.throws(() => selectPaymentFunding(options), /standard transaction weight limit/);
        oversized++; continue;
      }
      const selected = selectPaymentFunding(options), fee = BigInt(Math.ceil(weight / 4)) * BigInt(feeRate);
      assert.equal(selected.selected.length, count);
      assert.equal(selected.vsize, Math.ceil(weight / 4));
      assert.equal(selected.fee, String(fee));
      assert.equal(selected.change, String(change));
      assert.equal(selected.total, String(gross - fee - (change - remainder)));
      assert.equal(BigInt(selected.total) + BigInt(selected.fee) + BigInt(selected.change), inputTotal);
      accepted++;
    }
  }
  assert.equal(accepted + oversized, 360);
  assert.ok(accepted > 0 && oversized > 0);
});

test('sender-pays multi-output boundary matrix preserves recipients and exact fee accounting', () => {
  for (const count of [1, 2, 252, 253]) for (const outputCount of [1, 2, 100]) for (const feeRate of [1201, 1500, 1000000]) {
    const utxos = candidates(count), inputTotal = value * BigInt(count);
    // Leave half an input value for fee/change, requiring all inputs at every fee rate.
    const total = inputTotal - value / 2n;
    const outputs = Array.from({ length: outputCount }, (_, index) => ({ ...templates[index % templates.length],
      amount: String(total / BigInt(outputCount) + (index === 0 ? total % BigInt(outputCount) : 0n)) }));
    const selected = selectPaymentFunding({ utxos, outputs: outputs.map(output => asRecipient(output, output.amount)),
      changeAddress: address, feeRate, maxFee: String(MAX_MONEY) });
    const reference = transaction(utxos, [...outputs, { type: 1, publicKey, amount: selected.change }]);
    assert.equal(selected.selected.length, count);
    assert.equal(selected.total, String(total));
    assert.equal(selected.vsize, transactionVsize(reference));
    assert.equal(BigInt(selected.fee), BigInt(transactionVsize(reference)) * BigInt(feeRate));
    assert.equal(BigInt(selected.fee) + BigInt(selected.change) + total, inputTotal);
  }
});
