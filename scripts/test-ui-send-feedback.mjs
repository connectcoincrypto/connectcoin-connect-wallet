// Real Electron/preload feedback checks with synthetic service results. The
// service stays sessionless: no keys, transactions or remote RPC are involved.
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeElectronTest } from './ui-close.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] ?? root);
const serviceModuleUrl = pathToFileURL(path.join(target, 'src/core/wallet-service.mjs')).href;
const profile = await mkdtemp(path.join(tmpdir(), 'connectwallet-send-feedback-'));
await writeFile(path.join(profile, 'config.json'), JSON.stringify({ version: 1, network: 'main', rpc: { host: '127.0.0.1', port: 1 } }));
const env = { ...process.env, CONNECTWALLET_TEST_PROFILE: profile, CONNECTWALLET_NETWORK: 'main' };
delete env.ELECTRON_RUN_AS_NODE;
const txid = 'ab'.repeat(32);
const address = 'synthetic-public-recipient';
const errors = [];
let application, page, passed = false;
let stage = 'launch isolated Electron';

async function configure(mode, { hold = false } = {}) {
  await application.evaluate((_electron, options) => {
    const fixture = globalThis.sendFeedbackFixture;
    fixture.mode = options.mode;
    fixture.entered = false;
    fixture.failNextGetState = false;
    fixture.gate = options.hold ? new Promise(resolve => { fixture.release = resolve; }) : null;
  }, { mode, hold });
}
async function review({ waitForReview = true } = {}) {
  await page.locator('[data-view="send"]').first().click();
  await page.locator('#send-address').fill(address);
  await page.locator('#send-amount').fill('1.25');
  if (!await page.locator('#send-metadata').evaluate(details => details.open)) await page.locator('#send-metadata summary').click();
  await page.locator('#send-label').fill('Synthetic local note');
  await page.locator('#send-subtract-fee').check();
  await page.getByRole('button', { name: 'Review payment', exact: true }).click();
  if (!waitForReview) return;
  await page.getByRole('heading', { name: 'One final look.', exact: true }).waitFor();
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
}
async function confirm() {
  await page.locator('[data-action="confirm-send"]').click();
  await expect.poll(() => application.evaluate(() => globalThis.sendFeedbackFixture.entered)).toBe(true);
}
async function idle() { await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false'); }
async function startRecovery({ fail = false } = {}) {
  await application.evaluate((_electron, fail) => {
    const fixture = globalThis.sendFeedbackFixture;
    fixture.recoveryEntered = false;
    fixture.recoveryFailure = fail;
    fixture.recoveryGate = new Promise(resolve => { fixture.releaseRecovery = resolve; });
  }, fail);
  await page.locator('[data-view="settings"]').first().click();
  await page.getByRole('button', { name: 'View recovery phrase', exact: true }).click();
  await page.locator('#recovery-password').fill('synthetic-password-never-used');
  await page.getByRole('button', { name: 'Reveal words', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.sendFeedbackFixture.recoveryEntered)).toBe(true);
}
async function setHidden(hidden) {
  // Playwright keeps its page visible even when the native window minimizes.
  // Model the browser's visibility event explicitly; the actual renderer,
  // recovery IPC boundary and delayed response remain under test.
  await page.evaluate(hidden => {
    if (hidden) Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    else delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}
async function publishState({ locked = false, newEpoch = false } = {}) {
  await application.evaluate(({ BrowserWindow }, options) => {
    const fixture = globalThis.sendFeedbackFixture;
    fixture.state.phase = options.locked ? 'locked' : 'unlocked';
    if (options.newEpoch) fixture.state.securityEpoch++;
    const snapshot = fixture.prototype.getState.call(fixture.service);
    BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', snapshot);
  }, { locked, newEpoch });
}

try {
  application = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [target], env, timeout: 30000 });
  const runtime = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath() }));
  assert.equal(runtime.packaged, false, 'Use development Electron so the isolated profile override is honored.');
  assert.equal(path.resolve(runtime.profile), path.resolve(profile), 'Refuse to test outside the isolated profile.');
  assert.equal(path.resolve(runtime.appPath), target, 'Mock the application that is actually under test.');
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.name));
  await page.getByRole('heading', { name: 'Hello, connection.', exact: true }).waitFor();
  await application.evaluate((_electron, options) => {
    const modulePath = process.getBuiltinModule('node:url').fileURLToPath(options.moduleUrl);
    const { WalletService } = process.getBuiltinModule('node:module').createRequire(options.moduleUrl)(modulePath);
    const prototype = WalletService.prototype;
    const fixture = { prototype, originals: {}, state: null, service: null, confirmations: [], preview: null,
      mode: 'failure', entered: false, failNextGetState: false, txid: options.txid, previewCalls: 0, previewCompleted: 0 };
    for (const method of ['getState', 'previewSend', 'confirmSend', 'getRecoveryPhrase', 'saveConfig']) fixture.originals[method] = prototype[method];
    prototype.getState = function () {
      fixture.service = this;
      if (fixture.failNextGetState) {
        fixture.failNextGetState = false;
        throw new Error('Isolated post-submission refresh failure.');
      }
      if (!fixture.state) {
        fixture.state = fixture.originals.getState.call(this);
        fixture.state.phase = 'unlocked';
        fixture.state.securityEpoch = 100;
        fixture.state.network = { ...fixture.state.network, status: 'connected' };
        fixture.state.wallet = { name: 'Synthetic feedback fixture', address: 'synthetic-public-receiving-address',
          balance: { available: '10', confirmed: '10', pending: '0', immature: '0' }, addressCount: 1 };
      }
      return { ...structuredClone(fixture.state), config: structuredClone(this.config),
        wallet: fixture.state.phase === 'unlocked' ? structuredClone(fixture.state.wallet) : null };
    };
    prototype.previewSend = async function (payload) {
      fixture.previewCalls++;
      if (fixture.state.phase !== 'unlocked') throw new Error('Wallet is locked or changed.');
      fixture.preview = { previewId: `synthetic-review-${fixture.confirmations.length}`, txid: fixture.txid,
        type: 'payment', address: payload.address, amount: '1.249999', requestedAmount: payload.amount,
        fee: '0.000001', total: payload.amount, subtractFeeFromAmount: payload.subtractFeeFromAmount,
        label: payload.label, message: payload.message };
      if (fixture.previewGate) await fixture.previewGate;
      fixture.previewCompleted++;
      return fixture.preview;
    };
    prototype.confirmSend = async function (payload) {
      const preview = fixture.preview;
      fixture.preview = null;
      if (!preview || payload.previewId !== preview.previewId) throw new Error('Payment review expired. Review the payment again.');
      fixture.confirmations.push(payload);
      fixture.entered = true;
      const mode = fixture.mode;
      if (fixture.gate) await fixture.gate;
      if (mode === 'failure') throw new Error('Isolated encrypted save failed. No transaction was sent.');
      if (mode === 'uncertain') throw Object.assign(new Error(`Broadcast was not confirmed. Check transaction ${fixture.txid} before trying again.`),
        { unknownOutcome: true, txid: fixture.txid });
      if (mode === 'success-refresh-failure') fixture.failNextGetState = true;
      return { txid: fixture.txid, status: 'submitted' };
    };
    prototype.getRecoveryPhrase = async function () {
      fixture.recoveryEntered = true;
      if (fixture.recoveryGate) await fixture.recoveryGate;
      if (fixture.recoveryFailure) throw new Error('Synthetic recovery verification failed.');
      return { mnemonic: 'public-fixture-word '.repeat(12).trim() };
    };
    prototype.saveConfig = async function (payload) {
      if (fixture.preferenceGate) {
        fixture.preferenceEntered = true;
        await fixture.preferenceGate;
      }
      return fixture.originals.saveConfig.call(this, payload);
    };
    globalThis.sendFeedbackFixture = fixture;
  }, { moduleUrl: serviceModuleUrl, txid });
  await page.reload();
  await page.locator('[data-view="send"]').first().waitFor();

  stage = 'network and paginated output progress keep Cancel usable and discard a cancelled late preview';
  await application.evaluate(() => {
    const fixture = globalThis.sendFeedbackFixture;
    fixture.previewGate = new Promise(resolve => { fixture.releasePreview = resolve; });
  });
  await review({ waitForReview: false });
  await expect.poll(() => application.evaluate(() => globalThis.sendFeedbackFixture.previewCalls)).toBe(1);
  await expect(page.locator('#modal-title')).toHaveText('Preparing your payment.');
  await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'true');
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.focus();
  await page.evaluate(() => { window.sendFeedbackCancelControl = document.querySelector('[data-action="cancel-send-review"]'); });
  for (const [progress, expected] of [
    [{ stage: 'network', completed: 0, total: 0 }, 'Checking the network…'],
    [{ stage: 'outputs', completed: 0, total: 42, pages: 0 }, 'Checking spendable outputs: 0 of 42 addresses checked (0 pages received)…'],
    [{ stage: 'outputs', completed: 0, total: 42, pages: 1 }, 'Checking spendable outputs: 0 of 42 addresses checked (1 pages received)…'],
    [{ stage: 'outputs', completed: 3, total: 42, pages: 8 }, 'Checking spendable outputs: 3 of 42 addresses checked (8 pages received)…'],
  ]) {
    await application.evaluate(({ BrowserWindow }, progress) => {
      const fixture = globalThis.sendFeedbackFixture;
      fixture.state.paymentPreparation = progress;
      BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', fixture.prototype.getState.call(fixture.service));
    }, progress);
    await expect(page.locator('#payment-preparation-status')).toHaveText(expected);
    await expect(cancel).toBeVisible();
    await expect(cancel).toBeEnabled();
    assert.equal(await page.evaluate(() => window.sendFeedbackCancelControl === document.querySelector('[data-action="cancel-send-review"]')
      && window.sendFeedbackCancelControl === document.activeElement), true,
    'Progress must preserve the focused Cancel control rather than rebuild the dialog.');
  }
  await cancel.click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await application.evaluate(() => {
    const fixture = globalThis.sendFeedbackFixture;
    fixture.state.paymentPreparation = null;
    fixture.previewGate = null;
    fixture.releasePreview();
    fixture.releasePreview = null;
  });
  await expect.poll(() => application.evaluate(() => globalThis.sendFeedbackFixture.previewCompleted)).toBe(1);
  await idle();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('[data-action="confirm-send"]')).toHaveCount(0);
  await expect(page.locator('#view-error')).toBeHidden();
  await expect(page.locator('#send-amount')).toHaveValue('1.25');
  await expect(page.locator('#send-label')).toHaveValue('Synthetic local note');
  assert.equal(await application.evaluate(() => globalThis.sendFeedbackFixture.confirmations.length), 0);
  console.log(`PASS: ${stage}.`);

  stage = 'consumed preview failure remains visible without a stale confirmation';
  await configure('failure');
  await review(); await confirm(); await idle();
  await expect(page.locator('#modal-title')).toHaveText('Payment submission was not completed.');
  await expect(page.locator('#modal-error')).toHaveText('Isolated encrypted save failed. No transaction was sent.');
  await expect(page.locator('[data-action="confirm-send"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check activity', exact: true })).toBeVisible();
  await publishState();
  await expect(page.locator('#modal-error')).toBeVisible();
  assert.equal(await application.evaluate(() => globalThis.sendFeedbackFixture.confirmations.length), 1);
  await page.getByRole('button', { name: 'Back to form', exact: true }).click();
  await expect(page.locator('#send-address')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('1.25');
  await expect(page.locator('#send-label')).toHaveValue('Synthetic local note');
  await expect(page.locator('#send-subtract-fee')).toBeChecked();
  console.log(`PASS: ${stage}.`);

  stage = 'uncertain broadcast metadata crosses the actual main and preload bridge';
  await page.locator('[data-view="activity"]').first().click();
  await page.locator('[data-filter="confirmed"]').click();
  await configure('uncertain');
  await review(); await confirm(); await idle();
  await expect(page.locator('#modal-title')).toHaveText('Payment status is uncertain.');
  await expect(page.locator('dialog[open]')).toContainText(txid);
  await expect(page.locator('[data-action="confirm-send"]')).toHaveCount(0);
  await application.evaluate(() => {
    const fixture = globalThis.sendFeedbackFixture;
    // An uncertain broadcast can still arrive through address history. The
    // payment-result action must not hide it behind an earlier Confirmed filter.
    fixture.state.history = [{ txid: fixture.txid, direction: 'sent', amount: '1.25', status: 'pending', confirmations: 0 }];
  });
  await publishState();
  await page.getByRole('button', { name: 'Check activity', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your activity, at a glance.', exact: true })).toBeVisible();
  await expect(page.locator(`.transaction-hash[title="${txid}"]`)).toBeVisible();
  await expect(page.locator('[data-filter="all"]')).toHaveAttribute('aria-pressed', 'true');
  assert.equal(await application.evaluate(() => globalThis.sendFeedbackFixture.confirmations.length), 2);
  console.log(`PASS: ${stage}.`);

  stage = 'submitted transaction remains confirmed when the follow-up state read fails';
  await page.locator('[data-filter="confirmed"]').click();
  await application.evaluate(() => { globalThis.sendFeedbackFixture.state.history = []; });
  await publishState();
  await configure('success-refresh-failure');
  await review(); await confirm(); await idle();
  await expect(page.locator('#modal-title')).toHaveText('Payment submitted.');
  await expect(page.locator('dialog[open]')).toContainText(txid);
  await expect(page.locator('#modal-error')).toContainText(/refresh/i);
  await expect(page.locator('[data-action="confirm-send"]')).toHaveCount(0);
  assert.equal(await application.evaluate(() => globalThis.sendFeedbackFixture.confirmations.length), 3);
  await expect(page.locator('[data-filter="all"]')).toHaveAttribute('aria-pressed', 'true');
  await application.evaluate(() => {
    const fixture = globalThis.sendFeedbackFixture;
    fixture.state.history = [{ txid: fixture.txid, direction: 'sent', amount: '1.25', status: 'pending', confirmations: 0 }];
  });
  await publishState();
  await page.getByRole('button', { name: 'View activity', exact: true }).click();
  await expect(page.locator(`.transaction-hash[title="${txid}"]`)).toBeVisible();
  await expect(page.locator('[data-filter="all"]')).toHaveAttribute('aria-pressed', 'true');
  await application.evaluate(() => { globalThis.sendFeedbackFixture.state.history = []; });
  await publishState();
  await page.locator('[data-view="send"]').first().click();
  for (const field of ['address', 'amount', 'label', 'message']) await expect(page.locator(`#send-${field}`)).toHaveValue('');
  // The explicit receipt actions reset the filter; ordinary navigation does not.
  await page.locator('[data-view="activity"]').first().click();
  await page.locator('[data-filter="confirmed"]').click();
  await page.locator('[data-view="send"]').first().click();
  await page.locator('[data-view="activity"]').first().click();
  await expect(page.locator('[data-filter="confirmed"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-view="send"]').first().click();
  console.log(`PASS: ${stage}.`);

  for (const mode of ['success', 'failure', 'uncertain']) {
    stage = `late ${mode} after lock never reopens the outcome or exposes transaction information`;
    await configure(mode, { hold: true });
    await review(); await confirm();
    await publishState({ locked: true, newEpoch: true });
    await page.locator('#unlock-password').waitFor();
    await application.evaluate(() => globalThis.sendFeedbackFixture.release());
    await idle();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    assert.ok(!(await page.locator('body').textContent()).includes(txid));
    await expect(page.locator('#view-error')).toBeHidden();
    await publishState({ newEpoch: true });
    await page.locator('[data-view="send"]').first().waitFor();
    console.log(`PASS: ${stage}.`);
  }
  for (const mode of ['success', 'failure']) {
    stage = `late ${mode} after an unlocked security-context change never reopens the old outcome`;
    await configure(mode, { hold: true });
    await review(); await confirm();
    await publishState({ newEpoch: true });
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await application.evaluate(() => globalThis.sendFeedbackFixture.release());
    await idle();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    assert.ok(!(await page.locator('body').textContent()).includes(txid));
    await expect(page.locator('#view-error')).toBeHidden();
    for (const field of ['address', 'amount', 'label', 'message']) await expect(page.locator(`#send-${field}`)).toHaveValue('');
    console.log(`PASS: ${stage}.`);
  }
  assert.equal(await application.evaluate(() => globalThis.sendFeedbackFixture.confirmations.length), 8);

  for (const context of ['hidden', 'hidden then visible', 'Cancel', 'Close', 'Escape', 'locked', 'new wallet context']) {
    for (const fail of [false, true]) {
      stage = `pending recovery ${fail ? 'failure' : 'words'} after ${context} never revives a dismissed dialog`;
      await startRecovery({ fail });
      if (context.startsWith('hidden')) {
        await setHidden(true);
        if (context === 'hidden then visible') await setHidden(false);
      } else if (context === 'Cancel') await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      else if (context === 'Close') await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
      else if (context === 'Escape') await page.keyboard.press('Escape');
      else await publishState({ locked: context === 'locked', newEpoch: true });
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      await application.evaluate(() => globalThis.sendFeedbackFixture.releaseRecovery());
      await expect.poll(() => page.evaluate(() => document.querySelector('#app').getAttribute('aria-busy'))).toBe('false');
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      await expect(page.locator('.modal-seed-grid .seed-word')).toHaveCount(0);
      await expect(page.locator('#view-error')).toBeHidden();
      assert.ok(!(await page.locator('body').textContent()).includes('public-fixture-word'));
      if (context === 'hidden') await setHidden(false);
      if (context === 'locked') await publishState({ newEpoch: true });
      console.log(`PASS: ${stage}.`);
    }
  }

  stage = 'visible recovery still reveals only after verification and hides on visibility change';
  await startRecovery();
  await application.evaluate(() => globalThis.sendFeedbackFixture.releaseRecovery());
  await idle();
  await expect(page.locator('#modal-title')).toHaveText('For your eyes only.');
  await expect(page.locator('.modal-seed-grid .seed-word')).toHaveCount(12);
  await setHidden(true);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  assert.ok(!(await page.locator('body').textContent()).includes('public-fixture-word'));
  await setHidden(false);
  console.log(`PASS: ${stage}.`);

  stage = 'visible recovery failure remains actionable in its password dialog';
  await startRecovery({ fail: true });
  await application.evaluate(() => globalThis.sendFeedbackFixture.releaseRecovery());
  await idle();
  await expect(page.locator('#modal-title')).toHaveText('Your recovery phrase.');
  await expect(page.locator('#modal-error')).toHaveText('Synthetic recovery verification failed.');
  await expect(page.getByRole('button', { name: 'Reveal words', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  console.log(`PASS: ${stage}.`);

  await page.evaluate(() => {
    window.feedbackCompositionEvents = [];
    for (const name of ['compositionstart', 'compositionend']) document.addEventListener(name,
      () => window.feedbackCompositionEvents.push(name), { capture: true });
  });
  const compositionSession = await page.context().newCDPSession(page);
  for (const [locked, minutes, height] of [[true, 17, 345], [false, 18, 346]]) {
    stage = `${locked ? 'lock/unlock' : 'same-phase security change'} during native text composition keeps background renders and preference autosave working`;
    await page.locator('[data-view="send"]').first().click();
    await page.locator('#send-address').focus();
    await page.evaluate(() => { window.feedbackCompositionEvents = []; });
    await compositionSession.send('Input.imeSetComposition', { text: 'example', selectionStart: 7, selectionEnd: 7 });
    assert.deepEqual(await page.evaluate(() => window.feedbackCompositionEvents), ['compositionstart'],
      'The fixture must enter a real Chromium composition, not only dispatch a DOM event.');
    await publishState({ locked, newEpoch: true });
    if (locked) {
      await page.locator('#unlock-password').waitFor();
      await publishState({ newEpoch: true });
    }
    await expect(page.locator('#send-address')).toHaveValue('');
    await application.evaluate(({ BrowserWindow }, height) => {
      const fixture = globalThis.sendFeedbackFixture;
      fixture.state.network.height = height;
      BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', fixture.prototype.getState.call(fixture.service));
    }, height);
    await expect(page.locator('.bottom-strip')).toContainText(`Block ${height}`, { timeout: 3000 });
    await page.locator('[data-view="settings"]').first().click();
    await page.locator('#auto-lock').fill(String(minutes));
    await expect.poll(() => application.evaluate(() => globalThis.sendFeedbackFixture.service.config.autoLockMinutes),
      { timeout: 3000 }).toBe(minutes);
    console.log(`PASS: ${stage}.`);
  }
  await compositionSession.detach();

  stage = 'locking during preference flush prevents a queued payment review from starting';
  const previewsBeforeLock = await application.evaluate(() => {
    const fixture = globalThis.sendFeedbackFixture;
    fixture.preferenceEntered = false;
    fixture.preferenceGate = new Promise(resolve => { fixture.releasePreference = resolve; });
    return fixture.previewCalls;
  });
  await page.locator('[data-view="send"]').first().click();
  await page.locator('#send-address').fill(address);
  await page.locator('#send-amount').fill('1.25');
  await page.locator('.advanced-fee summary').click();
  await page.locator('#send-fee').fill('1501');
  await page.getByRole('button', { name: 'Review payment', exact: true }).click();
  await expect.poll(() => application.evaluate(() => globalThis.sendFeedbackFixture.preferenceEntered)).toBe(true);
  await publishState({ locked: true, newEpoch: true });
  await page.locator('#unlock-password').waitFor();
  await application.evaluate(() => {
    const fixture = globalThis.sendFeedbackFixture;
    fixture.preferenceGate = null;
    fixture.releasePreference();
  });
  await idle();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('#view-error')).toBeHidden();
  assert.equal(await application.evaluate(() => globalThis.sendFeedbackFixture.previewCalls), previewsBeforeLock,
    'A review queued before locking must not start after its preference write completes.');
  console.log(`PASS: ${stage}.`);

  assert.equal(await application.evaluate(() => globalThis.sendFeedbackFixture.service.session), null,
    'Feedback fixtures must never create or unlock an actual wallet.');
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  console.error(`Send feedback UI failed during ${stage}: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (application) {
    await application.evaluate(() => {
      const fixture = globalThis.sendFeedbackFixture;
      if (!fixture) return;
      fixture.release?.();
      fixture.releasePreview?.();
      fixture.releaseRecovery?.();
      fixture.releasePreference?.();
      for (const [method, original] of Object.entries(fixture.originals)) fixture.prototype[method] = original;
      delete globalThis.sendFeedbackFixture;
    }).catch(() => {});
    try { await closeElectronTest(application); }
    catch (error) { passed = false; process.exitCode = 1; console.error(error.message); }
  }
  const absolute = path.resolve(profile);
  assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
  assert.ok(path.basename(absolute).startsWith('connectwallet-send-feedback-'));
  await rm(absolute, { recursive: true, force: true });
}
if (passed) console.log('PASS: payment preparation progress and cancellation, confirmation feedback, uncertain outcomes, retained drafts, refresh errors and security-context cancellation.');
