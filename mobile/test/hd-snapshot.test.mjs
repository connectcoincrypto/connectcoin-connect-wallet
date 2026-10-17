import test from 'node:test';
import assert from 'node:assert/strict';
import { HdWalletSession, hdSnapshot } from '../src/hd-session.mjs';
import { MAINNET_GENESIS } from '../src/model.mjs';
import { syncHistoryRow, syncUtxoRow } from '../src/hd-sync.mjs';

const hash = n => n.toString(16).padStart(64, '0');
const tip = { chain: 'main', genesis_hash: MAINNET_GENESIS, height: 200, hash: hash(200), mediantime: 1700000000 };
const LIMIT = 1000000000000000000n;
const history = (id, received, spent = '0', patch = {}) => syncHistoryRow({ txid: hash(id), status: 'confirmed',
  block_height: 100, block_hash: hash(100), confirmations: 101, received, spent,
  balance_delta: (BigInt(received) - BigInt(spent)).toString(), ...patch });
const utxo = (id, amount, patch = {}) => syncUtxoRow({ txid: hash(id), vout: 0, amount, status: 'confirmed',
  block_height: 100, confirmations: 101, coinbase: false, mature: true, pending_spent_by: null, ...patch });

// The aggregate receives descriptors already verified by nativeHdAccounts;
// synthetic identities here isolate arithmetic/ownership from address parsing.
function input(groups) {
  const accounts = groups.map((_, index) => ({ address: `verified-address-${index}` }));
  const addresses = new Map(accounts.map((account, index) => [account.address, {
    history: new Map((groups[index].history ?? []).map(row => [row.txid, Object.freeze(row)])),
    utxos: new Map((groups[index].utxos ?? []).map(row => [`${row.txid}:${row.vout}`, Object.freeze(row)])),
  }]));
  return { sync: { tip, addresses }, accounts, walletId: accounts[0].address };
}
const project = value => hdSnapshot(value.sync, value.accounts, value.walletId);

test('HD transaction accumulators preserve exact large integers, signed deltas and native address order', () => {
  const value = input([
    { history: [history(1, '9007199254740993', '1')] },
    { history: [history(1, '2', '9007199254740995')] },
    { history: [history(1, '7', '13')] },
  ]);
  const before = structuredClone(value.sync), result = project(value);
  assert.deepEqual(result.history, [{ ...history(1, '9007199254741002', '9007199254741009'),
    addresses: value.accounts.map(account => account.address) }]);
  assert.equal(result.history[0].balance_delta, '-7');
  assert.deepEqual(value.sync, before);
  result.history[0].addresses.push('not-an-input-address');
  result.history[0].received = '0';
  assert.deepEqual(value.sync, before);
  assert.equal(project(value).history[0].received, '9007199254741002');
});

test('HD aggregate monetary bounds retain both exact endpoints and reject sums beyond individual valid rows', () => {
  const half = (LIMIT / 2n).toString();
  for (const [received, spent] of [[half, '0'], ['0', half], [half, half]]) {
    const result = project(input([{ history: [history(1, received, spent)] }, { history: [history(1, received, spent)] }]));
    assert.equal(result.history[0].received, (2n * BigInt(received)).toString());
    assert.equal(result.history[0].spent, (2n * BigInt(spent)).toString());
    assert.equal(result.history[0].balance_delta, (2n * (BigInt(received) - BigInt(spent))).toString());
    const more = received === '0' ? history(1, '0', '1') : history(1, '1');
    assert.throws(() => project(input([{ history: [history(1, received, spent)] },
      { history: [history(1, received, spent)] }, { history: [more] }])));
  }
});

test('HD shared transactions still reject conflicting status, height, hash and future locations atomically', () => {
  const first = history(1, '3');
  for (const patch of [
    { status: 'pending', block_height: null, block_hash: null, confirmations: 0 },
    { block_height: 101, confirmations: 100 }, { block_hash: hash(101) },
  ]) {
    const value = input([{ history: [first] }, { history: [history(1, '4', '0', patch)] }]);
    const before = structuredClone(value.sync);
    assert.throws(() => project(value)); assert.deepEqual(value.sync, before);
  }
  assert.throws(() => project(input([{ history: [history(1, '1', '0', { block_height: 201, confirmations: 0 })] }])));
  const missing = input([{}]); missing.sync.addresses.clear(); assert.throws(() => project(missing));
});

test('HD history ordering remains pending first, descending height, then txid, with exact self-transfer output', () => {
  const pending = { status: 'pending', block_height: null, block_hash: null, confirmations: 0 };
  const value = input([
    { history: [history(6, '3'), history(8, '10', '0', pending), history(4, '0', '20'),
      history(5, '2', '0', { block_height: 150, block_hash: hash(150), confirmations: 51 })] },
    { history: [history(2, '1', '0', pending), history(4, '19')] },
  ]);
  const result = project(value);
  assert.deepEqual(result.history.map(row => row.txid), [2, 8, 5, 4, 6].map(hash));
  assert.deepEqual(result.history.find(row => row.txid === hash(4)), { ...history(4, '19', '20'),
    addresses: value.accounts.map(account => account.address) });
  assert.deepEqual(result.history.map(row => row.confirmations), [0, 0, 51, 101, 101]);
});

test('HD accumulator changes preserve UTXO maturity, spend markers, funding and duplicate-output checks', () => {
  const value = input([
    { utxos: [utxo(1, '11'), utxo(2, '7', { pending_spent_by: hash(10) }),
      utxo(3, '5', { coinbase: true, block_height: 102, confirmations: 99, mature: false })] },
    { utxos: [utxo(4, '3', { status: 'pending', block_height: null, confirmations: 0 }),
      utxo(5, '19', { status: 'pending', block_height: null, confirmations: 0, pending_spent_by: hash(10) })] },
  ]);
  const result = project(value);
  assert.deepEqual(result.balance, { address: value.walletId, tip, unit: 'connects', confirmed: '23', immature: '5',
    available_confirmed: '11', pending_received: '3', pending_spent: '7', pending_delta: '-4', total: '19' });
  assert.deepEqual(result.fundingAddresses, [value.accounts[0].address]);
  assert.throws(() => project(input([{ utxos: [utxo(1, '1')] }, { utxos: [utxo(1, '1')] }])));
  assert.throws(() => project(input([{ utxos: [utxo(1, '1', { coinbase: true, block_height: 200, confirmations: 1,
    mature: false, pending_spent_by: hash(10) })] }])));
  assert.throws(() => project(input([{ utxos: [utxo(1, LIMIT.toString())] }, { utxos: [utxo(2, '1')] }])));
});

test('a transaction spanning 10000 verified accounts accumulates every address once without mutating source rows', () => {
  const value = input(Array.from({ length: 10000 }, () => ({ history: [history(1, '2', '1')] })));
  const result = project(value);
  assert.equal(result.history.length, 1);
  assert.deepEqual(result.history[0], { ...history(1, '20000', '10000'), addresses: value.accounts.map(account => account.address) });
  assert.equal(value.sync.addresses.get(value.accounts[0].address).history.get(hash(1)).received, '2');
});

test('cached projection freezes only owned rows and lists, copying the still journal-owned tip', () => {
  const value = input([{ history: [history(1, '2')], utxos: [utxo(1, '2')] }, { history: [history(1, '3')] }]);
  value.sync.tip = { ...tip };
  const sourceTip = value.sync.tip, sourceRow = value.sync.addresses.get(value.walletId).history.get(hash(1));
  const session = new HdWalletSession({ query: async () => { throw new Error('No RPC expected'); } });
  const result = session.project(value.sync, value.accounts, value.walletId);
  assert.deepEqual(result, hdSnapshot(value.sync, value.accounts, value.walletId));
  assert.notEqual(result.balance.tip, sourceTip); assert.notEqual(result.history[0], sourceRow);
  for (const object of [result, result.balance, result.balance.tip, result.history, result.history[0],
    result.history[0].addresses, result.fundingAddresses]) assert.equal(Object.isFrozen(object), true);
  assert.equal(Object.isFrozen(sourceTip), false);
  assert.equal(session.project(value.sync, value.accounts, value.walletId), result);
  assert.throws(() => { result.history[0].addresses.push('foreign'); }, TypeError);
  assert.throws(() => { result.history[0].received = '999'; }, TypeError);
  assert.throws(() => { result.balance.tip.mediantime++; }, TypeError);
  sourceTip.mediantime++;
  assert.equal(result.balance.tip.mediantime, tip.mediantime);
});
