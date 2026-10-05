import { validateTip } from './config.mjs';

const HASH = /^[0-9a-f]{64}$/;
const hash = value => typeof value === 'string' && HASH.test(value);
const CURSOR = /^[A-Za-z0-9_.-]{1,4096}$/;
const MAX_MONEY = 1000000000000000000n;
const MAX_ROWS_PER_ADDRESS = 20000;
const MAX_TOTAL_ROWS = 200000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));
const invalid = () => new Error('RPC returned an invalid address synchronization response.');
export const addressSyncStale = () => Object.assign(new Error('Address synchronization snapshot must be refreshed.'), { code: -32011 });
function money(value, signed = false) {
  if (typeof value !== 'string' || !/^-?\d{1,19}$/.test(value)) throw invalid();
  const amount = BigInt(value);
  if (amount > MAX_MONEY || amount < (signed ? -MAX_MONEY : 0n)) throw invalid();
  return amount;
}
function location(row) {
  if (!plain(row) || !hash(row.txid) || !['pending', 'confirmed'].includes(row.status) ||
      !Number.isSafeInteger(row.confirmations) || row.confirmations < 0) throw invalid();
  if (row.status === 'pending') {
    if (row.block_height !== null || row.confirmations !== 0) throw invalid();
  } else if (!Number.isSafeInteger(row.block_height) || row.block_height < 0) throw invalid();
  return { txid: row.txid, status: row.status, block_height: row.block_height, confirmations: row.confirmations };
}
export function syncHistoryRow(row) {
  const result = location(row);
  if (row.status === 'pending' ? row.block_hash !== null : !hash(row.block_hash)) throw invalid();
  const received = money(row.received), spent = money(row.spent), delta = money(row.balance_delta, true);
  if (received - spent !== delta) throw invalid();
  return { ...result, block_hash: row.block_hash, received: received.toString(), spent: spent.toString(), balance_delta: delta.toString() };
}
export function syncUtxoRow(row) {
  const result = location(row);
  if (!Number.isInteger(row.vout) || row.vout < 0 || row.vout > 0xffffffff || typeof row.coinbase !== 'boolean' || typeof row.mature !== 'boolean' ||
      (row.pending_spent_by !== null && !hash(row.pending_spent_by)) || (row.status === 'pending' && row.coinbase)) throw invalid();
  return { ...result, vout: row.vout, amount: money(row.amount).toString(), coinbase: row.coinbase, mature: row.mature, pending_spent_by: row.pending_spent_by };
}
export function addressSetKey(addresses) { return [...new Set(addresses)].sort().join('\n'); }
function response(value, network) {
  if (!plain(value) || value.unit !== 'connects' || !Array.isArray(value.changes) || value.changes.length > 500 ||
      typeof value.has_more !== 'boolean' || typeof value.next_cursor !== 'string' || !CURSOR.test(value.next_cursor) ||
      !Number.isSafeInteger(value.through_sequence) || value.through_sequence < 0 ||
      !Number.isSafeInteger(value.journal_epoch) || value.journal_epoch < 0) throw invalid();
  validateTip(value.tip, network);
  return value;
}
export async function beginAddressSync({ rpc, network, addresses, check }) {
  const sorted = [...new Set(addresses)].sort();
  if (!sorted.length || sorted.length !== addresses.length) throw invalid();
  const state = { network, key: addressSetKey(sorted), batches: [], addresses: new Map(sorted.map(address => [address, { history: new Map(), utxos: new Map() }])), tip: null };
  for (let offset = 0; offset < sorted.length; offset += 100) {
    check(); const batch = sorted.slice(offset, offset + 100);
    const result = response(await rpc.request('getaddresschanges', { addresses: batch }), network); check();
    if (result.changes.length || result.has_more) throw invalid();
    state.batches.push({ addresses: batch, cursor: result.next_cursor, throughSequence: result.through_sequence, journalEpoch: result.journal_epoch, tip: result.tip }); state.tip = result.tip;
  }
  return state;
}
export function setAddressBaseline(state, address, { history, utxos }) {
  const target = state.addresses.get(address);
  if (!target || !Array.isArray(history) || !Array.isArray(utxos) || history.length > MAX_ROWS_PER_ADDRESS || utxos.length > MAX_ROWS_PER_ADDRESS) throw invalid();
  for (const raw of history) {
    const row = syncHistoryRow(raw);
    // A live baseline can contain a row twice while it changes from pending to confirmed.
    target.history.set(row.txid, row);
  }
  for (const raw of utxos) {
    const row = syncUtxoRow(raw); target.utxos.set(`${row.txid}:${row.vout}`, row);
  }
  checkSize(state);
}
function checkSize(state) {
  let total = 0;
  for (const value of state.addresses.values()) {
    if (value.history.size > MAX_ROWS_PER_ADDRESS || value.utxos.size > MAX_ROWS_PER_ADDRESS) throw new Error('Address synchronization exceeds this release’s local resource limit.');
    total += value.history.size + value.utxos.size;
  }
  if (total > MAX_TOTAL_ROWS) throw new Error('Address synchronization exceeds this release’s local resource limit.');
}
function cloneState(state) {
  return { ...state, batches: state.batches.map(batch => ({ ...batch })),
    addresses: new Map([...state.addresses].map(([address, rows]) => [address, { history: new Map(rows.history), utxos: new Map(rows.utxos) }])) };
}
/** Apply into a private candidate. No published cache/cursor changes before every page validates. */
export async function updateAddressSync(state, { rpc, check }) {
  const next = cloneState(state); let eventCount = 0;
  let pending = next.batches;
  for (let round = 0; round < 3; round++) {
   for (const batch of pending) {
    const allowed = new Set(batch.addresses), cursors = new Set(); let previousSequence = batch.throughSequence, frozenTip = null, frozenSequence;
    for (let page = 0; ; page++) {
      check();
      if (page >= 1000 || cursors.has(batch.cursor)) throw invalid();
      cursors.add(batch.cursor);
      const result = response(await rpc.request('getaddresschanges', { addresses: batch.addresses, cursor: batch.cursor }), state.network); check();
      if (result.journal_epoch !== batch.journalEpoch) throw addressSyncStale();
      if (frozenTip && (result.tip.hash !== frozenTip.hash || result.through_sequence !== frozenSequence)) throw addressSyncStale();
      if (result.through_sequence < batch.throughSequence) throw invalid();
      frozenTip = result.tip; frozenSequence = result.through_sequence;
      if ((result.has_more && !result.changes.length) || (result.changes.length && result.next_cursor === batch.cursor)) throw invalid();
      for (const event of result.changes) {
        if (!plain(event) || !Number.isSafeInteger(event.sequence) || event.sequence < 0 || event.sequence <= previousSequence || event.sequence > result.through_sequence || !allowed.has(event.address) ||
            !['history', 'utxo'].includes(event.kind) || !['upsert', 'remove'].includes(event.action) || !hash(event.txid)) throw invalid();
        previousSequence = event.sequence;
        if (++eventCount > 100000) throw new Error('Address synchronization exceeds this release’s local resource limit.');
        const target = next.addresses.get(event.address)[event.kind === 'history' ? 'history' : 'utxos'];
        if (event.kind === 'utxo' && (!Number.isInteger(event.vout) || event.vout < 0 || event.vout > 0xffffffff)) throw invalid();
        const key = event.kind === 'history' ? event.txid : `${event.txid}:${event.vout}`;
        if (event.action === 'remove') {
          if (event.item !== undefined) throw invalid();
          target.delete(key);
        } else {
          const item = event.kind === 'history' ? syncHistoryRow(event.item) : syncUtxoRow(event.item);
          if (item.txid !== event.txid || (event.kind === 'utxo' && item.vout !== event.vout)) throw invalid();
          target.set(key, item);
        }
      }
      batch.cursor = result.next_cursor;
      if (!result.has_more) { batch.tip = result.tip; batch.throughSequence = result.through_sequence; next.tip = result.tip; break; }
    }
   }
   // Tip equality alone is insufficient: a mempool transfer between two
   // address batches must not count both its old inputs and its new outputs.
   const latest = pending.at(-1);
   pending = next.batches.filter(batch => batch.tip.hash !== latest.tip.hash || batch.throughSequence !== latest.throughSequence || batch.journalEpoch !== latest.journalEpoch);
   checkSize(next); check();
   if (!pending.length) return next;
  }
  // Ordinary chain/mempool advancement is not an invalid cursor. Keep this
  // unpublished candidate for a delta-only retry instead of another baseline.
  throw Object.assign(new Error('Address synchronization is catching up with a changing chain or mempool; retry shortly.'), { code: 'ADDRESS_SYNC_BUSY', candidate: next });
}
/** Derive balances from all UTXOs, retaining confirmed inputs spent only by mempool transactions. */
export function addressSyncSnapshot(state, accounts) {
  const totals = { confirmed: 0n, available: 0n, pending: 0n, immature: 0n }, history = new Map(), utxos = [];
  let highestReceive = -1, highestChange = -1;
  for (const account of accounts) {
    const value = state.addresses.get(account.address); if (!value) throw invalid();
    const confirmations = row => {
      if (row.status === 'pending') return 0;
      if (row.block_height > state.tip.height) throw addressSyncStale();
      return state.tip.height - row.block_height + 1;
    };
    if (value.history.size) {
      if (account.change) highestChange = Math.max(highestChange, account.index); else highestReceive = Math.max(highestReceive, account.index);
    }
    for (const row of value.history.values()) {
      const count = confirmations(row), existing = history.get(row.txid);
      if (existing && (existing.status !== row.status || existing.block_height !== row.block_height || existing.block_hash !== row.block_hash)) throw addressSyncStale();
      history.set(row.txid, { ...row, confirmations: count, net: (existing?.net ?? 0n) + money(row.balance_delta, true) });
    }
    for (const row of value.utxos.values()) {
      const count = confirmations(row), mature = !row.coinbase || count >= 100, amount = money(row.amount);
      utxos.push({ ...row, confirmations: count, mature, account });
      if (row.status === 'confirmed') {
        totals.confirmed += amount;
        if (!mature) totals.immature += amount;
        if (!row.pending_spent_by && mature) totals.available += amount;
        if (row.pending_spent_by) totals.pending -= amount;
      } else if (!row.pending_spent_by) totals.pending += amount;
    }
  }
  return { totals, history, utxos, highestReceive, highestChange };
}
