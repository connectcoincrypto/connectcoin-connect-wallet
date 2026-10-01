import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PROFILE_NAME, VAULT_NAME, selectProfileDirectory, selectStartupNetwork, selectVaultFile } from '../src/core/profile-paths.mjs';
import { encryptVault, updateVault, unlockVault } from '../src/core/vault.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';

const PASSWORD = 'Current format test password';
const DATA = { mnemonic: `${'abandon '.repeat(11)}about`, network: 'main', name: 'Isolated ConnectWallet test', passphrase: '', receiveIndex: 0, changeIndex: 0, lastUsedReceive: -1, lastUsedChange: -1 };
class OfflineBackend extends EventEmitter { close() {} request() { throw new Error('Profile tests must not use the network.'); } }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-profile-'));
  t.after(async () => {
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('connectwallet-profile-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('fresh profiles default to isolated mainnet and selection never creates files', async t => {
  const directory = await fixture(t);
  assert.equal(PROFILE_NAME, 'ConnectWallet-mainnet');
  assert.equal(VAULT_NAME, 'wallet.connectwallet.json');
  assert.equal(selectProfileDirectory(directory), join(directory, PROFILE_NAME));
  assert.equal(selectVaultFile(join(directory, PROFILE_NAME)), join(directory, PROFILE_NAME, VAULT_NAME));
  assert.equal(selectProfileDirectory(directory, 'testnet4'), join(directory, 'ConnectWallet'));
  assert.equal(selectProfileDirectory(directory, 'regtest'), join(directory, 'ConnectWallet-regtest'));
  for (const network of ['__proto__', '../ConnectWallet', '', 'mainnet']) assert.throws(() => selectProfileDirectory(directory, network), /network/);
  assert.deepEqual(await readdir(directory), []);
});

test('installed builds use mainnet and test networks require explicit development selection', () => {
  assert.equal(selectStartupNetwork(), 'main');
  for (const network of ['main', 'testnet4', 'regtest']) {
    assert.equal(selectStartupNetwork({ requestedNetwork: network }), network);
    assert.equal(selectStartupNetwork({ isPackaged: true, requestedNetwork: network }), 'main');
  }
  for (const requestedNetwork of ['', 'mainnet', '__proto__']) assert.throws(() => selectStartupNetwork({ requestedNetwork }), /network/);
});

test('fresh mainnet never reads or inherits testnet wallet data and claims consent', async t => {
  const directory = await fixture(t), legacy = join(directory, 'ConnectWallet');
  await mkdir(legacy);
  const config = '{"version":1,"network":"testnet4","claims":{"enabled":true}}';
  const wallet = 'legacy encrypted wallet sentinel: must remain untouched';
  await writeFile(join(legacy, 'config.json'), config);
  await writeFile(join(legacy, VAULT_NAME), wallet);
  const profile = selectProfileDirectory(directory);
  const service = new WalletService({ directory: profile, clientFactory: () => new OfflineBackend() });
  try {
    await service.initialize();
    assert.equal(service.config.network, 'main');
    assert.equal(service.config.rpc.host, 'connectcoin4.com');
    assert.equal(service.config.rpc.port, 48190);
    assert.equal(service.config.claims.enabled, false);
    assert.equal(service.walletExists, false);
    assert.equal(service.getState().phase, 'welcome');
    assert.equal(await readFile(join(legacy, 'config.json'), 'utf8'), config);
    assert.equal(await readFile(join(legacy, VAULT_NAME), 'utf8'), wallet);
  } finally { await service.close(); }
});

test('wrong-network configuration is rejected before RPC creation and never rewritten', async t => {
  const directory = await fixture(t), file = join(directory, 'config.json');
  const bytes = '{"version":1,"network":"testnet4","claims":{"enabled":true}}';
  await writeFile(file, bytes);
  let created = false;
  const service = new WalletService({ directory, clientFactory: () => { created = true; return new OfflineBackend(); } });
  await assert.rejects(service.initialize(), /different network/);
  service.statePublisher.close();
  assert.equal(created, false);
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('a testnet vault cannot unlock in mainnet or be converted by changing endpoint settings', async t => {
  const directory = await fixture(t), file = join(directory, VAULT_NAME);
  const bytes = JSON.stringify(await encryptVault({ ...DATA, network: 'testnet4' }, PASSWORD));
  await writeFile(file, bytes);
  const service = new WalletService({ directory, clientFactory: () => new OfflineBackend() });
  try {
    await service.initialize();
    await service.saveConfig({ network: 'testnet4', rpc: { host: '127.0.0.1', port: 48190 } });
    assert.equal(service.config.network, 'main');
    await assert.rejects(service.unlock({ password: PASSWORD }), /different networks/);
    assert.equal(service.session, null);
    assert.equal(service.config.claims.enabled, false);
    assert.equal(await readFile(file, 'utf8'), bytes);
  } finally { await service.close(); }
});

test('selection inspects only the current directory and filename, without probing siblings', async t => {
  const directory = await fixture(t), profile = join(directory, PROFILE_NAME);
  await mkdir(profile);
  const unrelated = join(directory, 'Another application');
  await mkdir(unrelated);
  await writeFile(join(unrelated, 'wallet.json'), 'unrelated encrypted data');
  await writeFile(join(profile, 'wallet.other.json'), 'unrelated backup');
  const inspected = [], original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => { inspected.push(resolve(file)); return original(file, ...args); });
  syncBuiltinESMExports();
  try {
    assert.equal(selectProfileDirectory(directory), profile);
    assert.deepEqual(inspected, [profile, join(profile, VAULT_NAME)]);
    inspected.length = 0;
    assert.equal(selectVaultFile(profile), join(profile, VAULT_NAME));
    assert.deepEqual(inspected, [profile, join(profile, VAULT_NAME)]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(await readFile(join(unrelated, 'wallet.json'), 'utf8'), 'unrelated encrypted data');
  assert.equal(await readFile(join(profile, 'wallet.other.json'), 'utf8'), 'unrelated backup');
});

test('a different wallet filename is ignored, without import or automatic replacement', async t => {
  const directory = await fixture(t);
  const other = join(directory, 'wallet.other.json');
  await writeFile(other, 'not a supported wallet file');
  const service = new WalletService({ directory, clientFactory: () => new OfflineBackend() });
  try {
    await service.initialize();
    assert.equal(service.vaultFile, join(directory, VAULT_NAME));
    assert.equal(service.walletExists, false);
    assert.equal(service.getState().phase, 'welcome');
    assert.equal(await readFile(other, 'utf8'), 'not a supported wallet file');
    assert.equal((await readdir(directory)).includes(VAULT_NAME), false);
  } finally { await service.close(); }
});

test('unexpected filesystem objects and linked profiles are rejected before writing config', async t => {
  const directory = await fixture(t), profile = join(directory, PROFILE_NAME);
  await mkdir(join(profile, VAULT_NAME), { recursive: true });
  assert.throws(() => selectProfileDirectory(directory), /not a regular file/);
  const service = new WalletService({ directory: profile, clientFactory: () => new OfflineBackend() });
  await assert.rejects(service.initialize(), /not a regular file/);
  assert.deepEqual(await readdir(profile), [VAULT_NAME]);
  const separate = await fixture(t), target = join(separate, 'external');
  await mkdir(target);
  await symlink(target, join(separate, PROFILE_NAME), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => selectProfileDirectory(separate), /not a regular directory/);
  assert.deepEqual(await readdir(target), []);
});

test('only absence is treated as an empty profile, not filesystem access errors', async t => {
  const directory = await fixture(t);
  t.mock.method(fs, 'lstatSync', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
  syncBuiltinESMExports();
  try { assert.throws(() => selectProfileDirectory(directory), { code: 'EACCES' }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(await readdir(directory), []);
});

test('a linked vault is rejected without following it or reading another profile', async t => {
  const directory = await fixture(t), file = join(directory, VAULT_NAME);
  const inspected = [], original = fs.lstatSync;
  // Model the metadata here so this regression also runs on Windows accounts
  // without the privilege to create file symlinks. Directory junctions above
  // additionally exercise a real filesystem link on Windows.
  t.mock.method(fs, 'lstatSync', (candidate, ...args) => {
    inspected.push(resolve(candidate));
    if (resolve(candidate) === file) return { isSymbolicLink: () => true, isFile: () => true };
    return original(candidate, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => selectVaultFile(directory), /not a regular file/);
    assert.deepEqual(inspected, [directory, file]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(await readdir(directory), []);
});

test('current-format vault opens and updates without creating alternate wallet files', async t => {
  const directory = await fixture(t), file = join(directory, VAULT_NAME);
  await writeFile(file, JSON.stringify(await encryptVault(DATA, PASSWORD)));
  const service = new WalletService({ directory, clientFactory: () => new OfflineBackend() });
  try {
    await service.initialize(); service.refresh = async () => service.getState();
    await service.unlock({ password: PASSWORD });
    assert.equal(service.session.data.mnemonic, DATA.mnemonic);
    assert.match(service.getState().wallet.address, /^cc1/);
    const backup = await service.getRecoveryPhrase({ password: PASSWORD });
    assert.equal(backup.network, 'main');
    assert.equal(backup.path, "m/44'/0'/0'/change/index");
    await service.lock();
    await updateVault(file, { ...DATA, name: 'Updated ConnectWallet' }, PASSWORD);
    assert.equal((await unlockVault(file, PASSWORD)).name, 'Updated ConnectWallet');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).format, 'connectcoin-connect-wallet');
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('wallet')), [VAULT_NAME]);
  } finally { await service.close(); }
});

test('unsupported encrypted formats are neither unlocked nor migrated, regardless of filename', async t => {
  const directory = await fixture(t), file = join(directory, VAULT_NAME);
  const unsupported = { ...await encryptVault(DATA, PASSWORD), format: 'unsupported-testnet-format' };
  const bytes = `${JSON.stringify(unsupported)}\n`;
  await writeFile(file, bytes);
  const service = new WalletService({ directory, clientFactory: () => new OfflineBackend() });
  try {
    await service.initialize();
    await assert.rejects(service.unlock({ password: PASSWORD }), /Unsupported encrypted wallet format/);
    await assert.rejects(updateVault(file, DATA, PASSWORD), /Unsupported encrypted wallet format/);
    assert.equal(service.session, null);
    assert.equal(service.getState().phase, 'locked');
    assert.equal(await readFile(file, 'utf8'), bytes);
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('wallet')), [VAULT_NAME]);
    service.refresh = async () => service.getState();
    const { replacementId } = await service.beginWalletReplacement({ mode: 'recover' });
    await service.restoreWallet({ name: 'Explicitly restored', mnemonic: DATA.mnemonic, password: PASSWORD, replacementId });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).format, 'connectcoin-connect-wallet');
    assert.equal((await unlockVault(file, PASSWORD)).mnemonic, DATA.mnemonic);
    const archives = await readdir(join(directory, 'wallet-backups'));
    assert.equal(archives.length, 1);
    assert.equal(await readFile(join(directory, 'wallet-backups', archives[0]), 'utf8'), bytes);
  } finally { await service.close(); }
});
