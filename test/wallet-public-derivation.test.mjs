import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WalletService } from '../src/core/wallet-service.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';
import { validateConfig } from '../src/core/config.mjs';

// Published BIP39 examples, never user wallet material. No profile is opened,
// encrypted vault written, RPC connection made, or claims helper started.
const PHRASE = `${'abandon '.repeat(11)}about`;
const OTHER_PHRASE = `${'legal winner thank year wave sausage worth useful legal winner thank'} yellow`;
const PUBLIC_PASSWORD = 'public-derivation-fixture-not-a-secret';
const PUBLIC_FIELDS = ['address', 'change', 'index', 'network', 'path', 'publicKey'];

function walletData(network, overrides = {}) {
  return { name: 'Public derivation fixture', mnemonic: PHRASE, passphrase: '', network,
    receiveIndex: 1, changeIndex: 0, lastUsedReceive: 0, lastUsedChange: -1,
    needsRecovery: false, scanLookahead: true, ...overrides };
}

function oldPublicAccount(data, index, change, network = data.network) {
  const account = deriveAccount(data.mnemonic, { network, passphrase: data.passphrase, index, change });
  try {
    const { privateKey, ...publicData } = account;
    return publicData;
  } finally { account.privateKey.fill(0); }
}

function fixture(t, network = 'testnet4', overrides = {}) {
  class NoNetworkClient extends EventEmitter {
    async connect() { assert.fail('Public derivation must not connect to RPC'); }
    async request() { assert.fail('Public derivation must not issue RPC requests'); }
    close() {}
  }
  const service = new WalletService({
    directory: join(tmpdir(), 'connectwallet-public-derivation-no-io'), network,
    clientFactory: () => new NoNetworkClient(), proofRunner: async () => assert.fail('Claims must stay disabled'),
  });
  service.config = validateConfig({}, { network });
  service.session = { data: walletData(network, overrides), password: PUBLIC_PASSWORD };
  service.epoch = 1;
  service.emitState = () => {};
  service.makeQR = async () => {};
  service.refresh = async () => {};
  service.persist = async () => assert.fail('This fixture must not write a vault');
  const connectClient = service.connectClient.bind(service);
  service.connectClient = () => {
    connectClient();
    service.liveUpdates.start = () => {};
    service.liveUpdates.updateAddresses = () => {};
  };
  service.connectClient();
  service.createEngine();
  t.after(async () => { if (!service.closed) await service.close(); });
  return service;
}

function assertPublicAccount(account) {
  assert.deepEqual(Reflect.ownKeys(account).sort(), PUBLIC_FIELDS);
  assert.match(account.publicKey, /^[0-9a-f]{64}$/);
  for (const field of ['privateKey', 'privateExtendedKey', 'seed', 'mnemonic', 'passphrase', 'password', 'chainCode']) {
    assert.equal(Object.hasOwn(account, field), false, `Cached public account must not retain ${field}`);
  }
}

for (const network of ['main', 'testnet4']) {
  test(`${network}: publicAccount lazily reuses one scoped public deriver and cached public objects`, t => {
    const service = fixture(t, network);
    assert.equal(service.accountDerivation?.deriver, undefined);
    const first = service.publicAccount(0, 0), context = service.accountDerivation;
    assert.ok(context.deriver);
    assert.equal(context.epoch, service.epoch);
    assert.equal(context.session, service.session);
    assert.equal(context.network, network);
    assertPublicAccount(first);
    assert.deepEqual(first, oldPublicAccount(service.session.data, 0, 0));
    assert.equal(service.publicAccount(0, 0), first);
    for (const [index, change] of [[1, 0], [19, 0], [0, 1], [19, 1], [1025, 1]]) {
      const account = service.publicAccount(index, change);
      assertPublicAccount(account);
      assert.deepEqual(account, oldPublicAccount(service.session.data, index, change));
      assert.equal(service.publicAccount(index, change), account);
      assert.equal(service.accountDerivation, context);
    }
    assert.equal(service.accountCache.size, 6);
  });

  test(`${network}: 41-address lookahead build exactly matches the existing private derivation format`, async t => {
    const service = fixture(t, network);
    await service.buildAccounts();
    assert.equal(service.accounts.length, 41);
    const expected = [];
    for (const change of [0, 1]) for (let index = 0; index <= (change ? 19 : 20); index++) {
      expected.push(oldPublicAccount(service.session.data, index, change));
    }
    assert.deepEqual(service.accounts, expected);
    for (const account of service.accounts) {
      assertPublicAccount(account);
      assert.equal(service.publicAccount(account.index, account.change), account);
    }
    const context = service.accountDerivation, cached = [...service.accounts];
    await service.buildAccounts();
    assert.equal(service.accountDerivation, context);
    assert.equal(service.accountCache.size, 41);
    service.accounts.forEach((account, index) => assert.equal(account, cached[index]));
  });
}

test('invalid public derivation indices fail before creating a deriver or populating the cache', t => {
  const service = fixture(t);
  for (const [index, change] of [[-1, 0], [0.5, 0], ['1', 0], [NaN, 0], [Infinity, 0], [2 ** 31, 0], [0, -1], [0, 2], [0, '0']]) {
    assert.throws(() => service.publicAccount(index, change), /index|deriv/i);
    assert.equal(service.accountDerivation?.deriver, undefined);
    assert.equal(service.accountCache.size, 0);
  }
});

for (const reason of ['session identity', 'epoch', 'network']) {
  test(`a ${reason} mismatch invalidates the old context before an existing cache hit`, t => {
    const service = fixture(t, 'main');
    const before = service.publicAccount(0, 0);
    service.publicAccount(9, 1);
    const oldContext = service.accountDerivation;
    if (reason === 'session identity') {
      service.session = { data: walletData('main', { mnemonic: OTHER_PHRASE }), password: PUBLIC_PASSWORD };
    } else if (reason === 'epoch') {
      service.epoch++;
    } else {
      service.config = validateConfig({}, { network: 'testnet4' });
      service.session.data.network = 'testnet4';
    }
    const after = service.publicAccount(0, 0);
    assert.notEqual(after, before, 'A matching index must not bypass lifecycle validation');
    assert.notEqual(service.accountDerivation, oldContext);
    assert.throws(() => oldContext.deriver.derive(0, 0));
    assert.deepEqual(after, oldPublicAccount(service.session.data, 0, 0, service.config.network));
    assert.equal(service.accountCache.size, 1, 'Entries belonging to the old context must be discarded');
    if (reason !== 'epoch') assert.notEqual(after.address, before.address);
  });
}

test('lock destroys its public deriver and a newly opened phrase cannot reuse the old cache', async t => {
  const service = fixture(t);
  await service.buildAccounts();
  const before = service.publicAccount(0, 0), oldContext = service.accountDerivation;
  await service.lock();
  assert.equal(service.session, null);
  assert.deepEqual(service.accounts, []);
  assert.equal(service.accountCache.size, 0);
  assert.equal(service.accountDerivation?.deriver, undefined);
  assert.throws(() => oldContext.deriver.derive(0, 0));
  assert.throws(() => service.publicAccount(0, 0), /lock|session|unlock/i);
  const data = walletData('testnet4', { mnemonic: OTHER_PHRASE });
  await service.openSession(data, PUBLIC_PASSWORD);
  const after = service.publicAccount(0, 0);
  assert.notEqual(after.address, before.address);
  assert.deepEqual(after, oldPublicAccount(data, 0, 0));
  assert.notEqual(service.accountDerivation, oldContext);
  assert.equal(service.accountCache.size, 41);
});

for (const changed of ['mnemonic', 'passphrase']) {
  test(`openSession directly replacing ${changed} destroys and rebuilds the scoped public cache`, async t => {
    const service = fixture(t);
    await service.buildAccounts();
    const before = service.publicAccount(0, 0), oldContext = service.accountDerivation;
    const data = walletData('testnet4', changed === 'mnemonic' ? { mnemonic: OTHER_PHRASE } : { passphrase: 'public BIP39 passphrase fixture' });
    await service.openSession(data, PUBLIC_PASSWORD);
    assert.throws(() => oldContext.deriver.derive(0, 0));
    assert.notEqual(service.accountDerivation, oldContext);
    assert.equal(service.accountDerivation.session, service.session);
    const after = service.publicAccount(0, 0);
    assert.notEqual(after.address, before.address);
    assert.deepEqual(after, oldPublicAccount(data, 0, 0));
    assert.equal(service.accountCache.size, 41);
  });
}

test('close clears the cache and destroys the public deriver without network or disk access', async t => {
  const service = fixture(t);
  service.publicAccount(0, 0);
  const deriver = service.accountDerivation.deriver;
  await service.close();
  assert.equal(service.closed, true);
  assert.equal(service.session, null);
  assert.equal(service.accountCache.size, 0);
  assert.equal(service.accountDerivation?.deriver, undefined);
  assert.throws(() => deriver.derive(0, 0));
});

test('a real large public build yields to lock and cannot contaminate the next session cache', async t => {
  const service = fixture(t, 'testnet4', { receiveIndex: 1025, changeIndex: 1025, scanLookahead: false });
  const publicAccount = service.publicAccount.bind(service);
  let calls = 0, callsAtLock, contextAtLock;
  service.publicAccount = (...args) => { calls++; return publicAccount(...args); };
  const old = service.buildAccounts();
  const cancelled = assert.rejects(old, /locked|changed|cancelled/i);
  let next;
  const nextData = walletData('testnet4', { mnemonic: OTHER_PHRASE, passphrase: 'public replacement fixture' });
  await new Promise((resolve, reject) => setImmediate(() => {
    void (async () => {
      callsAtLock = calls; contextAtLock = service.accountDerivation;
      assert.ok(callsAtLock > 0 && callsAtLock < 2052, 'The old build must yield before enumerating every address');
      await service.lock();
      assert.equal(service.accountCache.size, 0);
      assert.equal(service.accountDerivation?.deriver, undefined);
      next = service.openSession(nextData, PUBLIC_PASSWORD);
    })().then(resolve, reject);
  }));
  await cancelled;
  await next;
  assert.throws(() => contextAtLock.deriver.derive(0, 0));
  assert.equal(calls - callsAtLock, 41, 'The cancelled builder must not resume deriving into the replacement session');
  assert.equal(service.accounts.length, 41);
  assert.equal(service.accountCache.size, 41);
  assert.equal(service.accountBuild, null);
  assert.equal(service.accountDerivation.session, service.session);
  assert.equal(service.accountDerivation.epoch, service.epoch);
  for (const account of service.accounts) {
    assertPublicAccount(account);
    assert.deepEqual(account, oldPublicAccount(nextData, account.index, account.change));
    assert.equal(service.publicAccount(account.index, account.change), account);
  }
});
