// Public, read-only mobile model. Keep this module free of private-key and Node APIs.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import { parseClipboardPaymentText } from '../../src/core/payment-uri.mjs';

export const MAINNET_GENESIS = '30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e';
export const RPC_ENDPOINT = Object.freeze({ host: 'connectcoin4.com', port: 48191, tls: true });

const COIN = 10_000_000_000n;
const MAX_MONEY = 100_000_000n * COIN;
const MAX_HISTORY = 2000;
const MAX_PAGE = 500;
const HASH = /^[0-9a-f]{64}$/;
const TIP_FIELDS = ['chain', 'genesis_hash', 'height', 'hash', 'mediantime'];
const BALANCE_FIELDS = ['confirmed', 'immature', 'available_confirmed', 'pending_received', 'pending_spent', 'pending_delta', 'total'];
const HISTORY_FIELDS = ['txid', 'status', 'block_height', 'block_hash', 'confirmations', 'received', 'spent', 'balance_delta'];

function invalid(message = 'The RPC server returned invalid data.') {
  throw new Error(message);
}

// Inspect descriptors before reading fields, including when used outside JSON.parse.
// Unknown fields are rejected instead of being copied into the UI model.
function record(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) invalid();
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  return value;
}

function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) invalid();
  return value;
}

function hash(value) {
  if (typeof value !== 'string' || !HASH.test(value)) invalid();
  return value;
}

function money(value, signed = false) {
  if (typeof value !== 'string' || value.length > 20 ||
      !(signed ? /^(?:0|-?[1-9][0-9]{0,18})$/ : /^(?:0|[1-9][0-9]{0,18})$/).test(value)) invalid();
  const amount = BigInt(value);
  if (amount > MAX_MONEY || amount < (signed ? -MAX_MONEY : 0n)) invalid();
  return amount;
}

export function parseWatchAddress(text) {
  try {
    const { address } = parseClipboardPaymentText(text);
    const decoded = bech32m.decode(address, 90);
    if (decoded.prefix !== 'cc' || decoded.words[0] !== 1) invalid();
    const publicKey = bech32m.fromWords(decoded.words.slice(1));
    if (publicKey.length !== 32) invalid();
    const compressed = new Uint8Array(33);
    compressed[0] = 2;
    compressed.set(publicKey, 1);
    secp256k1.Point.fromBytes(compressed);
    return bech32m.encode('cc', [1, ...bech32m.toWords(publicKey)]);
  } catch {
    // Do not render hostile address/URI text or a dependency's detailed exception.
    throw new Error('Enter a valid ConnectCoin mainnet address or "connectcoin:" payment link.');
  }
}

export function formatConn(value) {
  const amount = money(value, true);
  const absolute = amount < 0n ? -amount : amount;
  const fraction = (absolute % COIN).toString().padStart(10, '0').replace(/0+$/, '');
  return `${amount < 0n ? '-' : ''}${absolute / COIN}${fraction ? `.${fraction}` : ''}`;
}

export function validateTip(result) {
  const tip = record(result, TIP_FIELDS);
  if (tip.chain !== 'main' || tip.genesis_hash !== MAINNET_GENESIS) invalid('The RPC server is not on the expected ConnectCoin mainnet.');
  const height = integer(tip.height);
  const blockHash = hash(tip.hash);
  const mediantime = integer(tip.mediantime);
  if (height === 0 && blockHash !== MAINNET_GENESIS) invalid();
  return { chain: 'main', genesis_hash: MAINNET_GENESIS, height, hash: blockHash, mediantime };
}

function addressEnvelope(result, address) {
  const canonical = parseWatchAddress(address);
  if (result.address !== canonical || result.unit !== 'connects') invalid();
  return { address: canonical, tip: validateTip(result.tip), unit: 'connects' };
}

export function validateBalance(result, address) {
  record(result, ['address', 'tip', 'unit', ...BALANCE_FIELDS]);
  const validated = addressEnvelope(result, address);
  const amounts = Object.fromEntries(BALANCE_FIELDS.map(field => [field, money(result[field], field === 'pending_delta')]));
  if (amounts.available_confirmed !== amounts.confirmed - amounts.immature - amounts.pending_spent ||
      amounts.pending_delta !== amounts.pending_received - amounts.pending_spent ||
      amounts.total !== amounts.confirmed + amounts.pending_delta) invalid();
  for (const field of BALANCE_FIELDS) validated[field] = amounts[field].toString();
  return validated;
}

function historyItem(value, tip) {
  const row = record(value, HISTORY_FIELDS);
  const txid = hash(row.txid);
  const confirmations = integer(row.confirmations);
  if (row.status === 'pending') {
    if (row.block_height !== null || row.block_hash !== null || confirmations !== 0) invalid();
  } else if (row.status === 'confirmed') {
    integer(row.block_height);
    hash(row.block_hash);
    if (confirmations < 1 || (row.block_height === 0 && row.block_hash !== MAINNET_GENESIS)) invalid();
    if (tip && (row.block_height > tip.height || confirmations !== tip.height - row.block_height + 1 ||
        (row.block_height === tip.height && row.block_hash !== tip.hash))) invalid();
  } else invalid();
  const received = money(row.received), spent = money(row.spent), delta = money(row.balance_delta, true);
  if (delta !== received - spent) invalid();
  return { txid, status: row.status, block_height: row.block_height, block_hash: row.block_hash,
    confirmations, received: received.toString(), spent: spent.toString(), balance_delta: delta.toString() };
}

export function validateHistory(result, address) {
  record(result, ['address', 'tip', 'unit', 'live', 'items', 'next_cursor']);
  const validated = addressEnvelope(result, address);
  if (result.live !== true || !Array.isArray(result.items) || result.items.length > MAX_PAGE) invalid();
  if (result.next_cursor !== null && (typeof result.next_cursor !== 'string' || result.next_cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.next_cursor) || result.items.length === 0)) invalid();
  const items = Array.from(result.items, item => historyItem(item, validated.tip));
  if (new Set(items.map(item => item.txid)).size !== items.length) invalid();
  return { ...validated, live: true, items, next_cursor: result.next_cursor };
}

// This is a bounded display merge, not a complete ledger or balance calculation.
// Callers must surface pagination/truncation and replace the list for a full refresh
// (a merge alone cannot remove an evicted mempool transaction).
export function mergeHistory(existing, incoming) {
  if (!Array.isArray(existing) || !Array.isArray(incoming) || existing.length > MAX_HISTORY || incoming.length > MAX_HISTORY) invalid();
  const rows = new Map();
  for (const list of [existing, incoming]) {
    for (const value of list) {
      const item = historyItem(value);
      rows.set(item.txid, item);
    }
  }
  return [...rows.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
    if (a.block_height !== b.block_height) return b.block_height - a.block_height;
    return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
  }).slice(0, MAX_HISTORY);
}
