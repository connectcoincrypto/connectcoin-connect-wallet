import test from 'node:test';
import assert from 'node:assert/strict';
import { bech32m } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { MAINNET_GENESIS } from '../src/model.mjs';
import { createDisplayCache, readDisplayCache } from '../src/hd-display-cache.mjs';
import { availableSendAmount } from '../src/send-request.mjs';

const address = bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.toBytes(true).slice(1))]);
const accounts = [{ address }], tip = { chain: 'main', genesis_hash: MAINNET_GENESIS, height: 200, hash: 'a'.repeat(64), mediantime: 1700000000 };
const balance = { address, tip, unit: 'connects', confirmed: '10', immature: '0', available_confirmed: '10',
  pending_received: '0', pending_spent: '0', pending_delta: '0', total: '10' };
const row = { txid: 'b'.repeat(64), status: 'confirmed', block_height: 100, block_hash: 'c'.repeat(64), confirmations: 101,
  received: '10', spent: '0', balance_delta: '10', addresses: [address] };
const state = () => ({ address, balance, history: [row], updatedAt: Date.now(), hdComplete: true });
const options = { walletId: address, accounts };

test('display snapshot stores a bounded public view, never RPC cursors, outputs or arbitrary state fields', () => {
  const value = createDisplayCache({ ...state(), secret: 'MUST NOT BE COPIED', cursor: 'rpc.cursor', utxos: [1] }, accounts);
  assert.deepEqual(Object.keys(value).sort(), ['accountKey', 'balance', 'history', 'network', 'updatedAt', 'version', 'walletId']);
  assert.ok(!JSON.stringify(value).includes('MUST NOT BE COPIED'));
  const restored = readDisplayCache(value, options);
  assert.equal(restored.balance.total, '10'); assert.equal(restored.history.length, 1);
  assert.equal(availableSendAmount({ ...state(), ...restored, cached: true, stale: true }), null);
});

test('cache rejects foreign account sets, network, future timestamps, malformed money and inconsistent history', () => {
  const original = createDisplayCache(state(), accounts);
  const cases = [
    value => { value.network = 'testnet4'; }, value => { value.walletId = 'wrong'; }, value => { value.accountKey = 'wrong'; },
    value => { value.updatedAt = Date.now() + 600000; }, value => { value.balance.total = '11'; },
    value => { value.balance.tip.genesis_hash = 'b'.repeat(64); }, value => { value.history[0].addresses = ['foreign']; },
    value => { value.history[0].confirmations = 500; }, value => { value.history[0].balance_delta = '11'; },
    value => { value.history = Array(201).fill(value.history[0]); },
  ];
  for (const change of cases) {
    const value = structuredClone(original); change(value);
    assert.equal(readDisplayCache(value, options), null);
  }
  assert.equal(readDisplayCache(null, options), null);
  assert.equal(readDisplayCache({ ...original, extra: 'x'.repeat(2 * 1024 * 1024) }, options), null);
});

test('failed, recovery-incomplete and already cached views are never persisted as fresh', () => {
  for (const patch of [{ stale: true }, { cached: true }, { partial: true }, { hdComplete: false }, { updatedAt: null }, { balance: null }]) {
    assert.equal(createDisplayCache({ ...state(), ...patch }, accounts), null);
  }
});
