import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp, { mkdtemp, readdir, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WalletService } from '../src/core/wallet-service.mjs';
import { createVault, unlockVault } from '../src/core/vault.mjs';

const PASSWORD = 'public-creation-test-password';
const DATA = { name: 'Creation fixture', mnemonic: `${'abandon '.repeat(11)}about`, network: 'testnet4' };
class OfflineBackend extends EventEmitter {
  close() {}
  request() { throw new Error('Creation tests must not make network requests.'); }
}
async function directory(t, beforeCleanup = () => {}) {
  const value = await mkdtemp(join(tmpdir(), 'connectwallet-creation-test-'));
  t.after(async () => {
    await beforeCleanup();
    assert.equal(dirname(value), resolve(tmpdir()));
    assert.ok(basename(value).startsWith('connectwallet-creation-test-'));
    await rm(value, { recursive: true, force: true });
  });
  return value;
}
async function fixture(t) {
  let service;
  const location = await directory(t, () => service?.close());
  service = new WalletService({ directory: location, network: 'testnet4', clientFactory: () => new OfflineBackend() });
  await service.initialize();
  service.refresh = async () => service.getState();
  return service;
}
async function withFsOverrides(overrides, operation) {
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, fsp[key]]));
  Object.assign(fsp, overrides); syncBuiltinESMExports();
  try { return await operation(); }
  finally { Object.assign(fsp, previous); syncBuiltinESMExports(); }
}
async function prepare(service) {
  const setup = await service.prepareWallet({ name: DATA.name, password: PASSWORD, wordCount: 12 });
  const words = setup.mnemonic.split(' ');
  return { setupId: setup.setupId, answers: Object.fromEntries(setup.checkIndexes.map(index => [index, words[index]])) };
}

test('cancelled initial setup during encryption leaves no wallet or open session', async t => {
  const service = await fixture(t), confirmation = await prepare(service);
  const pending = service.confirmWallet(confirmation);
  const cancelled = assert.rejects(pending, /cancelled/);
  await nextTurn();
  service.cancelSetup();
  await cancelled;
  assert.equal(service.getState().phase, 'welcome');
  assert.equal(fs.existsSync(service.vaultFile), false);
  assert.ok(!(await readdir(service.directory)).some(name => name.endsWith('.tmp')));
});

test('cancellation at the final authorization check leaves no first vault or temporary file', async t => {
  const location = await directory(t), file = join(location, 'wallet.connectwallet.json');
  await assert.rejects(createVault(file, DATA, PASSWORD, {
    check() { throw new Error('cancelled before publication'); },
  }), /cancelled before publication/);
  assert.deepEqual(await readdir(location), []);
});

test('initial publication completes before queued cancellation can run after authorization', async t => {
  const location = await directory(t), file = join(location, 'wallet.connectwallet.json');
  const originalLink = fsp.link;
  let publishedWhenCancellationRuns = false;
  await withFsOverrides({
    // Model a pending filesystem operation deterministically. An asynchronous
    // publication here would let the queued cancellation run before the file exists.
    link: async (...args) => { await nextTurn(); return originalLink(...args); },
  }, () => createVault(file, DATA, PASSWORD, {
    check() { queueMicrotask(() => { publishedWhenCancellationRuns = fs.existsSync(file); }); },
  }));
  assert.equal(publishedWhenCancellationRuns, true);
  assert.deepEqual(await unlockVault(file, PASSWORD), DATA);
});

test('setup cancellation after publication keeps the first wallet locked and accessible', async t => {
  const service = await fixture(t), confirmation = await prepare(service);
  const originalChmod = fsp.chmod;
  const result = await withFsOverrides({
    chmod: async (...args) => {
      if (args[0] === service.vaultFile) {
        assert.equal(fs.existsSync(service.vaultFile), true);
        service.cancelSetup();
      }
      return originalChmod(...args);
    },
  }, () => service.confirmWallet(confirmation));
  assert.equal(result.phase, 'locked');
  assert.equal(result.setupActive, false);
  assert.equal(service.session, null);
  assert.equal(service.walletExists, true);
  await service.unlock({ password: PASSWORD });
  assert.equal(service.getState().phase, 'unlocked');
});

test('post-publication failures leave the first wallet recognized and unlockable', async t => {
  for (const stage of ['chmod', 'temporary removal', 'final cleanup', 'directory sync']) {
    await t.test(stage, async t => {
      const service = await fixture(t);
      const failure = () => { throw Object.assign(new Error(`injected ${stage} failure`), { code: 'EIO' }); };
      const originalChmod = fsp.chmod, originalUnlink = fsp.unlink, originalOpen = fsp.open;
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      let removals = 0;
      const overrides = {
        chmod: async (...args) => args[0] === service.vaultFile && stage === 'chmod' ? failure() : originalChmod(...args),
        unlink: async (...args) => {
          if (dirname(args[0]) === service.directory && basename(args[0]).endsWith('.tmp')) {
            removals++;
            if ((stage === 'temporary removal' && removals === 1) || (stage === 'final cleanup' && removals === 2)) failure();
          }
          return originalUnlink(...args);
        },
        open: async (...args) => args[0] === service.directory && args[1] === 'r' && stage === 'directory sync'
          ? { sync: async () => failure(), close: async () => {} }
          : originalOpen(...args),
      };
      try {
        // Exercise the directory durability path on Windows without attempting
        // to open a native Windows directory as a file.
        if (stage === 'directory sync') Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
        await withFsOverrides(overrides, () => assert.rejects(
          service.restoreWallet({ ...DATA, password: PASSWORD }),
          error => error.walletPublished === true && /wallet was installed/.test(error.message),
        ));
      } finally { Object.defineProperty(process, 'platform', platform); }
      assert.equal(service.getState().phase, 'locked');
      assert.equal(service.getState().setupActive, false);
      assert.match(service.getState().error, /password used for this save/);
      assert.equal((await unlockVault(service.vaultFile, PASSWORD)).mnemonic, DATA.mnemonic);
      assert.ok(!(await readdir(service.directory)).some(name => name.endsWith('.tmp')));
      await service.unlock({ password: PASSWORD });
      assert.equal(service.getState().phase, 'unlocked');
    });
  }
});
