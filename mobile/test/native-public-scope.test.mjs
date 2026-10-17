import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import { MAINNET_GENESIS } from '../src/model.mjs';
import { NativePublicScope, hasVerifiedWalletSnapshot } from '../src/native-public-scope.mjs';

const accounts = [1, 2, 3].map((n, index) => ({
  address: bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.multiply(BigInt(n)).toBytes(true).slice(1))]),
  network: 'main', index, change: 0, path: `m/44'/0'/0'/0/${index}`,
}));
const endpoint = 'connectcoin4.com:48190';
const info = () => ({ exists: true, locked: false, accountScope: 'hd-wallet', walletId: accounts[0].address,
  account: { ...accounts[0] }, accounts: structuredClone(accounts.slice(0, 2)), hd: { complete: true, recovering: false } });
const tip = { chain: 'main', genesis_hash: MAINNET_GENESIS, hash: 'a'.repeat(64), height: 100, mediantime: 1234567890 };
const session = () => ({ confirmationsStale: false, state: { address: accounts[0].address, balance: { address: accounts[0].address, tip: { ...tip } },
  tip: { ...tip }, updatedAt: 1000, busy: false, stale: false, cached: false, partial: false, historyStale: false, error: '',
  hdComplete: true, addressCount: 2, verifiedAddresses: accounts.slice(0, 2).map(account => account.address) } });
const rejectsInactive = callback => assert.throws(callback, { code: 'RPC_INACTIVE' });

test('validated scope reuses its private membership for stable polls, queries and locking', () => {
  const cache = new NativePublicScope(), source = info(), scope = cache.adopt(source, endpoint);
  for (let iteration = 0; iteration < 100; iteration++) {
    assert.equal(cache.adopt({ ...structuredClone(source), locked: iteration % 2 === 0 }, endpoint), scope);
    for (const account of source.accounts) assert.equal(cache.authorize('getaddresshistory', { address: account.address }), scope);
    assert.equal(cache.authorize('getaddresschanges', { addresses: source.accounts.map(account => account.address) }), scope);
    assert.equal(cache.authorize('getchaintip', {}), scope);
  }
  assert.ok(Object.isFrozen(scope));
  assert.equal(Object.values(scope).some(value => value instanceof Set), false);
  rejectsInactive(() => cache.authorize('getaddressbalance', { address: accounts[2].address }));
  for (const addresses of [null, [], [accounts[0].address, accounts[2].address]]) {
    rejectsInactive(() => cache.authorize('getaddresschanges', { addresses }));
  }
});

test('invalid descriptors revoke authorization before error and the same old valid key must rebuild', () => {
  for (const invalid of [null, { ...info(), account: { address: 'not-an-address' } },
    { ...info(), accounts: [accounts[0], accounts[0]] }, { ...info(), walletId: accounts[1].address },
    { ...info(), accounts: [{ ...accounts[0], path: 'wrong' }, accounts[1]] }]) {
    const cache = new NativePublicScope(), before = cache.adopt(info(), endpoint);
    assert.throws(() => cache.adopt(invalid, endpoint));
    rejectsInactive(() => cache.authorize('getchaintip', {}));
    assert.throws(() => cache.assertCurrent(before), { code: 'RPC_CANCELLED' });
    const restored = cache.adopt(info(), endpoint);
    assert.notEqual(restored, before);
    assert.equal(cache.authorize('getaddressbalance', { address: accounts[0].address }), restored);
  }
});

test('scope expansion, shrink, replacement, endpoint and removal fence old responses', () => {
  const cache = new NativePublicScope(); let before = cache.adopt(info(), endpoint);
  const expanded = { ...info(), accounts: structuredClone(accounts) };
  for (const [source, server] of [[expanded, endpoint], [info(), endpoint],
    [{ exists: true, accountScope: 'first-receive-address', account: accounts[2] }, endpoint],
    [info(), 'other.example:1234'], [{ exists: false, account: null }, endpoint]]) {
    const next = cache.adopt(source, server);
    assert.notEqual(next, before);
    assert.throws(() => cache.assertCurrent(before), { code: 'RPC_CANCELLED' });
    before = next;
  }
  rejectsInactive(() => cache.authorize('getchaintip', {}));
  cache.clear();
  assert.equal(cache.isCurrent(before), false);
  rejectsInactive(() => cache.authorize('getaddressbalance', { address: accounts[0].address }));
});

test('only complete current verified snapshots suppress the artificial startup retry', () => {
  const scope = new NativePublicScope().adopt(info(), endpoint);
  assert.equal(hasVerifiedWalletSnapshot(session(), scope), true);
  for (const patch of [{ cached: true }, { partial: true }, { stale: true }, { busy: true }, { historyStale: true },
    { error: 'Could not verify' }, { updatedAt: null }, { updatedAt: 0 }, { balance: null }, { tip: null },
    { address: accounts[1].address }, { hdComplete: false }, { addressCount: 1 }, { verifiedAddresses: [] },
    { verifiedAddresses: [accounts[0].address, accounts[0].address] },
    { verifiedAddresses: [accounts[0].address, accounts[2].address] }]) {
    const candidate = session(); Object.assign(candidate.state, patch);
    assert.equal(hasVerifiedWalletSnapshot(candidate, scope), false, JSON.stringify(patch));
  }
  const candidate = session(); candidate.confirmationsStale = true;
  assert.equal(hasVerifiedWalletSnapshot(candidate, scope), false);
  for (const key of ['chain', 'genesis_hash', 'hash', 'height', 'mediantime']) {
    const candidate = session(); candidate.state.tip[key] = typeof tip[key] === 'string' ? 'changed' : tip[key] + 1;
    assert.equal(hasVerifiedWalletSnapshot(candidate, scope), false, key);
  }
  const missing = session(); delete missing.state.balance.tip.mediantime; delete missing.state.tip.mediantime;
  assert.equal(hasVerifiedWalletSnapshot(missing, scope), false);
});

test('legacy complete snapshot is sufficient but a balance-only repair cannot masquerade as history verification', () => {
  const scope = new NativePublicScope().adopt({ exists: true, accountScope: 'first-receive-address', account: accounts[0] }, endpoint);
  const candidate = session();
  delete candidate.state.hdComplete; delete candidate.state.addressCount; delete candidate.state.verifiedAddresses;
  assert.equal(hasVerifiedWalletSnapshot(candidate, scope), true);
  candidate.state.tip = null;
  assert.equal(hasVerifiedWalletSnapshot(candidate, scope), false);
  candidate.state.tip = { ...tip, hash: 'b'.repeat(64) };
  assert.equal(hasVerifiedWalletSnapshot(candidate, scope), false);
});
