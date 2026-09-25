// Real Electron/preload/service/vault UI smoke test. RPC uses an empty local
// fixture; no remote servers, user wallets, clipboard, or live coins are touched.
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { GENESIS } from '../src/core/config.mjs';
import { diagnosticError } from '../src/core/diagnostics.mjs';
import { createRequire } from 'node:module';
import { waitForUiCondition } from './ui-wait.mjs';
import { closeElectronTest } from './ui-close.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'connectwallet-ui-test-'));
const screenshots = await mkdtemp(path.join(tmpdir(), 'connectwallet-ui-screens-'));
const tip = { chain: 'testnet4', height: 0, hash: GENESIS.testnet4, genesis_hash: GENESIS.testnet4, mediantime: 1780000000 };
const requests = [];
const sockets = new Set();
let connectionCount = 0;
let failNextHistory = false;
const serve = socket => {
  connectionCount++;
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy());
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const { method, id, params = {} } = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      requests.push(method);
      if (method === 'getaddresshistory' && failNextHistory) {
        failNextHistory = false;
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Index not ready. private-remote-diagnostic-canary' } })}\n`);
        continue;
      }
      let result;
      if (method === 'getchaintip') result = tip;
      else if (['subscribetip', 'subscribebounties', 'subscribeaddress'].includes(method)) result = { subscription_id: `${method}:${params.address ?? ''}`, tip, cursor: 'ui-empty-journal' };
      else if (method === 'unsubscribe') result = { removed: true };
      else if (method === 'getaddressbalance') result = { tip, address: params.address, unit: 'connects', confirmed: '0', available_confirmed: '0', pending_delta: '0', immature: '0' };
      else if (['getaddresshistory', 'getaddressutxos'].includes(method)) result = { tip, address: params.address, unit: 'connects', items: [], next_cursor: null };
      else { socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported fixture method' } })}\n`); continue; }
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    }
  });
};
const fixture = net.createServer(serve);
const alternateFixture = net.createServer(serve);
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => alternateFixture.listen(0, '127.0.0.1', resolve));
await writeFile(path.join(profile, 'config.json'), JSON.stringify({ version: 1, network: 'testnet4', rpc: { host: '127.0.0.1', port: fixture.address().port }, autoLockMinutes: 15 }));
let application;
let page;
const errors = [];
const failedBrandRequests = [];
let stage = 'launch';
let passed = false;
let seed = [];
const password = 'UI-test-only-long-password';
const env = { ...process.env, CONNECTWALLET_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;

async function openApplication(executablePath) {
  // Disable Playwright's default forced-light emulation so this test observes
  // Electron nativeTheme and the real application color-scheme behavior.
  application = await electron.launch({ executablePath, args: [root], env, colorScheme: null, timeout: 30000 });
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.name));
  page.on('requestfailed', request => {
    if (request.url().endsWith('/assets/icon.png')) failedBrandRequests.push(request.failure()?.errorText ?? 'Image request failed');
  });
  await page.getByRole('heading', { name: 'Hello, connection.' }).waitFor();
  assert.equal(await page.title(), 'ConnectWallet · ConnectCoin');
  assert.equal(await application.evaluate(({ app }) => app.getName()), 'ConnectWallet');
  assert.equal(await page.locator('.auth-art .brand strong').textContent(), 'ConnectWallet');
  await assertLoadedImage('.auth-art .brand-mark img');
}
async function assertLoadedImage(selector) {
  // A visible <img> with a cancelled file:// request still occupies its box.
  // Verify decoded pixels, not only DOM presence or a plausible source URL.
  await page.waitForFunction(value => {
    const images = [...document.querySelectorAll(value)];
    return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }, selector);
}
async function waitForScheme(dark) {
  await page.waitForFunction(expected => matchMedia('(prefers-color-scheme: dark)').matches === expected, dark);
  // Allow the media-query style recalculation and the next paint to complete.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function selectTheme(theme, { ui = false } = {}) {
  if (ui) await page.locator('#theme-preference').selectOption(theme);
  else await page.evaluate(value => window.connectwallet.invoke('setTheme', { theme: value }), theme);
  await waitForUiCondition(page, async value => (await window.connectwallet.invoke('getState')).config.theme === value && document.documentElement.dataset.theme === value && document.querySelector('#app')?.getAttribute('aria-busy') !== 'true', theme, { message: 'The saved appearance and idle renderer must match the requested theme.' });
  // Observed Electron runs sometimes expose the new config/CSS just before the
  // native getter agrees. Verify convergence, without assuming its cause or
  // relaxing the requested-value assertion after this bounded wait.
  const deadline = Date.now() + 1000;
  let nativeSource = await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
  while (nativeSource !== theme && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
    nativeSource = await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
  }
  assert.equal(nativeSource, theme, `Native appearance must match the saved preference (${theme}).`);
  await waitForScheme(await application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors));
  assert.equal(JSON.parse(await readFile(path.join(profile, 'config.json'), 'utf8')).theme, theme);
}

async function toggleDeveloperMode(enabled) {
  await page.locator('[data-view="settings"]').first().click();
  await page.getByRole('switch', { name: 'Developer Mode', exact: true }).click();
  await waitForUiCondition(page, async value => (await window.connectwallet.invoke('getState')).config.developerMode === value && document.querySelector('#developer-mode')?.getAttribute('aria-checked') === String(value) && document.querySelector('#app')?.getAttribute('aria-busy') !== 'true', enabled, { message: 'The saved Developer Mode and idle switch must match the requested boolean.' });
  const persisted = JSON.parse(await readFile(path.join(profile, 'config.json'), 'utf8')).developerMode;
  assert.equal(persisted, enabled, `Developer Mode persistence mismatch (expected=${enabled}, persisted=${typeof persisted === 'boolean' ? persisted : typeof persisted}).`);
}

async function pressEnterInPreference(selector) {
  await page.locator(selector).focus();
  await page.evaluate(selector => {
    window.preferenceEnterField = document.querySelector(selector);
    window.preferenceEnterSubmitCount = 0;
    window.preferenceEnterListener = event => {
      if (['claims-form', 'settings-form'].includes(event.target.id)) window.preferenceEnterSubmitCount++;
    };
    document.addEventListener('submit', window.preferenceEnterListener, true);
  }, selector);
  await page.keyboard.press('Enter');
}

async function assertPreferenceEnterStayedPut(selector) {
  assert.deepEqual(await page.evaluate(selector => {
    document.removeEventListener('submit', window.preferenceEnterListener, true);
    return {
      submits: window.preferenceEnterSubmitCount,
      sameNode: window.preferenceEnterField === document.querySelector(selector),
      focused: document.activeElement === window.preferenceEnterField,
    };
  }, selector), { submits: 0, sameNode: true, focused: true }, 'Enter in an autosaved preference must not submit a form, reload the page, or replace/focus another control.');
}

let presentationSequence = 0;
async function showClaimPresentation({ message, diagnostic, enabled, pageError = null, category = null, transient = false, diagnosticRows = null }) {
  // Renderer-only fixtures: no real claims, helper calls or broadcasts. Core
  // tests separately verify how structured rejection codes set this flag.
  const snapshot = await page.evaluate(() => window.connectwallet.invoke('getState'));
  const status = `presentation-check-${++presentationSequence}`;
  snapshot.claims = { ...snapshot.claims, lastError: message, lastErrorDiagnostic: diagnostic,
    lastErrorCategory: category, lastErrorTransient: transient, enabled, status };
  snapshot.error = pageError;
  if (diagnosticRows !== null) snapshot.diagnostics = { status: 'ready', file: '', dropped: 0, ...snapshot.diagnostics, recent: diagnosticRows };
  await application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', value), snapshot);
  await page.waitForFunction(expected => document.querySelector('.status-badge')?.textContent === expected, status);
}

try {
  // Electron 44 may download its runtime lazily. Resolve it before starting
  // Playwright's launch deadline, so a cold install is not a false UI timeout.
  const executablePath = createRequire(import.meta.url)('electron');
  await openApplication(executablePath);
  // Screenshots are deliberately limited to screens with no recovery words.
  await page.getByRole('heading', { name: 'Hello, connection.' }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'welcome.png') });
  assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process, Object.isFrozen(window.connectwallet)]), ['undefined', 'undefined', true]);
  assert.equal(await page.evaluate(() => window.connectwallet.invoke('getblocktemplate').then(() => false, () => true)), true);

  stage = 'system appearance and startup persistence';
  assert.equal((await page.evaluate(() => window.connectwallet.invoke('getState'))).config.theme, 'system');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'system');
  assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'system');
  await waitForScheme(await application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors));
  // Drive Electron's application-local theme source, not the operating system.
  // With config still 'system', this exercises live CSS media-query changes.
  await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await waitForScheme(true);
  const darkCanvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  await waitForScheme(false);
  const lightCanvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.notEqual(darkCanvas, lightCanvas);
  assert.equal((await page.evaluate(() => window.connectwallet.invoke('getState'))).config.theme, 'system');
  await selectTheme('dark');
  await page.reload();
  await page.getByRole('heading', { name: 'Hello, connection.' }).waitFor();
  await waitForScheme(true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), darkCanvas);
  // A fresh Electron main process must apply the saved choice before showing
  // the first window. The isolated profile contains no wallet yet.
  await closeElectronTest(application); application = null;
  await openApplication(executablePath);
  assert.equal(await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');
  await waitForScheme(true);
  assert.equal((await page.evaluate(() => window.connectwallet.invoke('getState'))).config.theme, 'dark');
  await selectTheme('system');

  stage = 'create and backup';
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  assert.equal(await page.locator('input[name="wordCount"]:checked').inputValue(), '24');
  await page.locator('input[name="wordCount"][value="12"]').check();
  await page.locator('#setup-name').fill('UI smoke test');
  await page.locator('#setup-password').fill(password);
  await page.locator('#setup-confirm').fill(password);
  assert.equal(await page.locator('#setup-password').getAttribute('minlength'), '12');
  await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await waitForScheme(true);
  assert.equal(await page.locator('#setup-name').inputValue(), 'UI smoke test');
  assert.equal(await page.locator('#setup-password').inputValue(), password);
  await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });
  await page.getByRole('button', { name: 'Create recovery phrase' }).click();
  await page.getByRole('heading', { name: 'These words are your wallet.' }).waitFor();
  assert.equal(await page.locator('.seed-word').count(), 12);
  // OS lock/setup expiry may retain phase='welcome'. A security epoch change
  // must still clear the in-progress phrase and every setup/password field.
  await page.evaluate(() => window.connectwallet.invoke('lock'));
  await page.getByRole('heading', { name: 'Hello, connection.' }).waitFor();
  assert.equal(await page.locator('.seed-word').count(), 0);
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  await page.locator('input[name="wordCount"][value="12"]').check();
  await page.locator('#setup-name').fill('UI smoke test');
  await page.locator('#setup-password').fill(password);
  await page.locator('#setup-confirm').fill(password);
  await page.getByRole('button', { name: 'Create recovery phrase' }).click();
  await page.getByRole('heading', { name: 'These words are your wallet.' }).waitFor();
  seed = await page.locator('.seed-word').evaluateAll(nodes => nodes.map(node => node.lastChild.textContent.trim()));
  assert.equal(await page.locator('[data-action="copy-seed"]').count(), 0);
  await page.locator('#backup-ack').check();
  await page.getByRole('button', { name: 'Verify my backup' }).click();
  const indexes = await page.locator('#verify-form input').evaluateAll(nodes => nodes.map(node => Number(node.name.slice(5))));
  assert.equal(indexes.length, 3);
  assert.equal(new Set(indexes).size, 3);
  for (const index of indexes) await page.locator(`#check-${index}`).fill(seed[index]);
  await page.getByRole('button', { name: 'Open my wallet' }).click();
  await page.getByRole('heading', { name: 'A little more connected.' }).waitFor();
  await waitForUiCondition(page, async () => {
    const state = await window.connectwallet.invoke('getState');
    return state.network.status === 'online' && !state.busy && state.wallet?.balance?.available === '0';
  });
  assert.equal(await page.locator('.seed-word').count(), 0);
  assert.equal(await page.locator('.sidebar .brand strong').textContent(), 'ConnectWallet');
  await assertLoadedImage('.sidebar .brand-mark img');
  await assertLoadedImage('.coin-mark img');
  await page.screenshot({ path: path.join(screenshots, 'overview.png') });

  stage = 'automatic settings persistence and appearance preserve invalid drafts';
  await page.locator('[data-view="settings"]').first().click();
  assert.equal(await page.getByRole('button', { name: /^Save/ }).count(), 0, 'Settings should expose autosave without a manual Save button.');
  assert.equal(await page.getByRole('button', { name: 'Export wallet', exact: true }).isVisible(), true);
  assert.equal(await page.locator('#theme-preference').inputValue(), 'system');
  await page.locator('#rpc-host').fill('https://unfinished.example');
  await page.locator('#auto-lock').fill('30');
  await pressEnterInPreference('#auto-lock');
  await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.autoLockMinutes === 30);
  await assertPreferenceEnterStayedPut('#auto-lock');
  const beforeTheme = await page.evaluate(() => window.connectwallet.invoke('getState'));
  const beforeThemeConnections = connectionCount;
  await selectTheme('dark', { ui: true });
  const afterTheme = await page.evaluate(() => window.connectwallet.invoke('getState'));
  assert.equal(afterTheme.phase, 'unlocked');
  assert.equal(afterTheme.securityEpoch, beforeTheme.securityEpoch);
  assert.equal(afterTheme.wallet.address, beforeTheme.wallet.address);
  assert.equal(afterTheme.claims.enabled, beforeTheme.claims.enabled);
  assert.deepEqual(afterTheme.config.rpc, beforeTheme.config.rpc);
  assert.equal(afterTheme.config.autoLockMinutes, beforeTheme.config.autoLockMinutes);
  assert.equal(connectionCount, beforeThemeConnections);
  assert.equal(await page.locator('#rpc-host').inputValue(), 'https://unfinished.example');
  assert.equal(await page.locator('#auto-lock').inputValue(), '30');
  assert.equal(await page.locator('[data-view="settings"][aria-current="page"]').count(), 1);
  await page.screenshot({ path: path.join(screenshots, 'settings-dark.png'), fullPage: true });
  await selectTheme('light', { ui: true });
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), lightCanvas);
  assert.equal(await page.locator('#rpc-host').inputValue(), 'https://unfinished.example');
  await selectTheme('system', { ui: true });
  await selectTheme('dark', { ui: true });
  const beforeRpcConnections = connectionCount;
  await page.locator('#rpc-port').fill('');
  await page.locator('#rpc-host').fill('127.0.0.1');
  await page.locator('#rpc-port').fill(String(alternateFixture.address().port));
  assert.deepEqual((await page.evaluate(() => window.connectwallet.invoke('getState'))).config.rpc, beforeTheme.config.rpc, 'endpoint edits must stay together until leaving both fields');
  await page.locator('#auto-lock').focus();
  await waitForUiCondition(page, async expected => {
    const current = await window.connectwallet.invoke('getState');
    return current.config.rpc.port === expected && current.network.status === 'online' && !current.busy;
  }, alternateFixture.address().port);
  assert.equal(connectionCount, beforeRpcConnections + 1, 'one completed endpoint edit should reconnect once');
  const persistedSettings = JSON.parse(await readFile(path.join(profile, 'config.json'), 'utf8'));
  assert.equal(persistedSettings.autoLockMinutes, 30);
  assert.equal(persistedSettings.rpc.port, alternateFixture.address().port);
  assert.equal(await page.locator('[data-view="settings"][aria-current="page"]').count(), 1, 'RPC preferences save on leaving the fields while the Settings page stays open.');
  await page.locator('[data-view="overview"]').first().click();
  assert.equal(await page.locator('.seed-word').count(), 0);
  await page.screenshot({ path: path.join(screenshots, 'overview-dark.png') });

  stage = 'receiving and bounty form';
  await page.locator('[data-view="receive"]').first().click();
  const address = await page.locator('.address-box').textContent();
  assert.match(address, /^tcc1p[a-z0-9]+$/);
  assert.match(await page.locator('img.qr').getAttribute('src'), /^data:image\/png;base64,/);
  await assertLoadedImage('.sidebar .brand-mark img');
  await assertLoadedImage('.receive-card img.qr');
  await page.locator('[data-view="send"]').first().click();
  assert.equal(await page.getByRole('button', { name: 'Review payment', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Create a bounty', exact: true }).click();
  await page.locator('#send-domain').fill('example.com');
  await page.locator('#send-amount').fill('1');
  await page.locator('#send-expected').fill('1000');
  await page.locator('.advanced-fee summary').click();
  await page.locator('#send-fee').fill('2200');
  await page.evaluate(() => {
    window.editingFeeField = document.querySelector('#send-fee');
    window.openFeeDetails = document.querySelector('.advanced-fee');
  });
  assert.equal(await page.getByRole('button', { name: 'Review bounty' }).isVisible(), true);
  await selectTheme('light');
  assert.equal(await page.locator('#send-domain').inputValue(), 'example.com');
  await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.feeRate === 2200);
  await page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(resolve), 300)));
  assert.deepEqual(await page.evaluate(() => ({
    sameField: window.editingFeeField === document.querySelector('#send-fee'),
    sameDetails: window.openFeeDetails === document.querySelector('.advanced-fee'),
    open: document.querySelector('.advanced-fee').open,
  })), { sameField: true, sameDetails: true, open: true }, 'Saving an edited fee and applying appearance must preserve the open native details and input nodes.');
  assert.equal(await page.locator('#send-amount').inputValue(), '1');
  assert.equal(await page.locator('#send-expected').inputValue(), '1000');
  await selectTheme('dark');
  assert.equal(await page.locator('#send-domain').inputValue(), 'example.com');
  // No funds, no broadcast: verify the form only and do not create a preview.
  await page.locator('[data-view="claims"]').first().click();
  assert.equal(await page.getByRole('button', { name: /^Save/ }).count(), 0, 'Automatic claims should expose autosave without a manual Save button.');
  assert.equal(await page.locator('#claims-rate').inputValue(), '100');
  assert.equal(await page.locator('#claims-concurrent').inputValue(), '100');
  assert.equal(await page.locator('[role="switch"]').getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#claims-warning').isVisible(), false);
  stage = 'autosave acknowledgement preserves the native numeric caret';
  await page.locator('#claims-rate').fill('12');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('1');
  assert.equal(await page.locator('#claims-rate').inputValue(), '112');
  await pressEnterInPreference('#claims-rate');
  await page.evaluate(() => {
    window.editingClaimField = document.querySelector('#claims-rate');
    window.claimEditingEvents = { focus: 0, blur: 0 };
    for (const type of ['focus', 'blur']) document.addEventListener(type, event => {
      if (event.target.id === 'claims-rate') window.claimEditingEvents[type]++;
    }, true);
  });
  await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.claims.maxConnectionsPerSecond === 112);
  await assertPreferenceEnterStayedPut('#claims-rate');
  // Persistence can complete before the renderer's 200 ms state coalescing
  // timer; include that acknowledgement render before the next keystroke.
  await page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(resolve), 300)));
  await page.keyboard.press('3');
  assert.deepEqual(await page.evaluate(() => ({
    value: document.querySelector('#claims-rate').value,
    sameNode: window.editingClaimField === document.querySelector('#claims-rate'),
    focused: document.activeElement === window.editingClaimField,
    ...window.claimEditingEvents,
  })), { value: '1132', sameNode: true, focused: true, focus: 0, blur: 0 }, 'A successful autosave must preserve number-input identity and insert the next digit at the original caret.');

  stage = 'autosave errors survive updates and clear only after a successful retry';
  await application.evaluate((_electron, moduleUrl) => {
    const modulePath = process.getBuiltinModule('url').fileURLToPath(moduleUrl);
    const { WalletService } = process.getBuiltinModule('module').createRequire(moduleUrl)(modulePath);
    const original = WalletService.prototype.saveConfig;
    WalletService.prototype.saveConfig = function () {
      WalletService.prototype.saveConfig = original;
      throw new Error('Isolated autosave write failure');
    };
  }, new URL('../src/core/wallet-service.mjs', import.meta.url).href);
  await page.locator('#claims-rate').fill('110');
  await page.waitForFunction(() => document.querySelector('#view-error')?.textContent.includes('Isolated autosave write failure'));
  assert.equal((await page.evaluate(() => window.connectwallet.invoke('getState'))).config.claims.maxConnectionsPerSecond, 112);
  const errorSnapshot = await page.evaluate(() => window.connectwallet.invoke('getState'));
  errorSnapshot.claims.status = 'autosave-error-background-check';
  await application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', value), errorSnapshot);
  await page.waitForFunction(() => document.querySelector('.status-badge')?.textContent === 'autosave-error-background-check');
  assert.equal(await page.locator('#view-error').isVisible(), true);
  assert.match(await page.locator('#view-error').textContent(), /Isolated autosave write failure/);
  await page.locator('#claims-rate').fill('111');
  await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.claims.maxConnectionsPerSecond === 111 && document.querySelector('#view-error').classList.contains('hidden'));

  stage = 'successful autosave keeps unrelated action errors visible';
  failNextHistory = true;
  await page.getByRole('button', { name: 'Refresh wallet', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#view-error').classList.contains('hidden') && document.querySelector('#app').getAttribute('aria-busy') === 'false');
  const actionError = await page.locator('#view-error').textContent();
  assert.ok(actionError.length > 0);
  await page.locator('#claims-rate').fill('109');
  await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.claims.maxConnectionsPerSecond === 109);
  await page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(resolve), 300)));
  assert.equal(await page.locator('#view-error').isVisible(), true);
  assert.equal(await page.locator('#view-error').textContent(), actionError);
  await page.getByRole('button', { name: 'Refresh wallet', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#view-error').classList.contains('hidden') && document.querySelector('#app').getAttribute('aria-busy') === 'false');

  stage = 'automatic claim limits and invalid drafts';
  await page.locator('#claims-rate').fill('101');
  assert.equal(await page.locator('#claims-warning').isVisible(), true);
  assert.equal(await page.locator('[role="switch"]').getAttribute('aria-checked'), 'false');
  await page.locator('#claims-concurrent').fill('77');
  await page.locator('#claims-lookback').fill('345');
  await page.locator('[data-view="activity"]').first().click();
  await waitForUiCondition(page, async () => {
    const { config } = await window.connectwallet.invoke('getState');
    return config.claims.maxConnectionsPerSecond === 101 && config.claims.maxConcurrent === 77 && config.claims.lookbackBlocks === 345;
  });
  await page.reload();
  await page.locator('[data-view="claims"]').first().click();
  assert.equal(await page.locator('#claims-rate').inputValue(), '101');
  assert.equal(await page.locator('#claims-concurrent').inputValue(), '77');
  assert.equal(await page.locator('#claims-lookback').inputValue(), '345');
  await page.locator('#claims-rate').fill('');
  await page.locator('#claims-concurrent').fill('999');
  await page.locator('#claims-lookback').fill('0');
  await page.locator('[data-view="overview"]').first().click();
  const invalidClaims = (await page.evaluate(() => window.connectwallet.invoke('getState'))).config.claims;
  assert.deepEqual(invalidClaims, { enabled: false, maxConnectionsPerSecond: 101, maxConcurrent: 77, lookbackBlocks: 345 });
  await page.reload();
  await page.locator('[data-view="claims"]').first().click();
  await page.getByRole('switch', { name: 'Enable automatic claims' }).click();
  await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.claims.enabled === true && document.querySelector('#app').getAttribute('aria-busy') !== 'true');
  assert.equal(await page.getByRole('switch', { name: 'Enable automatic claims' }).getAttribute('aria-checked'), 'true');
  await page.getByRole('switch', { name: 'Enable automatic claims' }).click();
  await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.claims.enabled === false && document.querySelector('#app').getAttribute('aria-busy') !== 'true');
  assert.equal(JSON.parse(await readFile(path.join(profile, 'config.json'), 'utf8')).claims.enabled, false);

  stage = 'persistent diagnostic history';
  // The toggle's persisted response can precede the last coalesced stop-state
  // publication. Drain that known 200 ms UI window before injecting isolated
  // renderer snapshots, which must not race real main-process state updates.
  await page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(resolve), 300)));
  assert.equal((await page.evaluate(() => window.connectwallet.invoke('getState'))).config.developerMode, false);
  assert.equal((await page.evaluate(() => window.connectwallet.invoke('getState'))).diagnostics, null);
  assert.equal(await page.locator('.diagnostics-card').count(), 0);
  await application.evaluate(({ shell }) => {
    globalThis.diagnosticOpenedPath = null;
    shell.openPath = async value => { globalThis.diagnosticOpenedPath = value; return ''; };
  });
  assert.equal(await page.evaluate(() => window.connectwallet.invoke('openDiagnostics').then(() => false, () => true)), true);
  assert.equal(await application.evaluate(() => globalThis.diagnosticOpenedPath), null);
  const claimWarning = 'The node rejected this claim. Its bounty or proof may no longer be valid.';
  const claimNotice = () => page.locator('.form-card .notice.danger').filter({ hasText: claimWarning });
  const tlsTimeout = diagnosticError(new Error('TLS connection timed out'));
  const tlsTitle = 'TCP/TLS connection attempt timed out';
  const genericTimeout = diagnosticError(new Error('RPC request timed out.'));
  const diagnosticRows = [
    { event: 'claim.failed', details: { stage: 'proof', claimId: 1, durationMs: 10016, error: tlsTimeout } },
    { event: 'claim.failed', details: { stage: 'proof', claimId: 2, durationMs: 45000, error: diagnosticError(new Error('Proof generation timed out')) } },
    { event: 'rpc.failed', details: { stage: 'request', method: 'getchaintip', durationMs: 10016, error: genericTimeout } },
    { event: 'helper.failed', details: { stage: 'proof', durationMs: 45000,
      error: diagnosticError({ message: 'Claims helper startup timed out; update or rebuild the helper', helperFatal: true }) } },
    { event: 'claim.failed', details: { stage: 'submit', claimId: 3, durationMs: 10016, unknownOutcome: true,
      error: diagnosticError({ message: 'TLS connection timed out', unknownOutcome: true }) } },
  ].map((row, sequence) => ({ timestamp: '2026-09-25T10:33:13.380Z', session: 'isolated-ui-fixture', sequence: sequence + 1, ...row }));
  await showClaimPresentation({ message: claimWarning, diagnostic: true, enabled: true });
  assert.equal(await claimNotice().count(), 0, 'recoverable claim rejection is hidden by default');
  await showClaimPresentation({ message: claimWarning, diagnostic: true, enabled: false });
  assert.equal(await claimNotice().count(), 0, 'pausing claims must not reveal the same recoverable diagnostic');
  await showClaimPresentation({ message: tlsTimeout.message, diagnostic: false, enabled: true,
    category: 'tls-timeout', transient: true, diagnosticRows });
  assert.equal(await page.locator('.diagnostics-card').count(), 0, 'synthetic history is still hidden without Developer Mode');
  assert.equal(await page.locator('.form-card .notice.info').filter({ hasText: tlsTimeout.message }).isVisible(), true,
    'an individual TLS timeout is informational in normal mode too');
  assert.equal(await page.locator('.form-card .notice.danger').filter({ hasText: tlsTimeout.message }).count(), 0);
  const unknownBroadcast = 'Claim broadcast was not confirmed. Check the transaction before enabling Automatic Claims again.';
  await showClaimPresentation({ message: unknownBroadcast, diagnostic: false, enabled: false, pageError: unknownBroadcast });
  assert.equal(await page.locator('.form-card .notice.danger').filter({ hasText: unknownBroadcast }).isVisible(), true);
  assert.equal(await page.locator('.page-error').isVisible(), true);
  await page.evaluate(() => window.connectwallet.invoke('refresh'));
  failNextHistory = true;
  assert.equal(await page.evaluate(async () => {
    try { await window.connectwallet.invoke('refresh'); return false; } catch { return true; }
  }), true);
  await page.locator('.page-error').waitFor();
  assert.equal(await page.locator('.diagnostics-card').count(), 0, 'technical history stays hidden, not important page errors');
  await page.evaluate(() => window.connectwallet.invoke('refresh'));
  assert.equal(await page.locator('.page-error').count(), 0);
  const beforeDeveloper = await page.evaluate(() => window.connectwallet.invoke('getState'));
  const beforeDeveloperConnections = connectionCount;
  await toggleDeveloperMode(true);
  const afterDeveloper = await page.evaluate(() => window.connectwallet.invoke('getState'));
  assert.equal(afterDeveloper.phase, beforeDeveloper.phase);
  assert.equal(afterDeveloper.securityEpoch, beforeDeveloper.securityEpoch);
  assert.equal(afterDeveloper.wallet.address, beforeDeveloper.wallet.address);
  assert.equal(afterDeveloper.claims.enabled, beforeDeveloper.claims.enabled);
  assert.deepEqual(afterDeveloper.config, { ...beforeDeveloper.config, developerMode: true });
  assert.equal(connectionCount, beforeDeveloperConnections);
  assert.equal(await page.locator('#rpc-host').inputValue(), '127.0.0.1');
  assert.equal(await page.locator('#auto-lock').inputValue(), '30');
  await page.locator('#developer-mode').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshots, 'developer-mode-settings.png') });
  await page.reload();
  await page.locator('[data-view="claims"]').first().click();
  await page.waitForFunction(() => document.querySelector('.diagnostic-list')?.textContent.includes('-32001'));
  assert.match(await page.locator('.diagnostic-list').textContent(), /-32001/);
  assert.ok(!(await page.locator('.diagnostic-list').textContent()).includes('private-remote-diagnostic-canary'));
  await showClaimPresentation({ message: claimWarning, diagnostic: true, enabled: true });
  assert.equal(await claimNotice().isVisible(), true, 'Developer Mode reveals the inline claim rejection');
  await page.getByRole('button', { name: 'Open log folder' }).click();
  assert.equal(await application.evaluate(() => globalThis.diagnosticOpenedPath), path.join(profile, 'logs'));
  await page.locator('.diagnostics-card').screenshot({ path: path.join(screenshots, 'claims-diagnostics.png') });
  stage = 'precise TLS diagnostic history and transient inline presentation';
  await showClaimPresentation({ message: tlsTimeout.message, diagnostic: false, enabled: true,
    category: 'tls-timeout', transient: true, diagnosticRows });
  assert.equal(await page.locator('.diagnostics-card h2').textContent(), 'Recent diagnostic events');
  assert.match(await page.locator('.diagnostics-card > .card-description').first().textContent(), /not the current status of Automatic Claims/);
  const tlsHistory = page.locator('.diagnostic-list li').filter({ hasText: 'bounty job #1' });
  assert.equal(await tlsHistory.locator('strong').textContent(), tlsTitle);
  assert.match(await tlsHistory.textContent(), /TCP\/TLS connection · bounty job #1 · 10\.016 s/);
  assert.match(await tlsHistory.locator('.diagnostic-explanation').textContent(), /No claim transaction was broadcast from this attempt\./);
  assert.match(await tlsHistory.locator('.diagnostic-explanation').textContent(), /This individual timeout did not stop Automatic Claims\./);
  assert.equal(await page.locator('.form-card .notice.info').filter({ hasText: tlsTimeout.message }).isVisible(), true);
  assert.equal(await page.locator('.form-card .notice.danger').filter({ hasText: tlsTimeout.message }).count(), 0);
  const otherHistory = page.locator('.diagnostic-list li').filter({ hasNotText: 'bounty job #1' });
  assert.equal(await otherHistory.count(), 4);
  for (const row of await otherHistory.all()) {
    assert.equal(await row.locator('.diagnostic-explanation').count(), 0);
    const text = await row.textContent();
    assert.ok(!text.includes('TCP/TLS connection') && !text.includes('No claim transaction was broadcast') && !text.includes('did not stop Automatic Claims'),
      'RPC, generic proof, fatal helper and unknown-broadcast failures cannot inherit individual-TLS-timeout claims');
  }
  assert.equal(await page.locator('.diagnostic-list li').filter({ hasText: 'getchaintip' }).locator('strong').textContent(), genericTimeout.message);
  assert.match(await page.locator('.diagnostic-list li').filter({ hasText: 'bounty job #3' }).locator('strong').textContent(), /broadcast outcome is unknown/i);
  await tlsHistory.scrollIntoViewIfNeeded();
  await page.locator('.diagnostics-card').screenshot({ path: path.join(screenshots, 'claims-diagnostics-tls-timeout.png') });
  // Both flags are required for an informational inline notice. Neither a
  // generic timeout nor an incorrectly marked broadcast warning may become info.
  for (const sample of [
    { message: tlsTimeout.message, category: 'tls-timeout', transient: false },
    { message: genericTimeout.message, category: 'timeout', transient: true },
    { message: 'The Automatic Claims helper failed.', category: 'helper-failed', transient: true },
    { message: unknownBroadcast, category: 'broadcast-unknown', transient: true, pageError: unknownBroadcast },
  ]) {
    await showClaimPresentation({ ...sample, diagnostic: false, enabled: false, diagnosticRows });
    assert.equal(await page.locator('.form-card .notice.danger').filter({ hasText: sample.message }).isVisible(), true);
    assert.equal(await page.locator('.form-card .notice.info').filter({ hasText: sample.message }).count(), 0);
  }
  assert.equal(await page.locator('.page-error .notice.danger').isVisible(), true);
  await showClaimPresentation({ message: null, diagnostic: false, enabled: false, diagnosticRows });
  assert.equal(await tlsHistory.isVisible(), true, 'clearing the live warning and stopping claims must preserve history');
  assert.equal(await page.locator('.form-card .notice').filter({ hasText: tlsTimeout.message }).count(), 0);
  assert.equal(await page.locator('.page-error').count(), 0);
  const diagnosticText = await readFile(path.join(profile, 'logs', 'diagnostics.jsonl'), 'utf8');
  assert.match(diagnosticText, /rpc.failed/);
  assert.match(diagnosticText, /wallet.refresh_failed/);
  for (const secret of [password, seed.join(' '), 'private-remote-diagnostic-canary', address]) {
    if (secret) assert.ok(!diagnosticText.includes(secret));
  }
  await toggleDeveloperMode(false);
  await page.locator('[data-view="claims"]').first().click();
  await showClaimPresentation({ message: claimWarning, diagnostic: true, enabled: true });
  assert.equal(await claimNotice().count(), 0);
  await showClaimPresentation({ message: tlsTimeout.message, diagnostic: false, enabled: false,
    category: 'tls-timeout', transient: true, diagnosticRows });
  assert.equal(await page.locator('.form-card .notice.info').filter({ hasText: tlsTimeout.message }).isVisible(), true);
  assert.equal(await page.locator('.form-card .notice.danger').filter({ hasText: tlsTimeout.message }).count(), 0);
  assert.equal(await page.locator('.diagnostics-card').count(), 0);
  assert.equal((await page.evaluate(() => window.connectwallet.invoke('getState'))).diagnostics, null);
  await page.screenshot({ path: path.join(screenshots, 'claims-normal-mode.png'), fullPage: true });
  await page.evaluate(() => window.connectwallet.invoke('refresh'));

  stage = 'lock and unlock';
  await page.locator('#claims-lookback').fill('344');
  await page.getByRole('button', { name: 'Lock wallet', exact: true }).click();
  await page.locator('#unlock-password').waitFor();
  await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.claims.lookbackBlocks === 344);
  await waitForScheme(true);
  await selectTheme('light');
  assert.equal(await page.locator('#unlock-password').isVisible(), true);
  assert.equal(await page.locator('.address-box').count(), 0);
  assert.equal(await page.locator('.seed-word').count(), 0);
  await page.locator('#unlock-password').fill(password);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await page.locator('[data-view="settings"]').first().waitFor();
  await page.locator('[data-view="settings"]').first().click();
  assert.equal(await page.locator('#theme-preference').inputValue(), 'light');
  assert.equal((await page.evaluate(() => window.connectwallet.invoke('getState'))).config.claims.lookbackBlocks, 344);
  await selectTheme('dark', { ui: true });
  await page.getByRole('button', { name: 'View recovery phrase' }).click();
  await page.locator('#recovery-password').fill(password);
  await page.getByRole('button', { name: 'Reveal words' }).click();
  await page.getByRole('heading', { name: 'For your eyes only.' }).waitFor();
  assert.equal(await page.locator('.modal-seed-grid .seed-word').count(), 12);
  // Lock from the real main-process bridge while a phrase is visible. It must
  // disappear immediately without requiring any renderer close-button action.
  await page.evaluate(() => window.connectwallet.invoke('lock'));
  await page.locator('#unlock-password').waitFor();
  assert.equal(await page.locator('.seed-word').count(), 0);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  const encrypted = await readFile(path.join(profile, 'wallet.connectwallet.json'), 'utf8');
  assert.ok(!encrypted.includes(seed.join(' ')));
  assert.ok(!encrypted.includes(password));
  assert.ok(requests.includes('getaddressbalance'));
  assert.ok(!requests.includes('sendrawtransaction'));
  assert.deepEqual(errors, []);
  assert.deepEqual(failedBrandRequests, [], 'ConnectWallet artwork must remain allowed by the renderer resource policy.');
  stage = 'close flushes valid numeric and endpoint drafts';
  await page.locator('#unlock-password').fill(password);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await page.locator('[data-view="settings"]').first().click();
  await page.locator('#auto-lock').fill('29');
  await page.locator('#rpc-port').fill(String(fixture.address().port));
  await closeElectronTest(application); application = null;
  const closedConfig = JSON.parse(await readFile(path.join(profile, 'config.json'), 'utf8'));
  assert.equal(closedConfig.autoLockMinutes, 29);
  assert.equal(closedConfig.rpc.port, fixture.address().port);
  assert.equal(closedConfig.feeRate, 2200);
  for (const secret of [password, seed.join(' '), 'example.com']) assert.ok(!JSON.stringify(closedConfig).includes(secret));
  passed = true;
} catch (error) {
  // Avoid Playwright action dumps: they could contain a generated backup word.
  const sourceLine = /test-ui\.mjs:(\d+):\d+/.exec(String(error.stack ?? ''))?.[1];
  console.error(`UI smoke test failed during ${stage} (${error.name ?? 'Error'}${sourceLine ? `, test line ${sourceLine}` : ''}). No recovery words were logged. Temporary profile preserved: ${profile}`);
  if (stage.includes('diagnostic')) console.error(`Diagnostic presentation fixture number: ${presentationSequence}.`);
  if (stage === 'system appearance and startup persistence') console.error(String(error.message).slice(0, 800));
  if (error.code === 'ERR_ASSERTION' && (stage === 'appearance settings preserve wallet and drafts' || /^(?:Native appearance must match|Developer Mode persistence mismatch)/.test(String(error.message)))) console.error(String(error.message).slice(0, 500));
  process.exitCode = 1;
} finally {
  seed.fill(''); seed = [];
  try { console.log(`UI shutdown: ${JSON.stringify(await closeElectronTest(application))}`); }
  catch { passed = false; process.exitCode = 1; console.error('UI graceful shutdown failed.'); }
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => fixture.close(resolve));
  await new Promise(resolve => alternateFixture.close(resolve));
  if (passed) {
    const absolute = path.resolve(profile);
    assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
    assert.ok(path.basename(absolute).startsWith('connectwallet-ui-test-'));
    await rm(absolute, { recursive: true, force: true });
  }
}
if (passed) console.log(`PASS: real Electron isolation, ConnectWallet title and decoded artwork, appearance, Developer Mode visibility and critical alerts, automatic preference persistence with native numeric caret and open details retained, atomic RPC edits, invalid-draft preservation, claims on/off persistence, lock/close flush, BIP39 backup, encrypted wallet, zero-balance RPC fixture, receive QR, bounty form, >100 warning, lock/unlock, recovery erasure and graceful shutdown. Screenshots: ${screenshots}`);
