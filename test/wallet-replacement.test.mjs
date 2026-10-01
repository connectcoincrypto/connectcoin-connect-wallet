import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { WalletService } from '../src/core/wallet-service.mjs';
import { decryptVault, encryptVault, replaceVault, unlockVault, vaultFingerprint } from '../src/core/vault.mjs';
import { generateMnemonic } from '../src/core/crypto.mjs';

const OLD_PASSWORD = 'old-local-test-password';
const NEW_PASSWORD = 'new-local-test-password';
const MNEMONIC = `${'abandon '.repeat(11)}about`;
const OLD_DATA = { name: 'Original wallet', mnemonic: MNEMONIC, network: 'testnet4', passphrase: '', receiveIndex: 0, changeIndex: 0, lastUsedReceive: -1, lastUsedChange: -1 };
let originalBytes;
before(async () => { originalBytes = Buffer.from(`${JSON.stringify(await encryptVault(OLD_DATA, OLD_PASSWORD), null, 2)}\n`); });
class OfflineBackend extends EventEmitter {
  close() {}
  request() { throw new Error('Recovery tests must not make network requests.'); }
}
async function fixture(t, existing = true) {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-replacement-test-'));
  if (existing) await writeFile(join(directory, 'wallet.connectwallet.json'), originalBytes);
  const service = new WalletService({ directory, network: 'testnet4', clientFactory: () => new OfflineBackend() });
  await service.initialize();
  service.refresh = async () => service.getState();
  t.after(async () => {
    await service.close();
    assert.equal(dirname(directory), tmpdir());
    assert.ok(basename(directory).startsWith('connectwallet-replacement-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return service;
}
const input = (replacementId, mnemonic = MNEMONIC) => ({ name: 'Recovered wallet', mnemonic, password: NEW_PASSWORD, replacementId });
async function backups(service) {
  return readdir(join(service.directory, 'wallet-backups')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
}
async function unchanged(service) { assert.deepEqual(await readFile(service.vaultFile), originalBytes); }

test('recovery authorization is locked-only, short-lived and absent from public state', async t => {
  const s = await fixture(t);
  await assert.rejects(s.beginWalletReplacement({ mode: 'delete' }), /Choose recovery/);
  const { replacementId } = await s.beginWalletReplacement({ mode: 'recover' });
  assert.equal(s.getState().replacementActive, true);
  assert.equal(s.getState().replacementMode, 'recover');
  assert.ok(!JSON.stringify(s.getState()).includes(replacementId));
  assert.ok(!JSON.stringify(s.getState()).includes(s.replacement.expectedFingerprint));
  await unchanged(s); assert.deepEqual(await backups(s), []);
  await assert.rejects(s.prepareWallet({ name: 'New', password: NEW_PASSWORD, replacementId }), /recovery words/);
  s.replacement.expires = Date.now() - 1;
  assert.equal(s.getState().replacementActive, false);
  await assert.rejects(s.restoreWallet(input(replacementId)), /expired/);
  await unchanged(s);
  await s.unlock({ password: OLD_PASSWORD });
  await assert.rejects(s.beginWalletReplacement({ mode: 'switch' }), /Lock the existing wallet/);
});

test('recovery validates every input without replacing or backing up the old file', async t => {
  const s = await fixture(t);
  await assert.rejects(s.restoreWallet(input(undefined)), /replacement expired/);
  const { replacementId } = await s.beginWalletReplacement({ mode: 'recover' });
  for (const invalid of [{ password: 'short' }, { mnemonic: 'not a recovery phrase' }, { name: '' }, { replacementId: 'invented' }]) {
    await assert.rejects(s.restoreWallet({ ...input(replacementId), ...invalid }));
    await unchanged(s); assert.deepEqual(await backups(s), []);
  }
  s.cancelWalletReplacement();
  assert.equal(s.getState().replacementActive, false);
  await assert.rejects(s.restoreWallet(input(replacementId)), /cancelled/);
  await unchanged(s);
});

test('forgotten-password recovery preserves exact original ciphertext and uses new password', async t => {
  const s = await fixture(t);
  const { replacementId } = await s.beginWalletReplacement({ mode: 'recover' });
  await s.restoreWallet(input(replacementId));
  assert.equal(s.getState().phase, 'unlocked');
  assert.equal(s.getState().replacementActive, false);
  assert.equal(s.session.data.mnemonic, MNEMONIC);
  assert.equal(s.session.data.needsRecovery, true);
  const files = await backups(s); assert.equal(files.length, 1);
  const backup = await readFile(join(s.directory, 'wallet-backups', files[0]));
  assert.deepEqual(backup, originalBytes);
  assert.deepEqual(await decryptVault(JSON.parse(backup), OLD_PASSWORD), OLD_DATA);
  assert.equal((await unlockVault(s.vaultFile, NEW_PASSWORD)).mnemonic, MNEMONIC);
  await assert.rejects(unlockVault(s.vaultFile, OLD_PASSWORD), /incorrect password/);
  await s.lock();
  await assert.rejects(s.restoreWallet(input(replacementId)), /expired/);
});

test('switch creates a wallet only after seed confirmation and keeps authorization when backing out of setup', async t => {
  const s = await fixture(t);
  const { replacementId } = await s.beginWalletReplacement({ mode: 'switch' });
  const abandoned = await s.prepareWallet({ name: 'New wallet', password: NEW_PASSWORD, wordCount: 12, replacementId });
  s.cancelSetup();
  assert.equal(s.getState().replacementActive, true);
  await assert.rejects(s.confirmWallet({ setupId: abandoned.setupId, answers: {} }), /expired/);
  const setup = await s.prepareWallet({ name: 'New wallet', password: NEW_PASSWORD, wordCount: 12, replacementId });
  await assert.rejects(s.confirmWallet({ setupId: setup.setupId, answers: {} }), /backup words/);
  await unchanged(s); assert.deepEqual(await backups(s), []);
  const words = setup.mnemonic.split(' ');
  await s.confirmWallet({ setupId: setup.setupId, answers: Object.fromEntries(setup.checkIndexes.map(i => [i, words[i]])) });
  assert.equal(s.session.data.mnemonic, setup.mnemonic);
  assert.notEqual(setup.mnemonic, MNEMONIC);
  assert.equal(s.session.data.needsRecovery, false);
  assert.equal((await backups(s)).length, 1);
});

test('switch can import another phrase without claiming it recovers the old wallet', async t => {
  const s = await fixture(t), another = generateMnemonic(12);
  const { replacementId } = await s.beginWalletReplacement({ mode: 'switch' });
  await s.restoreWallet(input(replacementId, another));
  assert.equal(s.session.data.mnemonic, another);
  assert.equal((await backups(s)).length, 1);
});

test('cancelling seed confirmation invalidates an in-flight replacement but keeps old wallet', async t => {
  const s = await fixture(t);
  const { replacementId } = await s.beginWalletReplacement({ mode: 'switch' });
  const setup = await s.prepareWallet({ name: 'New wallet', password: NEW_PASSWORD, wordCount: 12, replacementId });
  const words = setup.mnemonic.split(' ');
  const pending = s.confirmWallet({ setupId: setup.setupId, answers: Object.fromEntries(setup.checkIndexes.map(i => [i, words[i]])) });
  const cancelled = assert.rejects(pending, /cancelled/);
  await new Promise(resolve => setImmediate(resolve));
  s.cancelSetup(); await cancelled;
  await unchanged(s); assert.equal(s.getState().replacementActive, true);
  assert.deepEqual(await backups(s), []);
});

test('repeated replacements preserve separate byte-exact backups without overwriting either', async t => {
  const s = await fixture(t);
  let authorization = await s.beginWalletReplacement({ mode: 'recover' });
  await s.restoreWallet(input(authorization.replacementId));
  const secondVersion = await readFile(s.vaultFile);
  await s.lock();
  authorization = await s.beginWalletReplacement({ mode: 'switch' });
  await s.restoreWallet(input(authorization.replacementId, generateMnemonic(12)));
  const files = await backups(s); assert.equal(files.length, 2);
  const versions = await Promise.all(files.map(name => readFile(join(s.directory, 'wallet-backups', name))));
  assert.ok(versions.some(bytes => bytes.equals(originalBytes)));
  assert.ok(versions.some(bytes => bytes.equals(secondVersion)));
});

test('cancel, lock and close during encryption never publish replacement or revive a session', async t => {
  for (const action of ['cancelWalletReplacement', 'lock', 'close']) {
    await t.test(action, async t => {
      const s = await fixture(t);
      const { replacementId } = await s.beginWalletReplacement({ mode: 'recover' });
      const replacement = s.restoreWallet(input(replacementId));
      // Enter the asynchronous KDF before invalidating authorization.
      await new Promise(resolve => setImmediate(resolve));
      const rejected = assert.rejects(replacement, /cancelled/);
      await s[action](); await rejected;
      assert.equal(s.session, null); await unchanged(s);
      assert.deepEqual(await backups(s), []);
    });
  }
});

test('unlock invalidates replacement and waits for its cancelled write before decrypting', async t => {
  const s = await fixture(t);
  const { replacementId } = await s.beginWalletReplacement({ mode: 'recover' });
  const pending = s.restoreWallet(input(replacementId));
  const cancelled = assert.rejects(pending, /cancelled/);
  await s.unlock({ password: OLD_PASSWORD }); await cancelled;
  assert.equal(s.session.data.name, OLD_DATA.name);
  assert.equal(s.getState().replacementActive, false); await unchanged(s);
});

test('overlapping replacements are rejected and only the latest begin token can be used', async t => {
  const s = await fixture(t);
  const stale = await s.beginWalletReplacement({ mode: 'switch' });
  const current = await s.beginWalletReplacement({ mode: 'recover' });
  await assert.rejects(s.restoreWallet(input(stale.replacementId)), /expired/);
  const pending = s.restoreWallet(input(current.replacementId));
  await assert.rejects(s.restoreWallet(input(current.replacementId)), /already in progress/);
  await assert.rejects(s.beginWalletReplacement({ mode: 'switch' }), /operation to finish/);
  await pending; assert.equal((await backups(s)).length, 1);
});

test('an old encrypted write is drained before authorization and replacement', async t => {
  const s = await fixture(t);
  let finish;
  s.persisting = new Promise(resolve => { finish = resolve; });
  let authorized = false;
  const pending = s.beginWalletReplacement({ mode: 'recover' }).then(value => { authorized = true; return value; });
  try {
    await new Promise(resolve => setImmediate(resolve)); assert.equal(authorized, false);
    finish(); const { replacementId } = await pending;
    await s.restoreWallet(input(replacementId));
    assert.equal(s.session.data.name, 'Recovered wallet');
  } finally {
    finish();
    await pending;
  }
});

test('changed vault and backup failures leave the active wallet untouched', async t => {
  await t.test('changed fingerprint', async t => {
    const s = await fixture(t);
    const { replacementId } = await s.beginWalletReplacement({ mode: 'recover' });
    const changed = Buffer.concat([originalBytes, Buffer.from('\n')]);
    await writeFile(s.vaultFile, changed);
    await assert.rejects(s.restoreWallet(input(replacementId)), /wallet file changed/);
    assert.deepEqual(await readFile(s.vaultFile), changed);
    assert.deepEqual(await backups(s), []);
  });
  await t.test('backup path obstructed', async t => {
    const s = await fixture(t);
    await writeFile(join(s.directory, 'wallet-backups'), 'not a directory');
    const { replacementId } = await s.beginWalletReplacement({ mode: 'recover' });
    await assert.rejects(s.restoreWallet(input(replacementId)));
    await unchanged(s); assert.equal(s.session, null);
  });
  await t.test('backup path is a symlink or junction', async t => {
    const s = await fixture(t), other = join(s.directory, 'other');
    await mkdir(other);
    await symlink(other, join(s.directory, 'wallet-backups'), process.platform === 'win32' ? 'junction' : 'dir');
    const { replacementId } = await s.beginWalletReplacement({ mode: 'recover' });
    await assert.rejects(s.restoreWallet(input(replacementId)), /symbolic link/);
    await unchanged(s); assert.deepEqual(await readdir(other), []);
  });
});

test('cancellation immediately before publication leaves exact backup and old active file', async t => {
  const s = await fixture(t);
  const expectedFingerprint = await vaultFingerprint(s.vaultFile);
  let checks = 0;
  await assert.rejects(replaceVault(s.vaultFile, OLD_DATA, NEW_PASSWORD, {
    expectedFingerprint,
    check() { if (++checks === 4) throw new Error('cancelled before publication'); },
  }), /cancelled before publication/);
  await unchanged(s);
  const files = await backups(s); assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(s.directory, 'wallet-backups', files[0])), originalBytes);
  assert.ok(!(await readdir(s.directory)).some(name => name.endsWith('.tmp')));
});

test('replacement requires an existing wallet and does not leak secrets into diagnostics', async t => {
  const empty = await fixture(t, false);
  await assert.rejects(empty.beginWalletReplacement({ mode: 'switch' }), /existing wallet/);
  const s = await fixture(t);
  const { replacementId } = await s.beginWalletReplacement({ mode: 'recover' });
  await s.restoreWallet(input(replacementId)); await s.diagnostics.flush();
  const log = await readFile(s.diagnostics.snapshot().file, 'utf8');
  for (const secret of [OLD_PASSWORD, NEW_PASSWORD, MNEMONIC, replacementId]) assert.ok(!log.includes(secret));
});

test('post-publication directory flush failure is distinguished from an aborted replacement', async t => {
  const s = await fixture(t), expectedFingerprint = await vaultFingerprint(s.vaultFile);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalSync = fs.fsyncSync;
  let checks = 0;
  try {
    await assert.rejects(replaceVault(s.vaultFile, OLD_DATA, NEW_PASSWORD, {
      expectedFingerprint,
      check() {
        if (++checks !== 4) return;
        // Only fault the final, already-committed durability confirmation. The
        // preceding backup preparation uses the native platform unchanged.
        Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
        fs.fsyncSync = () => { throw Object.assign(new Error('injected flush failure'), { code: 'EIO' }); };
        syncBuiltinESMExports();
      },
    }), error => error.walletPublished === true && /new wallet was installed/.test(error.message));
  } finally {
    Object.defineProperty(process, 'platform', platform);
    fs.fsyncSync = originalSync; syncBuiltinESMExports();
  }
  assert.deepEqual(await unlockVault(s.vaultFile, NEW_PASSWORD), OLD_DATA);
  const files = await backups(s); assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(s.directory, 'wallet-backups', files[0])), originalBytes);
});

test('service invalidates replacement authorization after a post-publication durability failure', async t => {
  const s = await fixture(t);
  const { replacementId } = await s.beginWalletReplacement({ mode: 'recover' });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalSync = fs.fsyncSync, originalAssert = s.assertReplacement;
  let checks = 0;
  s.assertReplacement = function (...args) {
    const result = originalAssert.apply(this, args);
    // Seventh authorization check is replaceVault's final publication check.
    if (++checks === 7) {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      fs.fsyncSync = () => { throw Object.assign(new Error('injected flush failure'), { code: 'EIO' }); };
      syncBuiltinESMExports();
    }
    return result;
  };
  try { await assert.rejects(s.restoreWallet(input(replacementId)), /new wallet was installed/); }
  finally {
    Object.defineProperty(process, 'platform', platform);
    fs.fsyncSync = originalSync; syncBuiltinESMExports(); s.assertReplacement = originalAssert;
  }
  assert.equal(s.getState().phase, 'locked');
  assert.equal(s.getState().replacementActive, false);
  assert.equal(s.getState().setupActive, false);
  assert.match(s.getState().error, /new password/);
  await assert.rejects(s.restoreWallet(input(replacementId)), /expired/);
  await s.unlock({ password: NEW_PASSWORD });
  assert.equal(s.session.data.name, 'Recovered wallet');
  assert.equal((await backups(s)).length, 1);
});
