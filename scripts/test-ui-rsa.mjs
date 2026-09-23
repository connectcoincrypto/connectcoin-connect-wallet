// Real Electron IPC/preload/renderer; isolated presentation fixtures only.
// No user profile, private keys, TLS connections, RPC or broadcasts are used.
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/core/config.mjs';
import { closeElectronTest } from './ui-close.mjs';

const started = performance.now();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'connectwallet-ui-rsa-'));
const screenshots = await mkdtemp(path.join(tmpdir(), 'connectwallet-rsa-screens-'));
const config = { ...DEFAULT_CONFIG, theme: 'dark', rpc: { host: '127.0.0.1', port: 1 } };
await writeFile(path.join(profile, 'config.json'), JSON.stringify(config));
const env = { ...process.env, CONNECTWALLET_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const snapshot = { phase: 'unlocked', securityEpoch: 1, config, setupActive: false, error: null,
  wallet: { name: 'RSA presentation fixture', address: 'not-a-real-address', balance: { available: '10' } },
  network: { chain: 'testnet4', status: 'connected', height: 100 }, claims: { enabled: false }, history: [] };
const baseReview = { previewId: 'isolated-preview', type: 'p2c', address: 'example.com', amount: '1', fee: '0.0001', total: '1.0001', expectedConnections: '1024' };
let app, page, stage = 'launch';
let passed = false;
const timings = {};
const errors = [];

async function startReview() {
  await page.getByRole('button', { name: 'Review bounty' }).click();
  await page.getByRole('heading', { name: 'Preparing your bounty.' }).waitFor();
  await app.evaluate(() => { if (!globalThis.rsaUiPending) throw new Error('No pending review'); });
  assert.equal(await page.getByRole('button', { name: 'Create bounty', exact: true }).count(), 0);
}
async function finishReview(review) {
  await app.evaluate((_electron, value) => { globalThis.rsaUiPending.resolve(value); globalThis.rsaUiPending = null; }, { ...baseReview, ...review });
  await page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'false');
}

try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [root], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Hello, connection.' }).waitFor();
  await app.evaluate(({ BrowserWindow }, { moduleUrl, snapshot }) => {
    const modulePath = process.getBuiltinModule('url').fileURLToPath(moduleUrl);
    const { WalletService } = process.getBuiltinModule('module').createRequire(moduleUrl)(modulePath);
    globalThis.rsaUiCancellations = 0;
    globalThis.rsaUiLocks = 0;
    const realLock = WalletService.prototype.lock;
    WalletService.prototype.lock = function (...args) {
      globalThis.rsaUiLocks++;
      globalThis.rsaUiService = this;
      this.walletExists = true; // Presentation fixture only; no vault is opened.
      globalThis.rsaUiRefresh?.(); globalThis.rsaUiRefresh = null;
      return realLock.apply(this, args);
    };
    WalletService.prototype.previewSend = function () { return new Promise((resolve, reject) => { globalThis.rsaUiPending = { resolve, reject }; }); };
    WalletService.prototype.cancelSendPreview = function () {
      globalThis.rsaUiCancellations++;
      globalThis.rsaUiPending?.reject(new Error('Review cancelled'));
      globalThis.rsaUiPending = null;
    };
    WalletService.prototype.confirmSend = function () { throw new Error('UI fixture must never broadcast'); };
    BrowserWindow.getAllWindows()[0].setSize(1100, 850);
    BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', snapshot);
  }, { moduleUrl: new URL('../src/core/wallet-service.mjs', import.meta.url).href, snapshot });
  await page.locator('[data-view="send"]').first().click();
  await page.getByRole('button', { name: 'Create a bounty', exact: true }).click();
  await page.locator('#send-domain').fill('example.com');
  await page.locator('#send-amount').fill('1');
  await page.locator('#send-expected').fill('1024');

  stage = 'cancel through the real IPC serialization gate';
  await startReview();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#modal').open && document.querySelector('#app').getAttribute('aria-busy') === 'false');
  assert.equal(await app.evaluate(() => globalThis.rsaUiCancellations), 1);
  assert.equal(await page.locator('#view-error').textContent(), '');

  stage = 'RSA-only review and frozen policy';
  await startReview(); await finishReview({ signatureAlgorithmsMask: 6, rsaProbeStatus: 'verified' });
  assert.ok((await page.locator('#modal').textContent()).includes('RSA-PSS / SHA-256 only (mask 6)'));
  assert.ok((await page.locator('#modal').textContent()).includes('RSA support verified.'));
  assert.equal(await page.getByRole('button', { name: 'Create bounty', exact: true }).isEnabled(), true);
  await page.screenshot({ path: path.join(screenshots, 'rsa-verified.png') });
  await page.getByRole('button', { name: 'Go back', exact: true }).click();

  stage = 'fallback notices';
  for (const status of ['timeout', 'failed', 'unavailable', 'busy']) {
    await startReview(); await finishReview({ signatureAlgorithmsMask: 7, rsaProbeStatus: status });
    assert.ok((await page.locator('#modal').textContent()).includes('ECDSA P-256 + RSA-PSS / SHA-256 (mask 7)'));
    assert.ok((await page.locator('#modal').textContent()).includes('not confirmation'));
    if (status === 'timeout') await page.screenshot({ path: path.join(screenshots, 'rsa-timeout.png') });
    await page.getByRole('button', { name: 'Go back', exact: true }).click();
  }

  stage = 'Escape cancellation while busy';
  await startReview(); await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#modal').open && document.querySelector('#app').getAttribute('aria-busy') === 'false');

  stage = 'failed preparation leaves no misleading wait dialog';
  await startReview();
  await app.evaluate(() => { globalThis.rsaUiPending.reject(new Error('Insufficient verified funds')); globalThis.rsaUiPending = null; });
  await page.waitForFunction(() => !document.querySelector('#modal').open && document.querySelector('#app').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#view-error').textContent(), /Insufficient/);

  stage = 'inconsistent policy cannot be confirmed';
  await startReview(); await finishReview({ signatureAlgorithmsMask: 6, rsaProbeStatus: 'timeout' });
  assert.equal(await page.getByRole('button', { name: 'Create bounty', exact: true }).count(), 0);
  assert.match(await page.locator('#view-error').textContent(), /Incomplete bounty signature policy/);

  stage = 'keyboard lock interrupts a busy review through the real IPC gate';
  await startReview();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+l' : 'Control+l');
  await page.locator('#unlock-password').waitFor();
  await page.waitForFunction(() => !document.querySelector('#modal').open && document.querySelector('#app').getAttribute('aria-busy') === 'false');
  assert.equal(await app.evaluate(() => globalThis.rsaUiLocks), 1);
  assert.equal(await app.evaluate(() => globalThis.rsaUiPending), null);
  assert.equal(await page.locator('#send-domain').count(), 0);

  stage = 'both lock buttons interrupt a busy RPC refresh';
  for (const buttonName of ['Lock wallet', 'Lock now']) {
    await app.evaluate(({ BrowserWindow }, { moduleUrl, snapshot }) => {
      const modulePath = process.getBuiltinModule('url').fileURLToPath(moduleUrl);
      const { WalletService } = process.getBuiltinModule('module').createRequire(moduleUrl)(modulePath);
      WalletService.prototype.refresh = function () { return new Promise(resolve => { globalThis.rsaUiRefresh = resolve; }); };
      // Each case injects an unlocked presentation while the real service is
      // still locked. Its completed previous lock may have one coalesced
      // publication pending; drain that fixture boundary before replacing it.
      globalThis.rsaUiService.statePublisher.cancelPending();
      BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', { ...snapshot, securityEpoch: 100 });
    }, { moduleUrl: new URL('../src/core/wallet-service.mjs', import.meta.url).href, snapshot });
    await page.locator('[data-view="settings"]').first().click();
    await page.getByRole('button', { name: 'Refresh wallet', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'true');
    assert.equal(await app.evaluate(() => typeof globalThis.rsaUiRefresh), 'function');
    for (const label of ['Lock wallet', 'Lock now']) {
      assert.equal(await page.getByRole('button', { name: label, exact: true }).isEnabled(), true);
    }
    await page.getByRole('button', { name: buttonName, exact: true }).click();
    await page.locator('#unlock-password').waitFor();
    await page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'false');
  }
  assert.equal(await app.evaluate(() => globalThis.rsaUiLocks), 3);
  assert.deepEqual(errors, []);
  timings.assertionsMs = Math.round(performance.now() - started);
  passed = true;
} catch (error) {
  console.error(`RSA UI test failed during ${stage}: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try {
    Object.assign(timings, await closeElectronTest(app));
    const cleanupStarted = performance.now();
    const absolute = path.resolve(profile);
    assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
    assert.ok(path.basename(absolute).startsWith('connectwallet-ui-rsa-'));
    await rm(absolute, { recursive: true, force: true });
    timings.profileCleanupMs = Math.round(performance.now() - cleanupStarted);
  } catch (error) {
    passed = false;
    process.exitCode = 1;
    console.error(`RSA UI teardown failed: ${error.stack ?? error}`);
  }
  timings.totalMs = Math.round(performance.now() - started);
  console.log(`RSA UI timings: ${JSON.stringify(timings)}`);
}
if (passed) console.log(`PASS: RSA success/fallback reviews, real IPC cancellation, Escape, preparation failure, inconsistent-policy rejection, keyboard/button locking during pending work and graceful shutdown. Screenshots: ${screenshots}`);
