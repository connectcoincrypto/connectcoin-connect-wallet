// Real Electron renderer load regression using presentation-only fixtures.
// The isolated profile has no wallet, keys, RPC connection or financial actions.
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/core/config.mjs';
import { closeElectronTest } from './ui-close.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'connectwallet-ui-load-'));
const config = { ...DEFAULT_CONFIG, theme: 'dark', rpc: { host: '127.0.0.1', port: 1 } };
await writeFile(path.join(profile, 'config.json'), JSON.stringify(config));
const env = { ...process.env, CONNECTWALLET_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const fixture = {
  phase: 'unlocked', setupActive: false, securityEpoch: 1,
  wallet: { name: 'Presentation fixture', address: 'test-fixture-not-an-address', balance: { available: '1.0000000001', confirmed: '1', pending: '0.0000000001' } },
  network: { chain: 'testnet4', host: '127.0.0.1', port: 1, status: 'connected', height: 60000 },
  config,
  history: Array.from({ length: 500 }, (_, index) => ({ txid: index.toString(16).padStart(64, '0'), direction: 'received', amount: index === 0 ? '0.0000000001' : '1', confirmations: 1, status: 'confirmed' })),
  claims: { enabled: true, available: 1000, sent: 0, completed: 0, attempts: 0, status: 'searching', helperAvailable: true, lastError: null },
  busy: false, error: null, diagnostics: null,
};
let application;
let page;
let stage = 'launch';
let sequence = 0;
let passed = false;
const errors = [];
const measurements = {};

async function burst(count, transientErrors = false) {
  const first = sequence + 1;
  sequence += count;
  await application.evaluate(({ BrowserWindow }, { snapshot, first, count, transientErrors }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    for (let index = first; index < first + count; index++) {
      const retrying = transientErrors && index % 4 !== 0;
      contents.send('connectwallet:state', { ...snapshot, network: { ...snapshot.network, height: 60000 + index }, claims: {
        ...snapshot.claims, sent: index, completed: index, attempts: index,
        status: retrying ? ['retrying', 'waiting', 'submitting'][index % 4 - 1] : 'searching', lastError: retrying ? 'TLS capture or proof validation failed' : null,
        lastErrorDiagnostic: false, lastErrorTransient: retrying,
      } });
    }
  }, { snapshot: fixture, first, count, transientErrors });
}
async function waitForLatest() {
  await page.waitForFunction(height => document.querySelector('.bottom-strip')?.textContent.includes(`Block ${height.toLocaleString('en-US')}`), 60000 + sequence, { timeout: 5000 });
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

try {
  const executablePath = createRequire(import.meta.url)('electron');
  application = await electron.launch({ executablePath, args: [root], env, colorScheme: null, timeout: 15000 });
  page = await application.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Hello, connection.' }).waitFor();
  await application.evaluate(({ BrowserWindow }, snapshot) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1080, 720);
    window.webContents.send('connectwallet:state', snapshot);
  }, fixture);

  stage = 'CONN monetary displays and exact precision';
  await page.getByRole('heading', { name: 'A little more connected.' }).waitFor();
  assert.equal(await page.locator('.balance-number').textContent(), '1.0000000001CONN');
  assert.deepEqual(await page.locator('.balance-detail strong').allTextContents(), ['1 CONN', '0.0000000001 CONN']);
  assert.equal(await page.locator('.activity-row .amount').first().textContent(), '+0.0000000001 CONN');
  assert.doesNotMatch(await page.locator('#app').textContent(), /\bCC\b/, 'Overview must use the CONN monetary ticker.');
  await page.locator('[data-view="send"]').first().click();
  for (const mode of ['address', 'bounty']) {
    await page.locator(`[data-send-mode="${mode}"]`).click();
    await page.getByRole('heading', { name: mode === 'bounty' ? 'Pay for a connection.' : 'Send ConnectCoin', exact: true }).waitFor();
    assert.equal(await page.locator('.input-suffix').textContent(), 'CONN');
    assert.equal(await page.locator('#send-form .field-label small').first().textContent(), 'Available: 1.0000000001 CONN');
    assert.match(await page.locator('.advanced-fee .field-help').textContent(), /10,000,000,000 connects = 1 CONN\./);
    assert.equal(await page.locator('#send-fee').inputValue(), '1500');
    assert.doesNotMatch(await page.locator('#app').textContent(), /\bCC\b/, `${mode} payment mode must use the CONN monetary ticker.`);
  }

  await page.locator('[data-view="claims"]').first().click();
  await page.getByRole('heading', { name: 'Every connection has potential.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Save/ }).count(), 0);
  await page.evaluate(() => {
    window.loadTestShellReplacements = 0;
    window.loadTestObserver = new MutationObserver(records => {
      window.loadTestShellReplacements += records.filter(record => [...record.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE && node.classList.contains('shell'))).length;
    });
    window.loadTestObserver.observe(document.querySelector('#app'), { childList: true });
    window.scrollTo(0, 160);
  });
  const scrollBefore = await page.evaluate(() => window.scrollY);
  assert.ok(scrollBefore > 50, 'Fixture must genuinely exercise a scrolled page.');

  stage = '1000-update burst';
  const burstStarted = performance.now();
  await burst(1000);
  await waitForLatest();
  measurements.burstMs = Math.round(performance.now() - burstStarted);
  measurements.shellReplacements = await page.evaluate(() => window.loadTestShellReplacements);
  assert.ok(measurements.burstMs < 5000, `Latest state took ${measurements.burstMs} ms to become visible.`);
  assert.equal(measurements.shellReplacements, 0, 'Background progress must update the existing shell without replacing it.');
  assert.equal(await page.locator('.stat-card').nth(2).locator('strong').textContent(), '1,000');
  assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - scrollBefore) <= 2, 'Background progress reset the scroll position.');

  stage = '1000 alternating transient errors';
  const beforeErrors = await page.evaluate(() => window.loadTestShellReplacements);
  await burst(1000, true); await waitForLatest();
  measurements.errorReplacements = await page.evaluate(() => window.loadTestShellReplacements) - beforeErrors;
  assert.equal(measurements.errorReplacements, 0, 'Transient claim errors must update the existing shell without replacing it.');
  assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - scrollBefore) <= 2, 'Retry warnings reset scroll.');

  stage = 'numeric caret and DOM identity survive background progress';
  // Number inputs do not expose selectionStart/selectionEnd. Type in the
  // middle, let background state render, then type again at that exact caret.
  // Out-of-range digits keep this presentation-only fixture from autosaving
  // into the real service, which intentionally has no wallet.
  await page.locator('#claims-rate').fill('1000');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('2');
  assert.equal(await page.locator('#claims-rate').inputValue(), '12000');
  await page.evaluate(() => {
    window.numericEditingField = document.querySelector('#claims-rate');
    window.numericEditingEvents = { focus: 0, blur: 0 };
    for (const type of ['focus', 'blur']) document.addEventListener(type, event => {
      if (event.target.id === 'claims-rate') window.numericEditingEvents[type]++;
    }, true);
  });
  await burst(20, true); await waitForLatest();
  for (const message of ['Presentation fixture connection alert.', null]) {
    await application.evaluate(({ BrowserWindow }, { snapshot, index, message }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', {
        ...snapshot, error: message, network: { ...snapshot.network, height: 60000 + index },
        claims: { ...snapshot.claims, sent: index, attempts: index, lastError: message, lastErrorDiagnostic: false, lastErrorTransient: false },
      });
    }, { snapshot: fixture, index: sequence, message });
    await page.waitForFunction(expected => Boolean(document.querySelector('.page-error')) === expected &&
      Boolean([...document.querySelectorAll('.form-card .notice.danger')].find(node => node.textContent.includes('Presentation fixture connection alert.'))) === expected, message !== null);
  }
  await page.keyboard.press('3');
  assert.deepEqual(await page.evaluate(() => ({
    value: document.querySelector('#claims-rate').value,
    sameNode: window.numericEditingField === document.querySelector('#claims-rate'),
    focused: document.activeElement === window.numericEditingField,
    ...window.numericEditingEvents,
  })), { value: '123000', sameNode: true, focused: true, focus: 0, blur: 0 }, 'Background progress must preserve the actual number input and its native caret without blur/refocus.');

  stage = 'navigation during a held pointer and transient errors';
  const settings = page.locator('[data-view="settings"]').first();
  const box = await settings.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => { window.loadTestPressedButton = document.querySelector('[data-view="settings"]'); });
  await burst(100, true);
  await delay(450);
  assert.equal(await page.evaluate(() => window.loadTestPressedButton.isConnected), true, 'Background state detached the pressed navigation button before pointerup.');
  await page.mouse.up();
  await page.getByRole('heading', { name: 'Make yourself at home.' }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Save/ }).count(), 0);
  await waitForLatest();

  stage = 'draft, focus, selection and scroll during updates';
  // A valid endpoint draft must not commit just because background rendering
  // replaces and refocuses the field while the user is still editing it.
  await page.locator('#rpc-host').fill('unsaved-host.example');
  await page.locator('#rpc-host').evaluate(field => field.setSelectionRange(3, 12));
  await page.evaluate(() => {
    window.editingHostField = document.querySelector('#rpc-host');
    window.hostEditingEvents = { focus: 0, blur: 0 };
    for (const type of ['focus', 'blur']) document.addEventListener(type, event => {
      if (event.target.id === 'rpc-host') window.hostEditingEvents[type]++;
    }, true);
  });
  await page.evaluate(() => window.scrollTo(0, 150));
  const settingsScroll = await page.evaluate(() => window.scrollY);
  await burst(100);
  await waitForLatest();
  assert.deepEqual(await page.locator('#rpc-host').evaluate(field => ({ value: field.value, focused: document.activeElement === field, sameNode: window.editingHostField === field, start: field.selectionStart, end: field.selectionEnd, ...window.hostEditingEvents })), {
    value: 'unsaved-host.example', focused: true, sameNode: true, start: 3, end: 12, focus: 0, blur: 0,
  });
  assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - settingsScroll) <= 2, 'Background progress moved a settings draft.');

  stage = 'unchanged page retains DOM identity';
  const unchangedBefore = await page.evaluate(() => {
    window.loadTestUnchangedField = document.querySelector('#rpc-host');
    return window.loadTestShellReplacements;
  });
  await application.evaluate(({ BrowserWindow }, { snapshot, index }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', {
      ...snapshot, network: { ...snapshot.network, height: 60000 + index },
      claims: { ...snapshot.claims, sent: index + 1, completed: index + 1, attempts: index + 1 },
    });
  }, { snapshot: fixture, index: sequence });
  await delay(450);
  assert.equal(await page.evaluate(() => window.loadTestUnchangedField.isConnected), true, 'Claim-only progress rebuilt an unchanged settings page.');
  assert.equal(await page.evaluate(() => window.loadTestShellReplacements), unchangedBefore);

  stage = 'lock supersedes pending progress';
  // The service behind this presentation fixture has no wallet. Leave an
  // invalid draft so intentional blur cannot commit and replace the fixture.
  await page.locator('#rpc-host').fill('unfinished-host.example/');
  const claimsBox = await page.locator('[data-view="claims"]').first().boundingBox();
  assert.ok(claimsBox);
  await page.mouse.move(claimsBox.x + claimsBox.width / 2, claimsBox.y + claimsBox.height / 2);
  await page.mouse.down();
  await burst(100);
  const locked = { ...fixture, phase: 'locked', securityEpoch: 2, wallet: null, history: [], claims: { enabled: false }, diagnostics: null };
  await application.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', snapshot), locked);
  // Still held: security transitions must not wait for the pointer to finish.
  await page.locator('#unlock-password').waitFor({ timeout: 1000 });
  assert.equal(await page.locator('.shell').count(), 0);
  await page.mouse.up();
  await delay(250);
  assert.equal(await page.locator('#unlock-password').count(), 1);
  assert.equal(await page.locator('.shell').count(), 0, 'A pending unlocked frame resurfaced after lock.');
  assert.equal(await page.locator('#rpc-host').count(), 0);
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  console.error(`UI load test failed during ${stage}: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try { Object.assign(measurements, await closeElectronTest(application)); }
  catch { passed = false; process.exitCode = 1; console.error('Load UI graceful shutdown failed.'); }
  // Only remove the exact temporary profile created above, never user data.
  const absolute = path.resolve(profile);
  assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
  assert.ok(path.basename(absolute).startsWith('connectwallet-ui-load-'));
  await rm(absolute, { recursive: true, force: true });
  if (!passed) console.error(`Load metrics: ${JSON.stringify(measurements)}`);
}
if (passed) console.log(`PASS: CONN overview/Send/bounty displays with exact precision, isolated renderer load, 500 history rows, 1000-update burst (${measurements.burstMs} ms; ${measurements.shellReplacements} shell replacements), 1000 transient errors (${measurements.errorReplacements} replacements), native numeric caret and input identity without blur/refocus, held-pointer navigation, text selection and scroll retention, unchanged-page DOM identity, immediate lock over pending progress and graceful shutdown (${measurements.closeMs} ms). No wallet or RPC used.`);
