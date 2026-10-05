import test from 'node:test';
import assert from 'node:assert/strict';
import { WalletService } from '../src/core/wallet-service.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';
import { GENESIS } from '../src/core/config.mjs';
import { encryptVault, decryptVault } from '../src/core/vault.mjs';

const MAX_INDEX = 2 ** 31 - 1;
const MNEMONIC = `${'abandon '.repeat(11)}about`;
const PASSWORD = 'public-boundary-fixture-password';
const TIP = { chain: 'testnet4', height: 2000, hash: 'a'.repeat(64),
  mediantime: 1789500000, genesis_hash: GENESIS.testnet4 };
const TXID = 'b'.repeat(64);

function walletData(overrides = {}) {
  return { name: 'Address boundary fixture', mnemonic: MNEMONIC, network: 'testnet4', passphrase: '',
    receiveIndex: 0, changeIndex: 0, lastUsedReceive: -1, lastUsedChange: -1,
    needsRecovery: false, ...overrides };
}

// Exercise the actual wallet state transitions without starting timers, touching a
// profile, deriving thousands of private keys, or contacting a real RPC server.
function fixture(overrides = {}) {
  const service = Object.create(WalletService.prototype);
  const persisted = [], events = [], queries = [];
  Object.assign(service, {
    config: { network: 'testnet4', claims: { enabled: false } },
    session: { data: walletData(overrides), password: PASSWORD }, epoch: 1, closed: false,
    accounts: [], accountCache: new Map(), reserved: new Set(), tip: TIP,
    walletUpdateRevision: 0, walletReadRevision: 0, engine: { enabled: false },
    liveUpdates: { started: false, start() {}, updateAddresses() {} },
    emitState() {}, refresh: async () => {},
    persist: async () => { persisted.push(structuredClone(service.session.data)); events.push('persist'); },
    makeQR: async () => { service.qrDataUrl = `fixture-qr-${service.session.data.receiveIndex}`; },
    publicAccount(index, change) {
      assert.ok(Number.isSafeInteger(index) && index >= 0 && index <= MAX_INDEX);
      assert.ok(change === 0 || change === 1);
      return { index, change, address: `fixture${change}i${index}`, network: 'testnet4' };
    },
    getState() {
      return { wallet: { address: service.publicAccount(service.session.data.receiveIndex, 0).address } };
    },
    ensureNetwork: async () => TIP,
    rpc: { request: async method => { throw new Error(`Unexpected fixture RPC: ${method}`); } },
    page: async (method, address, options = {}) => {
      const match = /^fixture([01])i(\d+)$/.exec(address);
      assert.ok(match);
      queries.push({ method, change: Number(match[1]), index: Number(match[2]) });
      options.onTip?.(TIP);
      return [];
    },
  });
  return { service, persisted, events, queries };
}

function preparePayment(service, index, change = '1') {
  service.preview = { previewId: 'public-boundary-review', epoch: service.epoch,
    expires: Date.now() + 60000, change, changeIndex: index, txid: TXID,
    hex: 'public-fixture-not-a-real-transaction', selected: [{ txid: 'c'.repeat(64), vout: 0 }] };
  return { previewId: service.preview.previewId };
}

test('opening a wallet beyond index 999 keeps both chains and the full recovery lookahead', async () => {
  const { service } = fixture();
  await service.openSession(walletData({ receiveIndex: 1000, changeIndex: 1025,
    lastUsedReceive: 999, lastUsedChange: 1024, scanLookahead: true }), PASSWORD);
  assert.equal(service.session.data.receiveIndex, 1000);
  assert.equal(service.session.data.changeIndex, 1025);
  assert.equal(service.accounts.filter(account => account.change === 0).at(-1).index, 1019);
  assert.equal(service.accounts.filter(account => account.change === 1).at(-1).index, 1044);
  assert.equal(service.getState().wallet.address, 'fixture0i1000');
});

test('encrypted backups preserve high receive and change indices in the existing wallet format', async () => {
  const original = walletData({ receiveIndex: 1000, changeIndex: 1025,
    lastUsedReceive: 999, lastUsedChange: 1024, scanLookahead: true });
  const envelope = await encryptVault(original, PASSWORD);
  assert.equal(envelope.format, 'connectcoin-connect-wallet');
  assert.equal(envelope.version, 1);
  const recovered = await decryptVault(envelope, PASSWORD);
  assert.deepEqual(recovered, original);
  const { service } = fixture();
  await service.openSession(recovered, PASSWORD);
  assert.equal(service.getState().wallet.address, 'fixture0i1000');
  assert.ok(service.accounts.some(account => account.address === 'fixture1i1025'));
});

test('receive addresses cross index 999 and retain the 20-unused-address gap', async () => {
  const { service, persisted } = fixture({ receiveIndex: 999, lastUsedReceive: 999 });
  for (let index = 1000; index <= 1019; index++) {
    assert.equal((await service.newAddress()).address, `fixture0i${index}`);
    assert.equal(persisted.at(-1).receiveIndex, index);
  }
  await assert.rejects(service.newAddress(), /20-address gap|existing receive addresses/);
  assert.equal(service.session.data.receiveIndex, 1019);
  assert.equal(persisted.length, 20);
  service.session.data.lastUsedReceive = 1005;
  for (let index = 1020; index <= 1025; index++) await service.newAddress();
  await assert.rejects(service.newAddress(), /20-address gap|existing receive addresses/);
  assert.equal(service.session.data.receiveIndex, 1025);
});

for (const index of [999, 1024]) test(`payment change advances beyond ${index} and persists before broadcast`, async () => {
  const { service, persisted, events } = fixture({ changeIndex: index, lastUsedChange: index });
  service.rpc.request = async (method, params) => {
    assert.equal(method, 'sendrawtransaction');
    assert.equal(params.transaction_hex, 'public-fixture-not-a-real-transaction');
    assert.equal(persisted.at(-1).changeIndex, index + 1);
    events.push('broadcast');
    return { txid: TXID };
  };
  const result = await service.confirmSend(preparePayment(service, index));
  assert.equal(result.status, 'submitted');
  assert.equal(service.session.data.changeIndex, index + 1);
  assert.deepEqual(events, ['persist', 'broadcast']);
  assert.ok(service.reserved.has(`${'c'.repeat(64)}:0`));
});

test('change allocation beyond index 999 still rejects an exhausted unused-address gap', async () => {
  const { service, persisted } = fixture({ changeIndex: 1019, lastUsedChange: 999 });
  await assert.rejects(service.confirmSend(preparePayment(service, 1019)), /unused change addresses/);
  assert.equal(service.session.data.changeIndex, 1019);
  assert.equal(persisted.length, 0);
  assert.equal(service.reserved.size, 0);
});

test('a receipt at index 1025 updates balance and extends watched receive addresses', async () => {
  const { service, persisted } = fixture({ receiveIndex: 1006, lastUsedReceive: 1005, scanLookahead: true });
  await service.buildAccounts();
  assert.ok(service.accounts.some(account => account.address === 'fixture0i1025'));
  const row = { txid: TXID, status: 'confirmed', block_height: 1999,
    confirmations: 2, balance_delta: '10000000000' };
  service.page = async (method, address, options = {}) => {
    options.onTip?.(TIP);
    return method === 'getaddresshistory' && address === 'fixture0i1025' ? [row] : [];
  };
  service.rpc.request = async (method, { address }) => {
    if (method === 'getaddresschanges') throw Object.assign(new Error('Legacy fixture'), { code: -32601 });
    assert.equal(method, 'getaddressbalance');
    const amount = address === 'fixture0i1025' ? '10000000000' : '0';
    return { tip: TIP, address, unit: 'connects', confirmed: amount,
      available_confirmed: amount, pending_delta: '0', immature: '0' };
  };
  await service.refreshInternal(service.epoch);
  assert.equal(service.balance.confirmed, '1');
  assert.equal(service.balance.available, '1');
  assert.equal(service.history[0].direction, 'received');
  assert.equal(persisted.at(-1).lastUsedReceive, 1025);
  assert.ok(service.accounts.some(account => account.address === 'fixture0i1045'));
});

for (const lastUsed of [[980, -1], [1005, 1002]]) test(`recovery completes both gaps after used indices ${lastUsed.join('/')}`, async () => {
  const { service, persisted, queries } = fixture({ needsRecovery: true });
  service.page = async (method, address, options = {}) => {
    assert.equal(method, 'getaddresshistory');
    const [, chain, child] = /^fixture([01])i(\d+)$/.exec(address);
    const change = Number(chain), index = Number(child);
    queries.push({ change, index }); options.onTip?.(TIP);
    // Earlier used addresses bridge the gap; one isolated high address would
    // correctly remain undiscovered after 20 earlier unused addresses.
    const used = index <= lastUsed[change] && (index % 20 === 0 || index === lastUsed[change]);
    return used ? [{ txid: TXID }] : [];
  };
  await service.recoverAddresses(service.epoch);
  assert.equal(service.session.data.needsRecovery, false);
  assert.equal(service.session.data.scanLookahead, true);
  assert.equal(persisted.length, 1);
  for (const change of [0, 1]) {
    const field = change ? 'changeIndex' : 'receiveIndex';
    const usedField = change ? 'lastUsedChange' : 'lastUsedReceive';
    assert.equal(service.session.data[field], lastUsed[change] + 1);
    assert.equal(service.session.data[usedField], lastUsed[change]);
    const scanned = queries.filter(query => query.change === change);
    assert.equal(scanned.length, lastUsed[change] + 21);
    assert.equal(scanned.at(-1).index, lastUsed[change] + 20);
    assert.equal(service.accounts.filter(account => account.change === change).at(-1).index, lastUsed[change] + 20);
  }
});

test('an empty recovery still stops after exactly 20 unused addresses on each chain', async () => {
  const { service, queries } = fixture({ needsRecovery: true });
  await service.recoverAddresses(service.epoch);
  assert.equal(queries.length, 40);
  for (const change of [0, 1]) assert.deepEqual(queries.filter(query => query.change === change).map(query => query.index),
    Array.from({ length: 20 }, (_, index) => index));
});

test('opening rejects malformed and hardened-range issued indices before building any accounts', async () => {
  for (const field of ['receiveIndex', 'changeIndex']) {
    for (const value of [-1, 0.5, '1000', NaN, Infinity, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      const { service } = fixture();
      service.session = null;
      let built = false;
      service.buildAccounts = () => { built = true; };
      await assert.rejects(service.openSession(walletData({ [field]: value }), PASSWORD), /index/i);
      assert.equal(built, false, `${field}=${String(value)} must fail before account enumeration`);
      assert.equal(service.session, null);
    }
  }
});

test('opening rejects malformed discovery indices before building any accounts', async () => {
  for (const field of ['lastUsedReceive', 'lastUsedChange']) {
    for (const value of [-2, 0.5, '1000', null, NaN, Infinity, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      const { service } = fixture();
      service.session = null;
      let built = false;
      service.buildAccounts = () => { built = true; };
      await assert.rejects(service.openSession(walletData({ [field]: value }), PASSWORD), /index/i);
      assert.equal(built, false, `${field}=${String(value)} must fail before account enumeration`);
      assert.equal(service.session, null);
    }
  }
});

test('older wallet data may omit last-used indices and defaults to an unused gap', async () => {
  const { service } = fixture();
  const data = walletData({ scanLookahead: true });
  delete data.lastUsedReceive;
  delete data.lastUsedChange;
  await service.openSession(data, PASSWORD);
  for (const change of [0, 1]) {
    assert.equal(service.accounts.filter(account => account.change === change).length, 20);
  }
});

test('a large account build yields for locking and cannot publish after the session changes', async () => {
  const { service } = fixture({ receiveIndex: 1025, changeIndex: 1025 });
  const publicAccount = service.publicAccount.bind(service);
  let derived = 0, derivedAtLock;
  service.publicAccount = (...args) => { derived++; return publicAccount(...args); };
  const pending = service.buildAccounts();
  const cancelled = assert.rejects(pending, /locked|changed|cancelled/i);
  await new Promise(resolve => setImmediate(() => {
    derivedAtLock = derived;
    service.epoch++;
    service.session = null;
    service.accounts = [];
    resolve();
  }));
  await cancelled;
  assert.ok(derivedAtLock > 0 && derivedAtLock < 2052,
    'Locking must get an event-loop turn before the account build finishes');
  assert.equal(derived, derivedAtLock, 'No more addresses may be derived after locking');
  assert.deepEqual(service.accounts, []);
});

test('shared large builds include ranges extended while yielding without duplicate derivation', async () => {
  const { service } = fixture({ receiveIndex: 1000 });
  const publicAccount = service.publicAccount.bind(service), calls = new Map();
  service.publicAccount = (index, change) => {
    const key = `${change}:${index}`;
    calls.set(key, (calls.get(key) ?? 0) + 1);
    return publicAccount(index, change);
  };
  let publications = 0, shared;
  service.liveUpdates.updateAddresses = () => { publications++; };
  const first = service.buildAccounts();
  const activeBuild = service.accountBuild;
  await new Promise(resolve => setImmediate(() => {
    service.session.data.receiveIndex = 1025;
    service.session.data.changeIndex = 1005;
    shared = service.buildAccounts();
    assert.equal(service.accountBuild, activeBuild);
    resolve();
  }));
  await Promise.all([first, shared]);
  assert.equal(service.accounts.filter(account => account.change === 0).at(-1).index, 1025);
  assert.equal(service.accounts.filter(account => account.change === 1).at(-1).index, 1005);
  assert.equal(service.accounts.length, 1026 + 1006);
  assert.equal(calls.size, service.accounts.length);
  assert.ok([...calls.values()].every(count => count === 1));
  assert.equal(publications, 1, 'Shared callers must publish one complete address list');
});

test('a same-turn range extension is rebuilt when the shared small build already completed', async () => {
  const { service } = fixture();
  const first = service.buildAccounts();
  service.session.data.receiveIndex = 2;
  const second = service.buildAccounts();
  await Promise.all([first, second]);
  assert.deepEqual(service.accounts.filter(account => account.change === 0).map(account => account.index), [0, 1, 2]);
  assert.equal(service.accounts.filter(account => account.change === 1).length, 1);
});

test('a cancelled old build neither publishes over nor clears a newer epoch build', async () => {
  const { service } = fixture({ receiveIndex: 1025, changeIndex: 1025 });
  const publicAccount = service.publicAccount.bind(service);
  service.publicAccount = (...args) => ({ ...publicAccount(...args), fixtureEpoch: service.epoch });
  const old = service.buildAccounts();
  const cancelled = assert.rejects(old, /locked|changed|cancelled/i);
  let next, nextEpoch;
  await new Promise(resolve => setImmediate(() => {
    service.epoch++;
    nextEpoch = service.epoch;
    service.session = { data: walletData({ receiveIndex: 1005, changeIndex: 1002 }), password: PASSWORD };
    service.accounts = [];
    next = service.buildAccounts();
    resolve();
  }));
  await cancelled;
  assert.equal(service.accountBuild?.epoch, nextEpoch, 'Old cleanup must retain the newer pending build');
  await next;
  assert.equal(service.accounts.length, 1006 + 1003);
  assert.ok(service.accounts.every(account => account.fixtureEpoch === nextEpoch));
  assert.equal(service.accountBuild, null);
});

test('native final non-hardened index is valid without permitting receive or change rollover', async () => {
  const { service, persisted } = fixture();
  // Validate the upper boundary without enumerating billions of child addresses.
  service.buildAccounts = () => {};
  await service.openSession(walletData({ receiveIndex: MAX_INDEX, changeIndex: MAX_INDEX,
    lastUsedReceive: MAX_INDEX, lastUsedChange: MAX_INDEX }), PASSWORD);
  assert.equal(service.session.data.receiveIndex, MAX_INDEX);
  await assert.rejects(service.newAddress(), /index|address|derivation/i);
  await assert.rejects(service.confirmSend(preparePayment(service, MAX_INDEX)), /index|address|derivation/i);
  assert.equal(service.session.data.receiveIndex, MAX_INDEX);
  assert.equal(service.session.data.changeIndex, MAX_INDEX);
  assert.equal(persisted.length, 0);

  const account = deriveAccount(MNEMONIC, { index: MAX_INDEX });
  try { assert.ok(account.path.endsWith(`/0/${MAX_INDEX}`)); }
  finally { account.privateKey.fill(0); }
  for (const index of [-1, 0.5, '1000', NaN, Infinity, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => deriveAccount(MNEMONIC, { index }), /derivation index/);
  }
});
