// Real Electron IPC/preload/renderer; isolated presentation fixtures only.
// No user profile, private keys, TLS connections, RPC or broadcasts are used.
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG } from '../src/core/config.mjs';
import { closeElectronTest } from './ui-close.mjs';

const started = performance.now();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] ?? root);
const serviceModuleUrl = pathToFileURL(path.join(target, 'src/core/wallet-service.mjs')).href;
const profile = await mkdtemp(path.join(tmpdir(), 'connectwallet-ui-rsa-'));
const screenshots = await mkdtemp(path.join(tmpdir(), 'connectwallet-rsa-screens-'));
const config = { ...DEFAULT_CONFIG, theme: 'dark', rpc: { host: '127.0.0.1', port: 1 } };
await writeFile(path.join(profile, 'config.json'), JSON.stringify(config));
const env = { ...process.env, CONNECTWALLET_TEST_PROFILE: profile, CONNECTWALLET_NETWORK: 'main' };
delete env.ELECTRON_RUN_AS_NODE;
const snapshot = { phase: 'unlocked', securityEpoch: 1, config, setupActive: false, error: null,
  wallet: { name: 'RSA presentation fixture', address: 'not-a-real-address', balance: { available: '10' } },
  network: { chain: 'main', status: 'connected', height: 100 }, claims: { enabled: false }, history: [] };
const baseReview = { previewId: 'isolated-preview', type: 'p2c', address: 'example.com', amount: '1', fee: '0.0001', total: '1.0001', expectedConnections: '1024' };
let app, page, stage = 'launch';
let passed = false;
const timings = {};
const errors = [];

async function startReview(type = 'bounty') {
  await page.getByRole('button', { name: type === 'bounty' ? 'Review bounty' : 'Review payment' }).click();
  await page.getByRole('heading', { name: `Preparing your ${type}.` }).waitFor();
  await app.evaluate(() => { if (!globalThis.rsaUiPending) throw new Error('No pending review'); });
  assert.equal(await page.getByRole('button', { name: 'Create bounty', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Confirm & send', exact: true }).count(), 0);
}
async function finishReview(review) {
  await app.evaluate((_electron, value) => { globalThis.rsaUiPending.resolve(value); globalThis.rsaUiPending = null; }, { ...baseReview, ...review });
  await page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'false');
}
async function preparationState(paymentPreparation, expectedText) {
  await app.evaluate(({ BrowserWindow }, state) => {
    BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', state);
  }, { ...snapshot, paymentPreparation });
  if (expectedText) await page.waitForFunction(text => document.querySelector('#payment-preparation-status')?.textContent === text, expectedText);
}

try {
  app = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [target], env, timeout: 30000 });
  const runtime = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath() }));
  assert.equal(runtime.packaged, false, 'Use development Electron so the isolated profile override is honored');
  assert.equal(path.resolve(runtime.profile), profile, 'Refuse to test outside the isolated profile');
  assert.equal(path.resolve(runtime.appPath), target, 'Mock the app that is actually under test');
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
    WalletService.prototype.previewSend = function (input) {
      globalThis.rsaUiPaymentInput = input;
      return new Promise((resolve, reject) => { globalThis.rsaUiPending = { resolve, reject }; });
    };
    WalletService.prototype.cancelSendPreview = function () {
      globalThis.rsaUiCancellations++;
      if (globalThis.rsaUiIgnoreCancellation) return;
      globalThis.rsaUiPending?.reject(new Error('Review cancelled'));
      globalThis.rsaUiPending = null;
    };
    WalletService.prototype.confirmSend = function () { throw new Error('UI fixture must never broadcast'); };
    BrowserWindow.getAllWindows()[0].setSize(1100, 850);
    BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', snapshot);
  }, { moduleUrl: serviceModuleUrl, snapshot });
  await page.locator('[data-view="send"]').first().click();
  await page.getByRole('button', { name: 'Create a bounty', exact: true }).click();
  await page.locator('#send-domain').fill('example.com');
  await page.locator('#send-amount').fill('1');
  await page.locator('#send-expected').fill('1024');

  stage = 'cancel through the real IPC serialization gate';
  await startReview();
  await preparationState({ stage: 'proof', completed: 1, total: 1 }, 'Checking the website’s RSA support…');
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

  stage = 'failed bounty preparation replaces the wait with a persistent error';
  await startReview();
  await app.evaluate(() => { globalThis.rsaUiPending.reject(new Error('Insufficient verified funds')); globalThis.rsaUiPending = null; });
  await page.getByRole('heading', { name: 'Could not prepare your bounty.', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#modal-error').textContent(), /Insufficient/);
  assert.equal(await page.locator('#payment-preparation-status').count(), 0);
  await preparationState(null);
  assert.equal(await page.locator('#modal-error').isVisible(), true);
  await page.getByRole('button', { name: 'Back to form', exact: true }).click();

  stage = 'inconsistent policy cannot be confirmed';
  await startReview(); await finishReview({ signatureAlgorithmsMask: 6, rsaProbeStatus: 'timeout' });
  assert.equal(await page.getByRole('button', { name: 'Create bounty', exact: true }).count(), 0);
  assert.match(await page.locator('#modal-error').textContent(), /Incomplete bounty signature policy/);
  await page.getByRole('button', { name: 'Back to form', exact: true }).click();

  stage = 'ordinary payment preparation exposes cancellation and retains the draft';
  await page.getByRole('button', { name: 'To an address', exact: true }).click();
  await page.locator('#send-address').fill('isolated-payment-recipient');
  await page.locator('#send-amount').fill('3');
  const paymentReview = { type: 'payment', address: 'isolated-payment-recipient', amount: '3', total: '3.0001' };
  for (const cancel of ['button', 'close', 'escape']) {
    const previous = await app.evaluate(() => globalThis.rsaUiCancellations);
    await startReview('payment');
    assert.match(await page.locator('#modal').textContent(), /many small outputs may take longer/);
    assert.match(await page.locator('#modal').textContent(), /Nothing will be sent until you review and confirm/);
    assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).isEnabled(), true);
    if (cancel === 'escape') await page.keyboard.press('Escape');
    else await page.getByRole('button', { name: cancel === 'close' ? 'Close dialog' : 'Cancel', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#modal').open && document.querySelector('#app').getAttribute('aria-busy') === 'false');
    assert.equal(await app.evaluate(() => globalThis.rsaUiCancellations), previous + 1);
    assert.equal(await page.locator('#view-error').textContent(), '');
    assert.equal(await page.locator('#send-address').inputValue(), paymentReview.address);
    assert.equal(await page.locator('#send-amount').inputValue(), '3');
    assert.equal(await page.getByRole('button', { name: 'Review payment', exact: true }).isEnabled(), true);
  }

  stage = 'funding progress updates in place without losing cancellation focus';
  await startReview('payment');
  assert.equal(await page.locator('#payment-preparation-status').textContent(), 'Checking spendable outputs…');
  await page.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.evaluate(() => {
    window.preparationStatusNode = document.querySelector('#payment-preparation-status');
    window.preparationCancelNode = document.activeElement;
  });
  for (const completed of [0, 48, 151]) {
    await preparationState({ stage: 'funding', completed, total: 151 }, `Verifying funding transactions: ${completed} of 151. RPC limits may require a wait.`);
    assert.equal(await page.evaluate(() => document.querySelector('#payment-preparation-status') === window.preparationStatusNode
      && document.activeElement === window.preparationCancelNode && window.preparationCancelNode.isConnected), true);
    assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).isEnabled(), true);
    if (completed === 48) await page.screenshot({ path: path.join(screenshots, 'payment-funding-progress.png') });
  }
  await preparationState({ stage: 'signing', completed: 151, total: 151 }, 'Signing locally…');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#modal').open && document.querySelector('#app').getAttribute('aria-busy') === 'false');
  await preparationState({ stage: 'funding', completed: 151, total: 151 });
  assert.equal(await page.locator('#payment-preparation-status').count(), 0);
  assert.equal(await page.locator('#modal').evaluate(dialog => dialog.open), false);

  stage = 'late ordinary payment preview cannot revive a cancelled review';
  await app.evaluate(() => { globalThis.rsaUiIgnoreCancellation = true; });
  await startReview('payment');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await finishReview(paymentReview);
  assert.equal(await page.locator('#modal').evaluate(dialog => dialog.open), false);
  assert.equal(await page.getByRole('button', { name: 'Confirm & send', exact: true }).count(), 0);
  await app.evaluate(() => { globalThis.rsaUiIgnoreCancellation = false; });

  stage = 'failed ordinary payment preparation replaces waiting with an actionable error';
  await startReview('payment');
  await app.evaluate(() => { globalThis.rsaUiPending.reject(new Error('Insufficient verified funds')); globalThis.rsaUiPending = null; });
  await page.getByRole('heading', { name: 'Could not prepare your payment.', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#modal-error').textContent(), /Insufficient verified funds/);
  assert.equal(await page.locator('#payment-preparation-status').count(), 0);
  await page.getByRole('button', { name: 'Back to form', exact: true }).click();

  stage = 'completed ordinary payment preparation opens its explicit review';
  await startReview('payment'); await finishReview(paymentReview);
  await page.getByRole('heading', { name: 'One final look.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Confirm & send', exact: true }).isEnabled(), true);
  assert.match(await page.locator('#modal').textContent(), /isolated-payment-recipient/);
  await page.screenshot({ path: path.join(screenshots, 'payment-review.png') });
  await page.getByRole('button', { name: 'Go back', exact: true }).click();

  stage = 'use all balance preserves exact connects and persists the checked option';
  const preciseBalance = '9007199.2547409999';
  await app.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', state),
    { ...snapshot, wallet: { ...snapshot.wallet, balance: { available: preciseBalance } } });
  await page.waitForFunction(() => document.querySelector('.send-amount-field').textContent.includes('9,007,199.2547409999 CONN'));
  await page.getByRole('button', { name: 'Use all balance', exact: true }).click();
  assert.equal(await page.locator('#send-amount').inputValue(), preciseBalance);
  assert.equal(await page.getByRole('checkbox', { name: 'Deduct fees from payment' }).isChecked(), true);
  assert.equal(await page.locator('#modal').evaluate(dialog => dialog.open), false);
  assert.equal(await app.evaluate(() => globalThis.rsaUiPending), null);
  await preparationState(null);
  await page.waitForFunction(() => document.querySelector('.send-amount-field').textContent.includes('Available: 10 CONN'));
  await page.locator('[data-view="overview"]').first().click();
  await page.locator('[data-view="send"]').first().click();
  assert.equal(await page.locator('#send-amount').inputValue(), preciseBalance);
  assert.equal(await page.locator('#send-subtract-fee').isChecked(), true);
  await page.locator('#send-subtract-fee').uncheck();
  await page.locator('#send-amount').fill('3');
  await startReview('payment');
  assert.equal(await app.evaluate(() => globalThis.rsaUiPaymentInput.subtractFeeFromAmount), false);
  await finishReview(paymentReview);
  await page.getByRole('button', { name: 'Go back', exact: true }).click();

  stage = 'deducted payment review distinguishes requested amount, net received and wallet debit';
  await page.getByRole('button', { name: 'Use all balance', exact: true }).click();
  await startReview('payment');
  assert.equal(await app.evaluate(() => globalThis.rsaUiPaymentInput.amount), '10');
  assert.equal(await app.evaluate(() => globalThis.rsaUiPaymentInput.subtractFeeFromAmount), true);
  await finishReview({ ...paymentReview, amount: '9.9999', requestedAmount: '10', total: '10', subtractFeeFromAmount: true });
  for (const [label, amount] of [['Entered amount', '10 CONN'], ['Recipient receives', '9.9999 CONN'], ['Network fee · deducted', '0.0001 CONN'], ['Total from your wallet', '10 CONN']]) {
    assert.equal(await page.locator('.review-line').filter({ has: page.locator('dt', { hasText: label }) }).locator('dd').textContent(), amount);
  }
  await page.screenshot({ path: path.join(screenshots, 'payment-deduct-fee-review.png') });
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await page.screenshot({ path: path.join(screenshots, 'payment-use-all-balance.png') });

  stage = 'review explains a small deduction used to keep change spendable';
  await startReview('payment');
  await finishReview({ ...paymentReview, amount: '9.9998999999', requestedAmount: '10', total: '9.9999999999', subtractFeeFromAmount: true, changeAdjustment: '0.0000000001' });
  assert.equal(await page.locator('.review-line').filter({ has: page.locator('dt', { hasText: 'Kept as spendable change' }) }).locator('dd').textContent(), '0.0000000001 CONN');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();

  stage = 'unavailable and zero balances cannot be used as an automatic amount';
  for (const available of [undefined, null, '0', '0.0000000000', '-1', 'NaN', '100000000.0000000001']) {
    await app.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', state),
      { ...snapshot, wallet: { ...snapshot.wallet, balance: { available } } });
    await page.waitForFunction(() => document.querySelector('[data-action="use-all-balance"]').disabled);
    assert.equal(await page.locator('#send-amount').inputValue(), '10');
    assert.equal(await page.locator('#modal').evaluate(dialog => dialog.open), false);
  }
  await preparationState(null);
  await page.waitForFunction(() => !document.querySelector('[data-action="use-all-balance"]').disabled);

  stage = 'pasted payment links and addresses clear stale fee deduction intent without reading the real clipboard';
  await app.evaluate(({ clipboard }, moduleUrl) => {
    const { WalletService } = process.getBuiltinModule('module').createRequire(moduleUrl)(process.getBuiltinModule('url').fileURLToPath(moduleUrl));
    globalThis.rsaUiPasteOriginals = { assertSession: WalletService.prototype.assertSession, parse: WalletService.prototype.parseClipboardPaymentRequest, readText: clipboard.readText };
    WalletService.prototype.assertSession = function () {};
    WalletService.prototype.parseClipboardPaymentRequest = function () { return globalThis.rsaUiPasteFixture; };
    clipboard.readText = async () => 'isolated-clipboard-fixture';
  }, serviceModuleUrl);
  for (const kind of ['uri', 'address']) {
    await page.getByRole('button', { name: 'Use all balance', exact: true }).click();
    await app.evaluate((_electron, fixture) => { globalThis.rsaUiPasteFixture = fixture; },
      { kind, address: `isolated-${kind}-recipient`, amount: '3', label: '', message: '', ignoredParameters: [] });
    await page.getByRole('button', { name: 'Paste link or address', exact: true }).click();
    await page.waitForFunction(kind => document.querySelector('#send-address').value === `isolated-${kind}-recipient`, kind);
    assert.equal(await page.locator('#send-subtract-fee').isChecked(), false);
    assert.equal(await page.locator('#send-amount').inputValue(), kind === 'uri' ? '3' : '10');
  }
  await app.evaluate(({ clipboard }, moduleUrl) => {
    const { WalletService } = process.getBuiltinModule('module').createRequire(moduleUrl)(process.getBuiltinModule('url').fileURLToPath(moduleUrl));
    WalletService.prototype.assertSession = globalThis.rsaUiPasteOriginals.assertSession;
    WalletService.prototype.parseClipboardPaymentRequest = globalThis.rsaUiPasteOriginals.parse;
    clipboard.readText = globalThis.rsaUiPasteOriginals.readText;
  }, serviceModuleUrl);

  stage = 'use all balance and fee deduction also apply to public bounty rewards';
  await page.getByRole('button', { name: 'Create a bounty', exact: true }).click();
  await page.getByRole('button', { name: 'Use all balance', exact: true }).click();
  await startReview();
  assert.equal(await app.evaluate(() => globalThis.rsaUiPaymentInput.subtractFeeFromAmount), true);
  assert.equal(await app.evaluate(() => globalThis.rsaUiPaymentInput.amount), '10');
  await finishReview({ amount: '9.9999', requestedAmount: '10', total: '10', subtractFeeFromAmount: true, signatureAlgorithmsMask: 6, rsaProbeStatus: 'verified' });
  assert.equal(await page.locator('.review-line').filter({ has: page.locator('dt', { hasText: 'Public reward' }) }).locator('dd').textContent(), '9.9999 CONN');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await page.getByRole('button', { name: 'Create a bounty', exact: true }).click();

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
    }, { moduleUrl: serviceModuleUrl, snapshot });
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
  console.log(`RSA UI timings: ${JSON.stringify({ ...timings, source: target.endsWith('.asar') ? 'ASAR' : 'source' })}`);
}
if (passed) console.log(`PASS: payment and RSA preparation, funding/signing progress with stable focus, real IPC cancellation, Escape/close, late-reply rejection, preparation failure, exact use-all balance, fee deduction controls and net/gross/change review, clipboard intent reset, RSA policy checks, keyboard/button locking during pending work and graceful shutdown. Screenshots: ${screenshots}`);
