import { parseMainnetAddress } from './model.mjs';

const MAX_MONEY = 1_000_000_000_000_000_000n;
const FIELDS = ['batch', 'batchId', 'walletId', 'status', 'transactionCount', 'submittedCount', 'transactions', 'address', 'requestedTotal', 'total', 'fee'];
const STATUSES = ['submitted', 'check-required', 'not-sent'];

function invalid() { throw new Error('Could not validate the saved payment result.'); }
function record(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) invalid();
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  return value;
}
function money(value, positive = false) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) invalid();
  const number = BigInt(value);
  if (number > MAX_MONEY || positive && number === 0n) invalid();
  return number;
}
function address(value) {
  if (typeof value !== 'string' || value.length > 90 || parseMainnetAddress(value) !== value) invalid();
  return value;
}
function batchId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid();
  return value;
}

// This is a display receipt from the local native journal, never funding data.
// Reject an entire malformed receipt rather than selectively showing success.
export function parsePaymentBatch(value) {
  const source = record(value, FIELDS);
  if (source.batch !== true ||
      !Number.isSafeInteger(source.transactionCount) || source.transactionCount < 2 || source.transactionCount > 32 ||
      !Number.isSafeInteger(source.submittedCount) || Object.is(source.submittedCount, -0) || source.submittedCount < 0 || source.submittedCount > source.transactionCount ||
      !Array.isArray(source.transactions) || source.transactions.length !== source.transactionCount) invalid();
  batchId(source.batchId); address(source.address); address(source.walletId);
  const parts = source.transactions;
  if (Object.getPrototypeOf(parts) !== Array.prototype || Reflect.ownKeys(parts).length !== parts.length + 1) invalid();
  for (let index = 0; index < parts.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(parts, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  const requested = money(source.requestedTotal, true), total = money(source.total, true), fee = money(source.fee, true);
  const ids = new Set(), totals = Object.fromEntries(STATUSES.map(status => [status, { count: 0, amount: 0n, fee: 0n }]));
  const transactions = Array.from(source.transactions, part => {
    record(part, ['txid', 'status', 'amount', 'fee']);
    if (typeof part.txid !== 'string' || !/^[0-9a-f]{64}$/.test(part.txid) || ids.has(part.txid) || !STATUSES.includes(part.status)) invalid();
    ids.add(part.txid);
    totals[part.status].count++;
    totals[part.status].amount += money(part.amount, true);
    totals[part.status].fee += money(part.fee, true);
    return Object.freeze({ txid: part.txid, status: part.status, amount: part.amount, fee: part.fee });
  });
  const sum = field => Object.values(totals).reduce((sum, group) => sum + group[field], 0n);
  const expectedStatus = totals['check-required'].count ? 'check-required'
    : totals.submitted.count === transactions.length ? 'submitted' : totals.submitted.count ? 'partial' : 'not-sent';
  if (source.status !== expectedStatus || source.submittedCount !== totals.submitted.count ||
      sum('amount') !== total || sum('fee') !== fee || fee > 10_000_000_000n || total + fee > MAX_MONEY ||
      !(requested === total || requested >= total + fee)) invalid();
  return Object.freeze({ batch: true, batchId: source.batchId, walletId: source.walletId, status: source.status,
    transactionCount: source.transactionCount, submittedCount: source.submittedCount, transactions: Object.freeze(transactions),
    address: source.address, requestedTotal: source.requestedTotal, total: source.total, fee: source.fee });
}

export function parsePaymentBatchResponse(value) {
  record(value, ['batch']);
  return value.batch === null ? null : parsePaymentBatch(value.batch);
}

export function parsePaymentBatchDismissal(value, expectedId) {
  record(value, ['dismissed', 'batchId']);
  if (value.dismissed !== true || batchId(value.batchId) !== expectedId) invalid();
}

export function paymentBatchTotals(batch) {
  const totals = Object.fromEntries(STATUSES.map(status => [status, { count: 0, amount: 0n, fee: 0n }]));
  for (const part of batch.transactions) {
    const group = totals[part.status];
    group.count++; group.amount += BigInt(part.amount); group.fee += BigInt(part.fee);
  }
  return Object.fromEntries(Object.entries(totals).map(([status, group]) => [status,
    { count: group.count, amount: group.amount.toString(), fee: group.fee.toString() }]));
}
