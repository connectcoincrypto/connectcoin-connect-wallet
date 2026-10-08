import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import { parsePaymentBatch, parsePaymentBatchResponse, parsePaymentBatchDismissal, paymentBatchTotals } from '../src/payment-batch.mjs';

const address = bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.toBytes(true).slice(1))]);
const otherAddress = bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.double().toBytes(true).slice(1))]);
const batchId = 'f00faaca-1037-4d1c-96cb-b09c819e6052';
function fixture(statuses = ['submitted', 'check-required', 'not-sent']) {
  const transactions = statuses.map((status, index) => ({ txid: index.toString(16).padStart(64, '0'), status, amount: '10000000001', fee: '12345' }));
  const submittedCount = statuses.filter(status => status === 'submitted').length;
  return { batch: true, batchId, walletId: address, address: otherAddress,
    status: statuses.includes('check-required') ? 'check-required' : submittedCount === statuses.length ? 'submitted' : submittedCount ? 'partial' : 'not-sent',
    transactionCount: statuses.length, submittedCount, transactions,
    requestedTotal: (10000000001n * BigInt(statuses.length)).toString(), total: (10000000001n * BigInt(statuses.length)).toString(), fee: (12345n * BigInt(statuses.length)).toString() };
}

test('native batch amounts remain exact and distinguish planned, submitted, unknown, and unsent', () => {
  const batch = parsePaymentBatch(fixture());
  assert.equal(batch.total, '30000000003');
  assert.deepEqual(paymentBatchTotals(batch), {
    submitted: { count: 1, amount: '10000000001', fee: '12345' },
    'check-required': { count: 1, amount: '10000000001', fee: '12345' },
    'not-sent': { count: 1, amount: '10000000001', fee: '12345' },
  });
  assert.ok(Object.isFrozen(batch)); assert.ok(Object.isFrozen(batch.transactions[0]));
  const deducting = fixture(); deducting.requestedTotal = (BigInt(deducting.total) + BigInt(deducting.fee)).toString();
  assert.equal(parsePaymentBatch(deducting).requestedTotal, '30000037038');
  deducting.requestedTotal = (BigInt(deducting.requestedTotal) + 30n).toString();
  assert.equal(parsePaymentBatch(deducting).requestedTotal, '30000037068'); // Dust top-up stays as spendable change.
});

test('batch status must exactly match every part, without inferring confirmations', () => {
  for (const statuses of [['submitted', 'submitted'], ['submitted', 'not-sent'], ['not-sent', 'not-sent'], ['submitted', 'check-required'], ['check-required', 'not-sent']]) {
    const source = fixture(statuses);
    assert.equal(parsePaymentBatch(source).status, source.status);
    for (const status of ['submitted', 'partial', 'check-required', 'not-sent', 'confirmed', 'pending', 'failed']) {
      if (status !== source.status) assert.throws(() => parsePaymentBatch({ ...source, status }));
    }
  }
});

test('only strict bounded native summaries and exact aggregates are accepted', () => {
  const patches = [{ batch: false }, { batchId: batchId.toUpperCase() }, { batchId: 'x'.repeat(4096) },
    { walletId: 'untrusted' }, { address: 'javascript:alert(1)' }, { transactionCount: 1 }, { transactionCount: 33 },
    { transactionCount: '3' }, { submittedCount: 3 }, { submittedCount: -0 }, { total: '30000000004' }, { fee: '37034' },
    { requestedTotal: '30000000004' }, { total: 30000000003 }, { total: '1e10' }, { fee: '0' },
    { requestedTotal: '1000000000000000001' }, { total: '-1' }, { total: '030000000003' }, { message: '<script>evil()</script>' }];
  for (const patch of patches) assert.throws(() => parsePaymentBatch({ ...fixture(), ...patch }), JSON.stringify(patch));
  assert.throws(() => parsePaymentBatch(fixture(Array(33).fill('submitted'))));
  assert.equal(parsePaymentBatch(fixture(Array(32).fill('submitted'))).transactionCount, 32);
  for (const patch of [{ txid: 'f'.repeat(63) }, { txid: 'G'.repeat(64) }, { status: 'confirmed' }, { amount: '0' }, { fee: '01' }, { raw: 'secret' }]) {
    const source = fixture(); Object.assign(source.transactions[0], patch);
    assert.throws(() => parsePaymentBatch(source));
  }
  const duplicate = fixture(); duplicate.transactions[1].txid = duplicate.transactions[0].txid;
  assert.throws(() => parsePaymentBatch(duplicate));
  const highFees = fixture(); highFees.transactions[0].fee = '10000000000'; highFees.fee = '10000024690';
  assert.throws(() => parsePaymentBatch(highFees));
});

test('getters, inherited fields, and sparse or extended arrays are not inspected as receipts', () => {
  let read = false;
  const source = fixture(); Object.defineProperty(source, 'batchId', { get() { read = true; return batchId; } });
  assert.throws(() => parsePaymentBatch(source)); assert.equal(read, false);
  const part = fixture(); Object.defineProperty(part.transactions[0], 'amount', { get() { read = true; return '1'; } });
  assert.throws(() => parsePaymentBatch(part)); assert.equal(read, false);
  const array = fixture(); Object.defineProperty(array.transactions, '0', { get() { read = true; return fixture().transactions[0]; } });
  assert.throws(() => parsePaymentBatch(array)); assert.equal(read, false);
  const sparse = fixture(); delete sparse.transactions[0]; assert.throws(() => parsePaymentBatch(sparse));
  const extended = fixture(); extended.transactions.extra = 1; assert.throws(() => parsePaymentBatch(extended));
  assert.throws(() => parsePaymentBatch(Object.create(fixture())));
});

test('the global native receipt stays readable for a different or locked wallet', () => {
  const previousWallet = { ...fixture(), walletId: otherAddress };
  assert.equal(parsePaymentBatchResponse({ batch: previousWallet }).walletId, otherAddress);
  assert.equal(parsePaymentBatchResponse({ batch: null }), null);
  for (const response of [null, {}, { batch: null, message: 'okay' }, { batch: false }])
    assert.throws(() => parsePaymentBatchResponse(response));
});

test('acknowledgement requires the exact native batch identity and affirmative result', () => {
  parsePaymentBatchDismissal({ dismissed: true, batchId }, batchId);
  for (const response of [{ dismissed: false, batchId }, { dismissed: true, batchId, released: true }, {},
    { dismissed: true, batchId: 'f00faaca-1037-4d1c-96cb-b09c819e6053' }])
    assert.throws(() => parsePaymentBatchDismissal(response, batchId));
});
