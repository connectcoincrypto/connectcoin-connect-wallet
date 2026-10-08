// Real Electron/preload/service/vault UI smoke test. RPC uses an empty local
// fixture; no remote servers, user wallets, clipboard, or live coins are touched.
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import QRCode from 'qrcode';
import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GENESIS } from '../src/core/config.mjs';
import { decodeAddress, encodeAddress } from '../src/core/crypto.mjs';
import { diagnosticError } from '../src/core/diagnostics.mjs';
import { createRequire } from 'node:module';
import { waitForUiCondition } from './ui-wait.mjs';
import { closeElectronTest } from './ui-close.mjs';
import { createUiStartupDiagnostics } from './ui-startup.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// macOS Home/End scroll the document instead of moving the input caret.
const inputStartKey = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';
const inputEndKey = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';
const profile = await mkdtemp(path.join(tmpdir(), 'connectwallet-ui-test-'));
const screenshots = await mkdtemp(path.join(tmpdir(), 'connectwallet-ui-screens-'));
const tip = { chain: 'main', height: 0, hash: GENESIS.main, genesis_hash: GENESIS.main, mediantime: 1780000000 };
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
      else if (['subscribetip', 'subscribebounties', 'subscribeaddress'].includes(method)) result = { subscription_id: `${method}:${params.address ?? ''}`, tip, cursor: 'ui-empty-journal', ...(method === 'subscribeaddress' ? { changes_only: true } : {}) };
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
await writeFile(path.join(profile, 'config.json'), JSON.stringify({ version: 1, network: 'main', rpc: { host: '127.0.0.1', port: fixture.address().port } }));
let application;
let page;
const errors = [];
const failedBrandRequests = [];
let stage = 'prepare Electron runtime';
let stageStarted = performance.now();
let stageIndex = 1;
let passed = false;
let seed = [];
const password = 'UI-test-only-long-password';
const env = { ...process.env, CONNECTWALLET_TEST_PROFILE: profile, CONNECTWALLET_NETWORK: 'main' };
delete env.ELECTRON_RUN_AS_NODE;

console.log(`UI stage ${stageIndex} started: ${stage}.`);
function finishStage(outcome) {
  console.log(`UI stage ${stageIndex} ${outcome}: ${stage} (${Math.round(performance.now() - stageStarted)} ms).`);
}
function nextStage(value) {
  // Labels come only from the fixed test stages below, never from inputs,
  // clipboard text, page contents, recovery words or exception messages.
  finishStage('completed');
  stage = value;
  stageStarted = performance.now();
  stageIndex++;
  console.log(`UI stage ${stageIndex} started: ${stage}.`);
}

async function openApplication(executablePath) {
  const startup = createUiStartupDiagnostics();
  try {
    // Disable Playwright's default forced-light emulation so this test observes
    // Electron nativeTheme and the real application color-scheme behavior.
    application = await startup.run('electron-launch', () => electron.launch({ executablePath, args: [root], env, colorScheme: null, timeout: 30000 }));
    page = await startup.run('first-window', () => application.firstWindow());
    page.setDefaultTimeout(15000);
    startup.observePage(page);
    page.on('pageerror', error => errors.push(error.name));
    page.on('requestfailed', request => {
      if (request.url().endsWith('/assets/icon.png')) failedBrandRequests.push(request.failure()?.errorText ?? 'Image request failed');
    });
    await startup.run('welcome-heading', () => page.getByRole('heading', { name: 'Hello, connection.' }).waitFor());
    await startup.run('window-title', async () => assert.equal(await page.title(), 'ConnectWallet · ConnectCoin'));
    await startup.run('application-name', async () => assert.equal(await application.evaluate(({ app }) => app.getName()), 'ConnectWallet'));
    await startup.run('brand-label', async () => assert.equal(await page.locator('.auth-art .brand strong').textContent(), 'ConnectWallet'));
    await startup.run('brand-image', () => assertLoadedImage('.auth-art .brand-mark img'));
  } finally { startup.dispose(); }
}
async function assertLoadedImage(selector) {
  // A visible <img> with a cancelled file:// request still occupies its box.
  // Verify decoded pixels, not only DOM presence or a plausible source URL.
  await page.waitForFunction(value => {
    const images = [...document.querySelectorAll(value)];
    return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  }, selector);
}
async function assertReceiveRequest(uri) {
  await page.waitForFunction(expected => document.querySelector('#receive-uri')?.value === expected
    && document.querySelector('[data-action="copy-payment-request"]')?.disabled === false, uri);
  assert.equal(await page.locator('#receive-uri').getAttribute('readonly'), '');
  await assertLoadedImage('#receive-qr');
  // Generating the expected image independently makes this assert the QR's
  // actual payload, not merely that a previous address QR is still displayed.
  const modules = QRCode.create(uri, { errorCorrectionLevel: 'M' }).modules.size + 8;
  const width = modules * Math.max(4, Math.ceil(280 / modules));
  const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 4, width, color: { dark: '#17211b', light: '#ffffff' } });
  await expect.poll(() => page.locator('#receive-qr').getAttribute('src')).toBe(qr);
  await assertLoadedImage('#receive-qr');
}
async function assertCopiedReceiveValue(action, expected) {
  const previous = await application.evaluate(() => globalThis.receiveClipboardWrites.length);
  await page.locator(`[data-action="${action}"]`).click();
  await expect.poll(() => application.evaluate(() => globalThis.receiveClipboardWrites.length)).toBe(previous + 1);
  assert.equal(await application.evaluate(() => globalThis.receiveClipboardWrites.at(-1)), expected);
}
async function pasteIntoField(field, text, type = 'text/plain') {
  return field.evaluate((input, transfer) => {
    // Supply synthetic data without reading or writing the OS clipboard, then
    // emulate only an allowed native insertion so real Undo can be verified.
    const clipboardData = new DataTransfer();
    if (transfer.type) clipboardData.setData(transfer.type, transfer.text);
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    if (!event.defaultPrevented && transfer.type === 'text/plain') {
      if (!document.execCommand('insertText', false, transfer.text)) throw new Error('Native paste insertion failed.');
    }
    return event.defaultPrevented;
  }, { text, type });
}
async function assertAmountInputGuard(selector) {
  const amount = page.locator(selector);
  const original = await amount.inputValue();
  const editingState = () => amount.evaluate(input => ({
    value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection,
  }));
  const caretState = () => amount.evaluate(input => ({ value: input.value, start: input.selectionStart, end: input.selectionEnd }));
  const select = (start, end = start, direction = 'none') => amount.evaluate((input, selection) => {
    input.focus();
    input.setSelectionRange(...selection);
  }, [start, end, direction]);
  const paste = (text, type) => pasteIntoField(amount, text, type);

  assert.equal(await amount.getAttribute('inputmode'), 'decimal');
  await amount.fill('');
  await page.keyboard.type('1.2345678901');
  assert.equal(await amount.inputValue(), '1.2345678901', `${selector} must preserve all ten decimal places.`);
  const fullPrecision = await editingState();
  await page.keyboard.type('2');
  assert.deepEqual(await editingState(), fullPrecision, `${selector} must block an eleventh decimal digit without moving the caret.`);

  await amount.fill('12.34');
  await select(5);
  const beforeInvalidKey = await editingState();
  for (const character of ['a', 'e', 'E', '+', '-', '.', ',']) {
    await page.keyboard.type(character);
    assert.deepEqual(await editingState(), beforeInvalidKey, `${selector} must reject the invalid key ${JSON.stringify(character)}.`);
  }
  await amount.fill('');
  await page.keyboard.type('1,2345678901');
  assert.equal(await amount.inputValue(), '1.2345678901', `${selector} must normalize a typed decimal comma to a dot.`);
  await select(2, 12);
  await page.keyboard.type('9876543210');
  assert.deepEqual(await caretState(), { value: '1.9876543210', start: 12, end: 12 },
    `${selector} must allow replacement of a full-precision fraction.`);

  await amount.fill('123.456');
  await select(1, 2);
  await page.keyboard.type('9');
  assert.deepEqual(await caretState(), { value: '193.456', start: 2, end: 2 });
  await page.keyboard.press('Backspace');
  assert.deepEqual(await caretState(), { value: '13.456', start: 1, end: 1 });
  await page.keyboard.press('Delete');
  assert.deepEqual(await caretState(), { value: '1.456', start: 1, end: 1 });
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  assert.equal(await amount.inputValue(), '', `${selector} must remain clearable with normal keyboard shortcuts.`);

  for (const text of ['99999999.9999999999', '99999999,9999999999']) {
    await amount.fill('12.34');
    await select(0, 5);
    assert.equal(await paste(text), text.includes(','), `${selector} must keep canonical paste native and handle normalization.`);
    assert.deepEqual(await caretState(), { value: '99999999.9999999999', start: 19, end: 19 },
      `${selector} must preserve an exact pasted amount and place the caret after it.`);
    await page.keyboard.press('ControlOrMeta+Z');
    assert.deepEqual(await caretState(), { value: '12.34', start: 0, end: 5 },
      `${selector} must allow native Undo to restore the amount replaced by ${JSON.stringify(text)}.`);
  }
  await amount.fill('1234');
  await select(1, 3);
  assert.equal(await paste('7,89'), true);
  assert.deepEqual(await caretState(), { value: '17.894', start: 5, end: 5 },
    `${selector} must paste over only the selected text and normalize the comma.`);
  await page.keyboard.press('ControlOrMeta+Z');
  assert.equal(await amount.inputValue(), '1234', `${selector} must support Undo after a normalized paste over part of the amount.`);

  for (const [text, type] of [['', 'text/plain'], ['', null], ['<b>image-only clipboard fixture</b>', 'text/html']]) {
    await amount.fill('12.34');
    await select(1, 4, 'backward');
    const beforePaste = await editingState();
    assert.equal(await paste(text, type), true, `${selector} must cancel empty or nontext paste.`);
    assert.deepEqual(await editingState(), beforePaste, `${selector} must not let empty or nontext paste delete the selection.`);
  }

  for (const text of ['1x2', '1e2', '-1', '+1', '1.2.3', '1,2.3', '1.00000000001', ' 1 ', '1\n2']) {
    await amount.fill('12.34');
    await select(1, 4, 'backward');
    const beforePaste = await editingState();
    assert.equal(await paste(text), true, `${selector} must cancel an invalid paste.`);
    assert.deepEqual(await editingState(), beforePaste,
      `${selector} must reject the whole paste ${JSON.stringify(text)} without stripping, truncating, or changing the selection.`);
  }
  await amount.fill('1.2345678901');
  await select(12);
  const beforeExtraPastedDigit = await editingState();
  assert.equal(await paste('2'), true);
  assert.deepEqual(await editingState(), beforeExtraPastedDigit,
    `${selector} must validate the resulting amount when pasted text adds an eleventh decimal digit.`);
  await amount.fill(original);
}
async function assertTextInputLimit(selector, limit) {
  const field = page.locator(selector);
  const original = await field.inputValue();
  const editingState = () => field.evaluate(input => ({
    value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection,
  }));
  const select = (start, end = start, direction = 'none') => field.evaluate((input, selection) => {
    input.focus();
    input.setSelectionRange(...selection);
  }, [start, end, direction]);
  assert.equal(await field.getAttribute('data-text-limit'), String(limit));
  await field.fill('a'.repeat(limit));
  await select(limit);
  const atLimit = await editingState();
  await page.keyboard.type('x');
  assert.deepEqual(await editingState(), atLimit, `${selector} must block a character beyond its limit without moving the caret.`);
  const middle = Math.floor(limit / 2);
  await select(middle, middle + 1, 'backward');
  await page.keyboard.type('Z');
  const replaced = `${'a'.repeat(middle)}Z${'a'.repeat(limit - middle - 1)}`;
  assert.equal(await field.inputValue(), replaced, `${selector} must allow selected text replacement at the character limit.`);
  assert.deepEqual(await field.evaluate(input => [input.selectionStart, input.selectionEnd]), [middle + 1, middle + 1]);
  const afterReplacement = await editingState();
  await page.keyboard.type('x');
  assert.deepEqual(await editingState(), afterReplacement, `${selector} must enforce its limit for insertion in the middle too.`);

  await field.fill('before');
  await select(0, 6, 'backward');
  assert.equal(await pasteIntoField(field, 'b'.repeat(limit)), false, `${selector} must keep an accepted paste native.`);
  assert.equal(await field.inputValue(), 'b'.repeat(limit));
  await page.keyboard.press('ControlOrMeta+Z');
  assert.equal(await field.inputValue(), 'before', `${selector} must preserve native paste Undo.`);
  assert.deepEqual(await field.evaluate(input => [input.selectionStart, input.selectionEnd]), [0, 6]);
  await select(1, 4, 'backward');
  const beforeRejectedPaste = await editingState();
  assert.equal(await pasteIntoField(field, 'c'.repeat(limit + 1)), true, `${selector} must cancel an over-limit whole paste.`);
  assert.deepEqual(await editingState(), beforeRejectedPaste,
    `${selector} must reject an over-limit paste atomically without truncating it or deleting the selection.`);

  if (selector.endsWith('-label')) {
    await field.fill('');
    const emojiLabel = '🚀'.repeat(limit);
    assert.equal(await pasteIntoField(field, emojiLabel), false);
    assert.equal(await field.inputValue(), emojiLabel, 'One hundred emoji are one hundred label characters, despite using two UTF-16 units each.');
    assert.equal([...(await field.inputValue())].length, limit);
    const fullEmojiLabel = await editingState();
    await page.keyboard.type('x');
    assert.deepEqual(await editingState(), fullEmojiLabel);
    await select(0, emojiLabel.length, 'backward');
    const beforeEmojiPaste = await editingState();
    assert.equal(await pasteIntoField(field, `${emojiLabel}🚀`), true);
    assert.deepEqual(await editingState(), beforeEmojiPaste, 'An over-limit emoji label must be rejected as a whole.');
    // This label exceeds the separately enforced aggregate URI byte cap; its
    // acceptance by the editing guard does not imply QR generation will succeed.
  } else {
    await field.fill('m'.repeat(limit - 1));
    await select(limit - 1);
    await page.keyboard.press('Enter');
    assert.equal(await field.inputValue(), `${'m'.repeat(limit - 1)}\n`, 'A message newline must count as one character.');
    const messageWithNewline = await editingState();
    await page.keyboard.type('x');
    assert.deepEqual(await editingState(), messageWithNewline, 'A newline at the message limit must leave no extra character slot.');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('z');
    assert.equal(await field.inputValue(), `${'m'.repeat(limit - 1)}z`, 'Deleting the newline must free exactly one character slot.');
    await field.fill('');
    const unicodeMessage = `${'m'.repeat(limit - 2)}🚀🚀`;
    assert.equal(await pasteIntoField(field, unicodeMessage), false);
    assert.equal(await field.inputValue(), unicodeMessage, 'The message limit must count emoji as one character each too.');
    assert.equal([...(await field.inputValue())].length, limit);
    const fullUnicodeMessage = await editingState();
    await page.keyboard.type('x');
    assert.deepEqual(await editingState(), fullUnicodeMessage);
  }
  await field.fill(original);
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

async function assertTrailingPeriodPreference(selector, value, configPath, { endpoint = false } = {}) {
  const field = page.locator(selector);
  const original = await field.inputValue();
  const originalConfig = await page.evaluate(async keys => keys.reduce((current, key) => current[key],
    (await window.connectwallet.invoke('getState')).config), configPath);
  const host = endpoint ? await page.locator('#rpc-host').inputValue() : null;
  const commitEndpoint = () => field.evaluate(input => {
    // Endpoint saving starts when editing leaves both host and port. Return to
    // the field before the queued save, to check its acknowledgement in place.
    document.querySelector('#auto-lock').focus();
    input.focus();
  });
  await field.fill(String(value));
  await page.keyboard.press(inputEndKey);
  await page.keyboard.type('.');
  await field.evaluate(input => {
    window.trailingPeriodEditingField = input;
    input.setSelectionRange(input.value.length - 1, input.value.length, 'backward');
  });
  if (endpoint) await commitEndpoint();
  await waitForUiCondition(page, async ({ keys, expected }) => {
    const state = await window.connectwallet.invoke('getState');
    return keys.reduce((current, key) => current[key], state.config) === expected
      && !state.busy && document.querySelector('#app')?.getAttribute('aria-busy') === 'false';
  }, { keys: configPath, expected: value }, { message: `${selector} must save its trailing-period value as an integer.` });
  // Include the coalesced acknowledgement render while the period is selected.
  await page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(resolve), 300)));
  const draft = `${value}.`;
  assert.deepEqual(await field.evaluate((input, endpoint) => ({
    value: input.value, focused: document.activeElement === input,
    start: input.selectionStart, end: input.selectionEnd, valid: input.checkValidity(),
    // A changed endpoint advances the security epoch and replaces the shell;
    // ordinary preference acknowledgements must keep their existing controls.
    ...(!endpoint ? { sameNode: input === window.trailingPeriodEditingField, direction: input.selectionDirection } : {}),
  }), endpoint), { value: draft, focused: true, start: draft.length - 1, end: draft.length, valid: true,
    ...(!endpoint ? { sameNode: true, direction: 'backward' } : {}) },
  `${selector} must save a trailing period as an integer while preserving the editable draft and selection.`);
  if (endpoint) {
    assert.equal(await page.locator('#rpc-host').inputValue(), host, 'Editing the local RPC port must not change its host.');
  }
  assert.equal(await page.locator('#view-error').isVisible(), false);
  await page.keyboard.press('Backspace');
  assert.equal(await field.inputValue(), String(value), `${selector} must remain editable after autosave.`);
  await field.fill(original);
  if (endpoint) await commitEndpoint();
  await waitForUiCondition(page, async ({ keys, expected }) => keys.reduce((current, key) => current[key],
    (await window.connectwallet.invoke('getState')).config) === expected, { keys: configPath, expected: originalConfig });
}

async function assertTrailingPeriodSendReview({ bounty, address }) {
  if (bounty) {
    await page.locator('#send-domain').fill('example.com');
    await page.locator('#send-expected').fill('1000.');
  } else await page.locator('#send-address').fill(address);
  await page.locator('#send-amount').fill('123.');
  if (await page.locator('.advanced-fee').getAttribute('open') === null) await page.locator('.advanced-fee summary').click();
  const previousPreviews = await application.evaluate(() => globalThis.trailingPeriodPreviewFixture.calls.length);
  for (const invalidFee of ['1200.', '100001.']) {
    await page.locator('#send-fee').fill(invalidFee);
    assert.equal(await page.locator('#send-fee').evaluate(input => input.checkValidity()), false,
      'A trailing period must not bypass the fee rate bounds.');
    await page.getByRole('button', { name: bounty ? 'Review bounty' : 'Review payment', exact: true }).click();
    assert.equal(await application.evaluate(() => globalThis.trailingPeriodPreviewFixture.calls.length), previousPreviews,
      'An out-of-range fee must not reach preview IPC.');
    assert.equal(await page.locator('dialog[open]').count(), 0);
  }
  await page.locator('#send-fee').fill('1500.');
  assert.equal(await page.locator('#send-fee').evaluate(input => input.checkValidity()), true);
  await page.getByRole('button', { name: bounty ? 'Review bounty' : 'Review payment', exact: true }).click();
  await page.getByRole('heading', { name: 'One final look.', exact: true }).waitFor();
  const payload = await application.evaluate(() => globalThis.trailingPeriodPreviewFixture.calls.at(-1));
  assert.deepEqual(payload, {
    ...(bounty ? { domain: 'example.com', expectedConnections: '1000' } : { address }), amount: '123', feeRate: 1500,
    subtractFeeFromAmount: false, allowPendingSpent: false,
  }, 'Review IPC must receive canonical numeric values after trailing-period drafts.');
  assert.equal(await page.locator('#send-amount').inputValue(), '123.');
  assert.equal(await page.locator('#send-fee').inputValue(), '1500.');
  if (bounty) assert.equal(await page.locator('#send-expected').inputValue(), '1000.');
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('dialog[open]') && document.querySelector('#app')?.getAttribute('aria-busy') === 'false');
  await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.feeRate === 1500);
  if (await page.locator('.advanced-fee').getAttribute('open') !== null) await page.locator('.advanced-fee summary').click();
}

async function assertSendDraft(expected) {
  await expect.poll(() => page.locator('#send-form').evaluate(form => Object.fromEntries(
    ['address', 'amount', 'label', 'message'].map(name => [name, form.querySelector(`#send-${name}`)?.value]),
  ))).toEqual(expected);
}

async function usePaymentLink(text, { clipboardError = false } = {}) {
  // This replaces only the test application's clipboard reader. Neither the
  // real clipboard contents nor other applications are read or modified.
  const previousReads = await application.evaluate((_electron, value) => {
    const fixture = globalThis.paymentLinkFixture;
    fixture.clipboardText = value.text; fixture.clipboardError = value.clipboardError;
    return fixture.clipboardReads;
  }, { text, clipboardError });
  await page.locator('[data-action="import-payment-link"]').click();
  await expect.poll(() => application.evaluate(() => globalThis.paymentLinkFixture.clipboardReads)).toBe(previousReads + 1);
  assert.equal(await page.locator('dialog[open]').count(), 0, 'Paste must use the clipboard directly, without opening a dialog.');
}

async function assertPaymentLinkImport(address, otherAddress) {
  // Parsing uses the real main-process implementation. Clipboard input is
  // synthetic, and the delay follows parsing (including rejection) so the
  // renderer must not overwrite an edited draft or revive one after locking.
  await application.evaluate(({ clipboard }, moduleUrl) => {
    const { WalletService } = process.getBuiltinModule('node:module').createRequire(moduleUrl)('./wallet-service.mjs');
    const prototype = WalletService.prototype;
    const fixture = { prototype, originals: {}, parseCalls: [], previews: [], confirmations: [], entered: false, completed: 0,
      clipboard, originalClipboardReadText: clipboard.readText, clipboardReads: 0, clipboardText: '', clipboardError: false };
    // Electron 44 reads asynchronously; a synchronous stub hides missing await
    // bugs and changes a rejected Promise into an unrelated synchronous throw.
    clipboard.readText = async () => {
      await Promise.resolve();
      fixture.clipboardReads++;
      const { clipboardText, clipboardError, readGate } = fixture;
      if (readGate) { fixture.readEntered = true; await readGate; }
      if (clipboardError) throw new Error('Isolated clipboard failure.');
      return clipboardText;
    };
    for (const method of ['parseClipboardPaymentRequest', 'previewSend', 'confirmSend']) fixture.originals[method] = prototype[method];
    prototype.parseClipboardPaymentRequest = async function (payload) {
      fixture.parseCalls.push(payload);
      let result, error;
      try { result = await fixture.originals.parseClipboardPaymentRequest.call(this, payload); }
      catch (cause) { error = cause; }
      if (fixture.gate) { fixture.entered = true; await fixture.gate; }
      fixture.completed++;
      if (error) throw error;
      return result;
    };
    prototype.previewSend = async function (payload) {
      fixture.previews.push(payload);
      return { previewId: 'isolated-payment-link-preview', type: 'payment', address: payload.address,
        amount: payload.amount, label: payload.label, message: payload.message,
        fee: '0.000001', total: '0.0000010001' };
    };
    prototype.confirmSend = async function (payload) {
      fixture.confirmations.push(payload);
      throw new Error('The isolated UI fixture never broadcasts transactions.');
    };
    globalThis.paymentLinkFixture = fixture;
  }, pathToFileURL(path.join(root, 'src/core/wallet-service.mjs')).href);
  const imported = { address, amount: '0.0000000001', label: 'Café + 東京 🚀', message: 'Olá & <amigos>\nConexão = 50% # 🌍' };
  const uri = `connectcoin:${address}?amount=${imported.amount}&label=${encodeURIComponent(imported.label)}&message=${encodeURIComponent(imported.message)}`;
  const assertNoAutomaticSend = async (expectedPreviews = 0) => {
    assert.deepEqual(await application.evaluate(() => ({
      previews: globalThis.paymentLinkFixture.previews.length, confirmations: globalThis.paymentLinkFixture.confirmations.length,
    })), { previews: expectedPreviews, confirmations: 0 }, 'Importing a payment link must never automatically review or send a payment.');
    assert.ok(!requests.includes('sendrawtransaction'));
  };
  const assertPasteErrorCleared = async () => {
    await expect(page.locator('#payment-paste-error')).toHaveCount(1);
    await expect(page.locator('#payment-paste-error')).toHaveText('');
    assert.equal(await page.locator('#payment-paste-error').getAttribute('role'), 'status');
    assert.equal(await page.locator('#payment-paste-error').evaluate(node => node.tagName), 'P');
    assert.equal(await page.locator('#payment-paste-error').evaluate(node => node.classList.contains('is-fading')), false);
    assert.equal(await page.locator('#view-error').isVisible(), false);
  };
  const assertPasteError = async rawText => {
    const error = page.locator('#payment-paste-error');
    await expect(error).toHaveText(/\S/);
    await expect(error).toBeVisible();
    await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false');
    assert.equal(await error.getAttribute('role'), 'status');
    assert.equal(await error.evaluate(node => node.previousElementSibling?.dataset.action), 'import-payment-link',
      'Clipboard validation errors must stay directly below the paste button.');
    assert.equal(await page.locator('#view-error').isVisible(), false, 'A clipboard error must not become a global page error.');
    assert.equal(await page.locator('dialog[open]').count(), 0, 'A clipboard error must not open a dialog.');
    if (rawText?.trim()) assert.equal((await error.textContent()).includes(rawText.trim()), false,
      'Clipboard error text must not echo the rejected clipboard payload.');
  };
  try {
    nextStage('send payment link import preserves precision and Unicode metadata');
    await assertPasteErrorCleared();
    await page.locator('#send-address').fill(otherAddress);
    await page.locator('#send-amount').fill('12.34');
    await usePaymentLink(uri);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await assertSendDraft(imported);
    assert.equal(await page.locator('#send-metadata').evaluate(details => details.open), true,
      'Imported metadata must be visible for the user to review.');
    await page.screenshot({ path: path.join(screenshots, 'send-imported.png'), fullPage: true });
    assert.deepEqual(await application.evaluate(() => globalThis.paymentLinkFixture.parseCalls.at(-1)), { text: uri });
    await assertPasteErrorCleared();
    for (const [field, limit] of [['label', 100], ['message', 200]]) {
      assert.equal(await page.locator(`#send-${field}`).getAttribute('data-draft'), `send.${field}`);
      await assertTextInputLimit(`#send-${field}`, limit);
    }
    await assertSendDraft(imported);
    await page.locator('[data-view="activity"]').first().click();
    await page.locator('[data-view="send"]').first().click();
    await assertSendDraft(imported);
    await assertNoAutomaticSend();

    nextStage('send payment link rejects invalid requests without partial changes');
    const wrongNetworkAddress = encodeAddress(decodeAddress(address, 'main'), 'testnet4');
    const invalidUris = [
      'private-clipboard-canary-DO-NOT-DISPLAY',
      wrongNetworkAddress,
      `https://example.com/${otherAddress}?amount=2`,
      `connectcoin:${wrongNetworkAddress}?amount=2&label=replacement`,
      `connectcoin:${otherAddress}?amount=2&amount=3`,
      `connectcoin:${otherAddress}?label=first&label=second`,
      `connectcoin:${otherAddress}?amount=2&req-feature=1`,
      `connectcoin:${otherAddress}?amount=2&label=%ZZ`,
      `connectcoin:${otherAddress}?amount=0&label=replacement`,
      `connectcoin:${otherAddress}?amount=2&label=hidden%0Atext`,
      `connectcoin:${otherAddress}?amount=2&message=hidden%E2%80%AEtext`,
    ];
    for (const invalidUri of invalidUris) {
      const previousCalls = await application.evaluate(() => globalThis.paymentLinkFixture.parseCalls.length);
      await usePaymentLink(invalidUri);
      await assertPasteError(invalidUri);
      assert.equal((await page.locator('body').textContent()).includes('private-clipboard-canary-DO-NOT-DISPLAY'), false);
      assert.equal(await application.evaluate(() => globalThis.paymentLinkFixture.parseCalls.length), previousCalls + 1,
        'Payment link validation must reach the main-process service.');
      await assertSendDraft(imported);
      await assertNoAutomaticSend();
    }

    nextStage('send payment link handles empty and asynchronously rejected clipboard reads without changing drafts');
    for (const [clipboardText, clipboardError] of [['', false], [' \n\t ', false], ['', true]]) {
      await usePaymentLink(clipboardText, { clipboardError });
      await assertPasteError(clipboardText);
      await assertSendDraft(imported);
      await assertNoAutomaticSend();
    }
    await page.locator('.form-layout').screenshot({ path: path.join(screenshots, 'send-clipboard-error.png') });

    nextStage('send clipboard error survives background rendering then fades and clears');
    // Exercise the animation itself even on CI hosts with reduced motion;
    // restore the host preference after this focused transition assertion.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await usePaymentLink('private-clipboard-canary-DO-NOT-DISPLAY');
    await assertPasteError('private-clipboard-canary-DO-NOT-DISPLAY');
    const refreshSnapshot = await page.evaluate(async () => {
      window.paymentPasteErrorNode = document.querySelector('#payment-paste-error');
      window.paymentPasteErrorText = window.paymentPasteErrorNode.textContent;
      return window.connectwallet.invoke('getState');
    });
    assert.equal(await page.locator('#payment-paste-error').evaluate(node => getComputedStyle(node).opacity), '1');
    const changedSnapshot = { ...refreshSnapshot, network: { ...refreshSnapshot.network, status: 'clipboard-error-refresh-fixture' } };
    await application.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', snapshot), changedSnapshot);
    await page.waitForFunction(() => document.querySelector('.network-pill')?.textContent.includes('clipboard-error-refresh-fixture'));
    assert.deepEqual(await page.locator('#payment-paste-error').evaluate(node => ({
      sameNode: node === window.paymentPasteErrorNode, sameText: node.textContent === window.paymentPasteErrorText,
    })), { sameNode: true, sameText: true }, 'Background rendering must preserve the active inline error node and text.');
    await application.evaluate(({ BrowserWindow }, snapshot) => BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', snapshot), refreshSnapshot);
    await page.waitForFunction(() => {
      const node = document.querySelector('#payment-paste-error');
      const opacity = node && Number(getComputedStyle(node).opacity);
      return node?.classList.contains('is-fading') && node.textContent.trim() && opacity > 0 && opacity < 1;
    }, null, { timeout: 6000 });
    await expect(page.locator('#payment-paste-error')).toHaveText('', { timeout: 3000 });
    await assertPasteErrorCleared();
    await assertSendDraft(imported);
    await page.evaluate(() => { delete window.paymentPasteErrorNode; delete window.paymentPasteErrorText; });
    await page.emulateMedia({ reducedMotion: null });

    nextStage('send clipboard error is discarded when leaving the view or payment mode');
    for (const changedContext of ['navigation', 'send-mode', 'security-epoch', 'lock']) {
      await usePaymentLink('private-clipboard-canary-DO-NOT-DISPLAY');
      await assertPasteError('private-clipboard-canary-DO-NOT-DISPLAY');
      if (changedContext === 'navigation') {
        await page.locator('[data-view="activity"]').first().click();
        await expect(page.locator('#payment-paste-error')).toHaveCount(0);
        await page.locator('[data-view="send"]').first().click();
      } else if (changedContext === 'send-mode') {
        await page.locator('[data-send-mode="bounty"]').click();
        await expect(page.locator('#payment-paste-error')).toHaveCount(0);
        await page.locator('[data-send-mode="address"]').click();
      } else if (changedContext === 'security-epoch') {
        // Advance only the isolated renderer snapshot, without changing the
        // real wallet/network configuration, then restore its real snapshot.
        const snapshot = await page.evaluate(() => window.connectwallet.invoke('getState'));
        await application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', value),
          { ...snapshot, securityEpoch: snapshot.securityEpoch + 1 });
        await assertPasteErrorCleared();
        await application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send('connectwallet:state', value), snapshot);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      } else {
        await page.keyboard.press('ControlOrMeta+L');
        await page.locator('#unlock-password').fill(password);
        await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
        await page.locator('[data-view="send"]').first().click();
      }
      await assertPasteErrorCleared();
      await usePaymentLink(uri);
      await assertSendDraft(imported);
      await assertPasteErrorCleared();
    }

    nextStage('send payment link exposes unused optional fields');
    await usePaymentLink(`${uri}&unknown-field=ignored`);
    await assertSendDraft(imported);
    await assertPasteErrorCleared();
    await expect(page.locator('.notice.warning').filter({ hasText: 'unknown-field' })).toBeVisible();
    await assertNoAutomaticSend();

    nextStage('send plain address preserves amount and fee while clearing imported notes');
    const previousFee = await page.locator('#send-fee').inputValue();
    const feeWasOpen = await page.locator('.advanced-fee').evaluate(details => details.open);
    if (!feeWasOpen) await page.locator('.advanced-fee summary').click();
    await page.locator('#send-fee').fill('2300');
    await page.locator('#send-amount').fill('12.3400000001');
    await usePaymentLink(otherAddress);
    await assertSendDraft({ address: otherAddress, amount: '12.3400000001', label: '', message: '' });
    assert.equal(await page.locator('#send-fee').inputValue(), '2300', 'A plain address paste must preserve the selected fee rate.');
    assert.equal(await page.locator('#send-metadata').evaluate(details => details.open), false);
    await expect(page.locator('.notice.warning').filter({ hasText: 'unknown-field' })).toHaveCount(0);
    assert.deepEqual(await application.evaluate(() => globalThis.paymentLinkFixture.parseCalls.at(-1)), { text: otherAddress });
    await assertPasteErrorCleared();
    await assertNoAutomaticSend();
    await page.locator('#send-fee').fill(previousFee);
    if (!feeWasOpen) await page.locator('.advanced-fee summary').click();

    nextStage('send payment link replaces absent amount and metadata');
    await usePaymentLink(`connectcoin:${otherAddress}`);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await assertSendDraft({ address: otherAddress, amount: '', label: '', message: '' });
    await assertPasteErrorCleared();
    await assertNoAutomaticSend();
    await usePaymentLink(uri);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await assertSendDraft(imported);

    nextStage('send payment link metadata remains visible in explicit review');
    await page.getByRole('button', { name: 'Review payment', exact: true }).click();
    await page.getByRole('heading', { name: 'One final look.', exact: true }).waitFor();
    const reviewPayload = await application.evaluate(() => globalThis.paymentLinkFixture.previews.at(-1));
    assert.deepEqual({ address: reviewPayload.address, amount: reviewPayload.amount, label: reviewPayload.label, message: reviewPayload.message }, imported);
    assert.ok((await page.locator('dialog[open]').textContent()).includes(imported.label));
    assert.ok((await page.locator('dialog[open]').textContent()).includes(imported.message));
    assert.equal(await page.locator('dialog[open] amigos').count(), 0, 'Payment metadata must render as text, never markup.');
    await page.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await assertNoAutomaticSend(1);

    const composingLabel = '編集中 café';
    for (const changedContext of ['navigation', 'send-mode', 'focus', 'draft-edit', 'composition', 'lock']) {
      nextStage(`send payment link repastes original details before ${changedContext}`);
      await usePaymentLink(uri);
      await assertSendDraft(imported);
      nextStage(`send payment link protects a pending clipboard import during ${changedContext}`);
      await application.evaluate(() => {
        const fixture = globalThis.paymentLinkFixture;
        fixture.entered = false;
        fixture.gate = new Promise(resolve => { fixture.release = resolve; });
      });
      const previousCompletions = await application.evaluate(() => globalThis.paymentLinkFixture.completed);
      await usePaymentLink(`connectcoin:${otherAddress}?amount=9&label=Late%20result&message=Must%20be%20discarded`);
      await expect.poll(() => application.evaluate(() => globalThis.paymentLinkFixture.entered)).toBe(true);
      if (changedContext === 'navigation') {
        await page.locator('[data-view="activity"]').first().click();
        await expect(page.locator('#send-form')).toHaveCount(1);
      } else if (changedContext === 'send-mode') {
        await page.locator('[data-send-mode="bounty"]').click();
        await expect(page.locator('#send-domain')).toHaveCount(0);
      } else if (changedContext === 'focus') await page.locator('#send-amount').focus();
      else if (changedContext === 'draft-edit') await page.locator('#send-amount').fill('7.5');
      else if (changedContext === 'composition') {
        await page.locator('#send-label').evaluate((input, value) => {
          input.focus();
          window.paymentImportCompositionField = input;
          input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
          input.value = value;
          input.setSelectionRange(value.length, value.length);
          input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: value, isComposing: true }));
        }, composingLabel);
      }
      else await page.keyboard.press('ControlOrMeta+L');
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      if (changedContext === 'lock') await page.locator('#unlock-password').waitFor();
      else await assertSendDraft({ ...imported,
        ...(changedContext === 'draft-edit' ? { amount: '7.5' } : {}),
        ...(changedContext === 'composition' ? { label: composingLabel } : {}) });
      await application.evaluate(() => {
        const fixture = globalThis.paymentLinkFixture;
        fixture.gate = null;
        fixture.release();
        fixture.release = null;
      });
      await expect.poll(() => application.evaluate(() => globalThis.paymentLinkFixture.completed)).toBe(previousCompletions + 1);
      await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('dialog[open]').count(), 0, 'A late parse response must not reopen any modal.');
      if (changedContext === 'lock') {
        await page.locator('#unlock-password').fill(password);
        await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
        await page.locator('[data-view="send"]').first().click();
        await assertSendDraft({ address: '', amount: '', label: '', message: '' });
      } else if (changedContext === 'draft-edit') await assertSendDraft({ ...imported, amount: '7.5' });
      else if (changedContext === 'composition') {
        await assertSendDraft({ ...imported, label: composingLabel });
        assert.deepEqual(await page.locator('#send-label').evaluate(input => ({
          sameNode: input === window.paymentImportCompositionField,
          focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd,
        })), { sameNode: true, focused: true, start: composingLabel.length, end: composingLabel.length },
        'A late clipboard response must preserve the active composition node, text and caret before it commits.');
        await page.locator('#send-label').evaluate((input, value) => {
          input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
          delete window.paymentImportCompositionField;
        }, composingLabel);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        await page.locator('[data-view="activity"]').first().click();
        await page.locator('[data-view="send"]').first().click();
        await assertSendDraft({ ...imported, label: composingLabel });
      }
      else await assertSendDraft({ address: otherAddress, amount: '9', label: 'Late result', message: 'Must be discarded' });
      await assertPasteErrorCleared();
      await assertNoAutomaticSend(1);
    }

    for (const changedContext of ['draft-edit', 'lock']) {
      nextStage(`send clipboard retry clears old errors and discards a late error after ${changedContext}`);
      await usePaymentLink(uri);
      await assertSendDraft(imported);
      await usePaymentLink('private-clipboard-canary-DO-NOT-DISPLAY');
      await assertPasteError('private-clipboard-canary-DO-NOT-DISPLAY');
      await application.evaluate(() => {
        const fixture = globalThis.paymentLinkFixture;
        fixture.entered = false;
        fixture.gate = new Promise(resolve => { fixture.release = resolve; });
      });
      const previousCompletions = await application.evaluate(() => globalThis.paymentLinkFixture.completed);
      await usePaymentLink('private-clipboard-canary-DO-NOT-DISPLAY');
      await expect.poll(() => application.evaluate(() => globalThis.paymentLinkFixture.entered)).toBe(true);
      await assertPasteErrorCleared();
      if (changedContext === 'draft-edit') await page.locator('#send-amount').fill('7.5');
      else {
        await page.keyboard.press('ControlOrMeta+L');
        await page.locator('#unlock-password').waitFor();
      }
      await application.evaluate(() => {
        const fixture = globalThis.paymentLinkFixture;
        fixture.gate = null;
        fixture.release();
        fixture.release = null;
      });
      await expect.poll(() => application.evaluate(() => globalThis.paymentLinkFixture.completed)).toBe(previousCompletions + 1);
      await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false');
      if (changedContext === 'lock') {
        await page.locator('#unlock-password').fill(password);
        await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
        await page.locator('[data-view="send"]').first().click();
        await assertSendDraft({ address: '', amount: '', label: '', message: '' });
      } else await assertSendDraft({ ...imported, amount: '7.5' });
      await assertPasteErrorCleared();
      assert.equal(await page.locator('dialog[open]').count(), 0, 'A stale clipboard rejection must not open an error dialog.');
      await assertNoAutomaticSend(1);
    }

    nextStage('send clipboard read resolving after lock must not reach the parser or revive an error');
    await usePaymentLink(uri);
    await assertSendDraft(imported);
    const previousParses = await application.evaluate(() => {
      const fixture = globalThis.paymentLinkFixture;
      fixture.readEntered = false;
      fixture.readGate = new Promise(resolve => { fixture.releaseRead = resolve; });
      return fixture.parseCalls.length;
    });
    await usePaymentLink(otherAddress);
    await expect.poll(() => application.evaluate(() => globalThis.paymentLinkFixture.readEntered)).toBe(true);
    assert.equal(await application.evaluate(() => globalThis.paymentLinkFixture.parseCalls.length), previousParses);
    await page.keyboard.press('ControlOrMeta+L');
    await page.locator('#unlock-password').waitFor();
    await application.evaluate(() => {
      const fixture = globalThis.paymentLinkFixture;
      fixture.readGate = null;
      fixture.releaseRead();
      fixture.releaseRead = null;
    });
    await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') === 'false');
    assert.equal(await application.evaluate(() => globalThis.paymentLinkFixture.parseCalls.length), previousParses,
      'A clipboard read completed in an obsolete security context must be rejected before parsing.');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.locator('#unlock-password').fill(password);
    await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
    await page.locator('[data-view="send"]').first().click();
    await assertSendDraft({ address: '', amount: '', label: '', message: '' });
    await assertPasteErrorCleared();
    await assertNoAutomaticSend(1);
  } finally {
    await application.evaluate(() => {
      const fixture = globalThis.paymentLinkFixture;
      for (const [method, original] of Object.entries(fixture.originals)) fixture.prototype[method] = original;
      fixture.clipboard.readText = fixture.originalClipboardReadText;
      fixture.release?.();
      fixture.releaseRead?.();
      delete globalThis.paymentLinkFixture;
    });
  }
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
  nextStage('launch');
  await openApplication(executablePath);
  // Screenshots are deliberately limited to screens with no recovery words.
  await page.getByRole('heading', { name: 'Hello, connection.' }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'welcome.png') });
  assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process, Object.isFrozen(window.connectwallet)]), ['undefined', 'undefined', true]);
  assert.equal(await page.evaluate(() => window.connectwallet.invoke('getblocktemplate').then(() => false, () => true)), true);

  nextStage('system appearance and startup persistence');
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

  nextStage('create and backup');
  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  assert.equal(await page.locator('#setup-name').getAttribute('data-text-limit'), '40');
  assert.equal(await page.locator('#setup-name').getAttribute('data-text-count'), 'utf16');
  assert.equal(await page.locator('input[type="password"][data-text-limit], textarea[name="mnemonic"][data-text-limit]').count(), 0,
    'The public text guard must not apply to password or recovery phrase fields.');
  await page.locator('#setup-name').fill('n'.repeat(40));
  await page.keyboard.press(inputEndKey);
  await page.keyboard.type('x');
  assert.equal(await page.locator('#setup-name').inputValue(), 'n'.repeat(40));
  await page.keyboard.press('ControlOrMeta+A');
  assert.equal(await pasteIntoField(page.locator('#setup-name'), '🚀'.repeat(21)), true);
  assert.equal(await page.locator('#setup-name').inputValue(), 'n'.repeat(40), 'An over-limit wallet name paste must not truncate or replace the selected name.');
  assert.deepEqual(await page.locator('#setup-name').evaluate(input => [input.selectionStart, input.selectionEnd]), [0, 40]);
  assert.equal(await pasteIntoField(page.locator('#setup-name'), '🚀'.repeat(20)), false);
  assert.equal(await page.locator('#setup-name').inputValue(), '🚀'.repeat(20), 'Wallet names retain their existing UTF-16 limit.');
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

  nextStage('automatic settings persistence and appearance preserve invalid drafts');
  await page.locator('[data-view="settings"]').first().click();
  assert.equal(await page.locator('#auto-lock').inputValue(), '0', 'A profile without an explicit timeout must default to inactivity locking off.');
  assert.equal(await page.locator('#auto-lock').getAttribute('min'), '0');
  assert.equal(await page.locator('#auto-lock').getAttribute('aria-describedby'), 'auto-lock-help');
  assert.match(await page.locator('#auto-lock-help').textContent(), /0 disables inactivity locking/);
  assert.match(await page.locator('#auto-lock-help').textContent(), /Suspend still locks the wallet/);
  assert.match(await page.locator('#auto-lock-help').textContent(), /on Linux, use Lock now/);
  assert.equal(await page.getByText('Inactivity locking is off.', { exact: false }).isVisible(), true);
  assert.equal(await page.locator('#rpc-host').getAttribute('data-text-limit'), '253');
  assert.equal(await page.locator('#rpc-host').getAttribute('data-text-count'), 'utf16');
  assert.equal(await page.getByRole('button', { name: /^Save/ }).count(), 0, 'Settings should expose autosave without a manual Save button.');
  assert.equal(await page.getByRole('button', { name: 'Export wallet', exact: true }).isVisible(), true);
  assert.equal(await page.locator('#theme-preference').inputValue(), 'system');
  await page.locator('#rpc-host').fill('https://unfinished.example');
  await page.locator('#auto-lock').fill('30');
  await pressEnterInPreference('#auto-lock');
  await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.autoLockMinutes === 30);
  await assertPreferenceEnterStayedPut('#auto-lock');
  const beforeDisabledLock = await page.evaluate(() => window.connectwallet.invoke('getState'));
  const beforeDisabledLockConnections = connectionCount;
  await page.locator('#auto-lock').fill('0');
  await pressEnterInPreference('#auto-lock');
  await waitForUiCondition(page, async () => {
    const state = await window.connectwallet.invoke('getState');
    return state.config.autoLockMinutes === 0 && !state.busy
      && document.querySelector('#app')?.textContent.includes('Inactivity locking is off.');
  });
  await assertPreferenceEnterStayedPut('#auto-lock');
  const afterDisabledLock = await page.evaluate(() => window.connectwallet.invoke('getState'));
  assert.equal(afterDisabledLock.phase, 'unlocked');
  assert.equal(afterDisabledLock.securityEpoch, beforeDisabledLock.securityEpoch);
  assert.equal(afterDisabledLock.wallet.address, beforeDisabledLock.wallet.address);
  assert.equal(afterDisabledLock.claims.enabled, beforeDisabledLock.claims.enabled);
  assert.equal(connectionCount, beforeDisabledLockConnections, 'Disabling inactivity locking must not reconnect RPC.');
  assert.equal(JSON.parse(await readFile(path.join(profile, 'config.json'), 'utf8')).autoLockMinutes, 0);
  assert.equal(await page.getByText('Wallet locks after 0 minutes', { exact: false }).count(), 0);
  assert.equal(await page.locator('#rpc-host').inputValue(), 'https://unfinished.example');
  await page.locator('#auto-lock').fill('30');
  await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.autoLockMinutes === 30);
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
  nextStage('settings trailing periods save integers and preserve editing');
  await assertTrailingPeriodPreference('#auto-lock', 0, ['autoLockMinutes']);
  await assertTrailingPeriodPreference('#auto-lock', 31, ['autoLockMinutes']);
  await assertTrailingPeriodPreference('#rpc-port', fixture.address().port, ['rpc', 'port'], { endpoint: true });
  assert.equal(await page.locator('#rpc-host').inputValue(), '127.0.0.1');
  await page.locator('[data-view="overview"]').first().click();
  assert.equal(await page.locator('.seed-word').count(), 0);
  await page.screenshot({ path: path.join(screenshots, 'overview-dark.png') });

  nextStage('receiving payment URI, QR and guarded copy');
  await page.locator('[data-view="receive"]').first().click();
  const receiveAddressCard = page.locator('.receive-address-card');
  assert.equal(await receiveAddressCard.locator('.address-box').count(), 1);
  assert.equal(await receiveAddressCard.locator('[data-action="copy-address"]').count(), 1);
  assert.equal(await receiveAddressCard.locator('[data-action="new-address"]').count(), 1);
  assert.equal(await receiveAddressCard.locator('#receive-amount, #receive-label, #receive-message').count(), 0,
    'The public address card must be separate from optional payment request details.');
  const receiveDetails = page.locator('.receive-details');
  assert.equal(await receiveDetails.getByRole('heading', { level: 2, name: 'Payment request details', exact: true }).count(), 1);
  for (const field of ['amount', 'label', 'message']) {
    assert.equal(await receiveDetails.locator(`#receive-${field}`).count(), 1,
      `The ${field} field must belong to Payment request details.`);
  }
  const receiveMetadataHelp = receiveDetails.locator('#receive-metadata-help');
  assert.equal(await receiveMetadataHelp.isVisible(), true);
  const receiveMetadataWarning = await receiveMetadataHelp.textContent();
  assert.match(receiveMetadataWarning, /label and message are not written to the blockchain/i);
  assert.match(receiveMetadataWarning, /sending wallet can store them locally/i);
  assert.match(receiveMetadataWarning, /Both are visible to anyone with this link or QR code/i);
  for (const field of ['label', 'message']) {
    const descriptions = (await page.locator(`#receive-${field}`).getAttribute('aria-describedby') ?? '').split(/\s+/);
    assert.ok(descriptions.includes('receive-metadata-help'),
      `The ${field} field must expose the shared off-chain storage and privacy warning.`);
  }
  const address = await page.locator('.address-box').textContent();
  assert.match(address, /^cc1p[a-z0-9]+$/);
  for (const field of ['amount', 'label', 'message']) assert.equal(await page.locator(`#receive-${field}`).inputValue(), '');
  await assertReceiveRequest(`connectcoin:${address}`);
  nextStage('receive panel alignment and responsive content heights');
  const receiveViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const receivePanelBounds = () => page.locator('.receive-details, .payment-request').evaluateAll(panels => panels.map(panel => {
    const bounds = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right,
      contentBottom: panel.lastElementChild.getBoundingClientRect().bottom,
      bottomPadding: parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth) };
  }));
  try {
    await page.setViewportSize({ width: 1280, height: receiveViewport.height });
    const [details, payment] = await receivePanelBounds();
    assert.ok(details.right < payment.left, 'The desktop Receive panels must be side by side.');
    assert.ok(Math.abs(details.top - payment.top) <= 1 && Math.abs(details.bottom - payment.bottom) <= 1,
      'The desktop Receive panels must share their top and bottom edges.');
    await page.setViewportSize({ width: 1000, height: receiveViewport.height });
    const stacked = await receivePanelBounds();
    assert.ok(stacked[1].top > stacked[0].bottom, 'Narrow Receive panels must stack vertically.');
    for (const panel of stacked) {
      assert.ok(Math.abs(panel.bottom - panel.contentBottom - panel.bottomPadding) <= 1,
        'Stacked Receive panels must fit their content without extra equal-height space.');
    }
  } finally {
    await page.setViewportSize(receiveViewport);
  }
  nextStage('receive amount keyboard, paste and precision guard');
  await assertAmountInputGuard('#receive-amount');
  await assertReceiveRequest(`connectcoin:${address}`);
  nextStage('receiving payment URI, QR and guarded copy');
  await assertLoadedImage('.sidebar .brand-mark img');
  // Intercept the real IPC copy endpoint inside this isolated Electron process;
  // no test reads or writes the user's operating-system clipboard.
  await application.evaluate(({ clipboard }) => {
    globalThis.receiveOriginalClipboardWriteText = clipboard.writeText;
    globalThis.receiveClipboardWrites = [];
    // Match Electron's Promise<void> contract without touching the OS clipboard.
    clipboard.writeText = async value => {
      await Promise.resolve();
      globalThis.receiveClipboardWrites.push(value);
    };
  });
  await assertCopiedReceiveValue('copy-payment-request', `connectcoin:${address}`);
  await assertCopiedReceiveValue('copy-address', address);
  nextStage('receive text limits preserve Unicode, native editing and drafts');
  await assertTextInputLimit('#receive-label', 100);
  await assertTextInputLimit('#receive-message', 200);
  const limitedLabel = `${'L'.repeat(80)}${'🚀'.repeat(10)}`;
  const limitedMessage = 'm'.repeat(200);
  await page.locator('#receive-label').fill(limitedLabel);
  await page.locator('#receive-message').fill(limitedMessage);
  const limitedUri = `connectcoin:${address}?label=${encodeURIComponent(limitedLabel)}&message=${limitedMessage}`;
  await assertReceiveRequest(limitedUri);
  await assertCopiedReceiveValue('copy-payment-request', limitedUri);
  await page.locator('#receive-label').evaluate(input => {
    window.limitedReceiveEditingField = input;
    input.focus();
    input.setSelectionRange(82, 86, 'backward');
  });
  await selectTheme('light');
  assert.deepEqual(await page.locator('#receive-label').evaluate(input => ({
    value: input.value, sameNode: window.limitedReceiveEditingField === input, focused: document.activeElement === input,
    start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection,
  })), { value: limitedLabel, sameNode: true, focused: true, start: 82, end: 86, direction: 'backward' },
  'A background appearance render must preserve Unicode text, focus, and the selected emoji.');
  assert.equal(await page.locator('#receive-message').inputValue(), limitedMessage);
  await selectTheme('dark');
  await page.locator('[data-view="activity"]').first().click();
  await page.locator('[data-view="receive"]').first().click();
  assert.equal(await page.locator('#receive-label').inputValue(), limitedLabel);
  assert.equal(await page.locator('#receive-message').inputValue(), limitedMessage);
  await assertReceiveRequest(limitedUri);
  await page.locator('#receive-label').fill('');
  await page.locator('#receive-message').fill('');
  await assertReceiveRequest(`connectcoin:${address}`);
  nextStage('receive trailing period preserves URI, QR and copied request');
  await page.locator('#receive-amount').fill('123');
  await assertReceiveRequest(`connectcoin:${address}?amount=123`);
  const wholeAmountQr = await page.locator('#receive-qr').getAttribute('src');
  await page.keyboard.press(inputEndKey);
  await page.keyboard.type('.');
  assert.equal(await page.locator('#receive-amount').inputValue(), '123.');
  await assertReceiveRequest(`connectcoin:${address}?amount=123`);
  assert.equal(await page.locator('#receive-qr').getAttribute('src'), wholeAmountQr);
  await assertCopiedReceiveValue('copy-payment-request', `connectcoin:${address}?amount=123`);
  await page.locator('#receive-amount').focus();
  await page.keyboard.press(inputEndKey);
  await page.keyboard.type('4');
  assert.equal(await page.locator('#receive-amount').inputValue(), '123.4');
  await assertReceiveRequest(`connectcoin:${address}?amount=123.4`);
  await page.locator('#receive-amount').fill('');
  await assertReceiveRequest(`connectcoin:${address}`);
  nextStage('receiving payment URI, QR and guarded copy');
  const receiveDraft = { amount: '1.2345678901', label: 'Café + amigos & família', message: 'Olá, João? = 50% # conexão / 東京 🚀' };
  for (const [field, value] of Object.entries(receiveDraft)) await page.locator(`#receive-${field}`).fill(value);
  const receiveQuery = `?amount=${receiveDraft.amount}&label=${encodeURIComponent(receiveDraft.label)}&message=${encodeURIComponent(receiveDraft.message)}`;
  const paymentUri = `connectcoin:${address}${receiveQuery}`;
  await assertReceiveRequest(paymentUri);
  assert.ok(!paymentUri.includes('+'), 'Spaces and literal plus signs must use percent encoding.');
  assert.ok(paymentUri.includes('%20') && paymentUri.includes('%2B') && paymentUri.includes('%26') && paymentUri.includes('%F0%9F%9A%80'));
  await assertCopiedReceiveValue('copy-payment-request', paymentUri);

  nextStage('receive draft survives navigation, background state and appearance');
  await page.locator('[data-view="activity"]').first().click();
  await page.evaluate(() => window.connectwallet.invoke('refresh'));
  await page.locator('[data-view="receive"]').first().click();
  for (const [field, value] of Object.entries(receiveDraft)) assert.equal(await page.locator(`#receive-${field}`).inputValue(), value);
  await assertReceiveRequest(paymentUri);
  await page.locator('#receive-label').focus();
  await page.evaluate(() => { window.receiveEditingField = document.querySelector('#receive-label'); });
  await selectTheme('light');
  for (const [field, value] of Object.entries(receiveDraft)) assert.equal(await page.locator(`#receive-${field}`).inputValue(), value);
  assert.equal(await page.evaluate(() => window.receiveEditingField === document.querySelector('#receive-label')
    && document.activeElement === window.receiveEditingField), true, 'Background appearance updates must retain the active receive input.');
  await assertReceiveRequest(paymentUri);
  await page.screenshot({ path: path.join(screenshots, 'receive-light.png'), fullPage: true });
  await selectTheme('dark');
  await assertReceiveRequest(paymentUri);
  await page.screenshot({ path: path.join(screenshots, 'receive-dark.png'), fullPage: true });

  nextStage('invalid receive amounts cannot copy or display a stale QR');
  for (const amount of ['0', '100000001', '100000000.0000000001']) {
    await page.locator('#receive-amount').fill(amount);
    await page.waitForFunction(() => document.querySelector('[data-action="copy-payment-request"]')?.disabled === true
      && !document.querySelector('#receive-qr')?.getClientRects().length
      && !document.querySelector('#receive-uri')?.value);
    assert.equal(await page.locator('#receive-amount').inputValue(), amount);
    assert.equal(await page.locator('[data-action="copy-address"]').isEnabled(), true, 'The raw public address remains independently usable.');
  }
  // An invalid draft also survives a state update instead of silently reverting
  // to a valid request that might then be copied with the wrong amount.
  await page.evaluate(() => window.connectwallet.invoke('refresh'));
  await page.locator('[data-view="overview"]').first().click();
  await page.locator('[data-view="receive"]').first().click();
  assert.equal(await page.locator('#receive-amount').inputValue(), '100000000.0000000001');
  assert.equal(await page.locator('[data-action="copy-payment-request"]').isDisabled(), true);
  assert.equal(await page.locator('#receive-qr').isVisible(), false);
  await page.locator('#receive-amount').fill(receiveDraft.amount);
  await assertReceiveRequest(paymentUri);

  nextStage('new receive address refreshes URI and QR together');
  await page.locator('[data-action="new-address"]').click();
  await page.waitForFunction(previous => document.querySelector('.address-box')?.textContent !== previous
    && document.querySelector('#app')?.getAttribute('aria-busy') === 'false', address);
  let nextAddress = await page.locator('.address-box').textContent();
  assert.match(nextAddress, /^cc1p[a-z0-9]+$/);
  assert.notEqual(nextAddress, address);
  for (const [field, value] of Object.entries(receiveDraft)) assert.equal(await page.locator(`#receive-${field}`).inputValue(), value);
  let nextPaymentUri = `connectcoin:${nextAddress}${receiveQuery}`;
  await assertReceiveRequest(nextPaymentUri);

  nextStage('focused receive URI updates after a background address change');
  await page.locator('#receive-uri').focus();
  await page.evaluate(() => { window.receiveFocusedUri = document.querySelector('#receive-uri'); });
  const changedWhileFocused = await page.evaluate(() => window.connectwallet.invoke('newAddress'));
  assert.notEqual(changedWhileFocused.address, nextAddress);
  nextAddress = changedWhileFocused.address;
  nextPaymentUri = `connectcoin:${nextAddress}${receiveQuery}`;
  await assertReceiveRequest(nextPaymentUri);
  assert.deepEqual(await page.evaluate(() => ({
    sameNode: window.receiveFocusedUri === document.querySelector('#receive-uri'),
    focused: document.activeElement === window.receiveFocusedUri,
    value: window.receiveFocusedUri.value,
  })), { sameNode: true, focused: true, value: nextPaymentUri }, 'A focused read-only URI must update in place when the address changes.');

  const beforeStaleCopy = await application.evaluate(() => globalThis.receiveClipboardWrites.length);
  assert.equal(await page.evaluate(payload => window.connectwallet.invoke('copyPaymentRequest', payload).then(() => false, () => true),
    { ...receiveDraft, expectedUri: paymentUri, expectedAddress: address }), true, 'The IPC boundary must reject a previously displayed request after the receive address changes.');
  assert.equal(await application.evaluate(() => globalThis.receiveClipboardWrites.length), beforeStaleCopy);
  await assertCopiedReceiveValue('copy-payment-request', nextPaymentUri);
  await assertCopiedReceiveValue('copy-address', nextAddress);

  nextStage('receive QR generation while a wallet refresh is pending');
  await application.evaluate((_electron, moduleUrl) => {
    const { WalletService } = process.getBuiltinModule('node:module').createRequire(moduleUrl)('./wallet-service.mjs');
    const fixture = { prototype: WalletService.prototype, original: WalletService.prototype.refresh, entered: false };
    const gate = new Promise(resolve => { fixture.release = resolve; });
    fixture.prototype.refresh = async function (...args) {
      fixture.entered = true;
      await gate;
      return fixture.original.apply(this, args);
    };
    globalThis.receiveRefreshFixture = fixture;
  }, pathToFileURL(path.join(root, 'src/core/wallet-service.mjs')).href);
  try {
    // Keep the real mutation IPC call in flight without making the renderer's
    // controls busy. The read-only preview must bypass that main-process gate.
    await page.evaluate(() => {
      window.receiveDelayedRefreshStatus = 'pending';
      window.receiveDelayedRefresh = window.connectwallet.invoke('refresh').then(
        () => { window.receiveDelayedRefreshStatus = 'fulfilled'; },
        () => { window.receiveDelayedRefreshStatus = 'rejected'; },
      );
    });
    await expect.poll(() => application.evaluate(() => globalThis.receiveRefreshFixture.entered)).toBe(true);
    const pendingAmount = '2.0000000001';
    await page.locator('#receive-amount').fill(pendingAmount);
    const pendingUri = `connectcoin:${nextAddress}?amount=${pendingAmount}&label=${encodeURIComponent(receiveDraft.label)}&message=${encodeURIComponent(receiveDraft.message)}`;
    await assertReceiveRequest(pendingUri);
    assert.equal(await page.evaluate(() => window.receiveDelayedRefreshStatus), 'pending', 'The new QR must render before the blocked refresh completes.');
  } finally {
    await application.evaluate(() => {
      const fixture = globalThis.receiveRefreshFixture;
      fixture.prototype.refresh = fixture.original;
      fixture.release();
      delete globalThis.receiveRefreshFixture;
    });
    await page.evaluate(() => window.receiveDelayedRefresh);
  }
  assert.equal(await page.evaluate(() => window.receiveDelayedRefreshStatus), 'fulfilled');
  await page.locator('#receive-amount').fill(receiveDraft.amount);
  await assertReceiveRequest(nextPaymentUri);
  await application.evaluate(({ clipboard }) => {
    clipboard.writeText = globalThis.receiveOriginalClipboardWriteText;
    delete globalThis.receiveOriginalClipboardWriteText;
    delete globalThis.receiveClipboardWrites;
  });

  await page.locator('[data-view="send"]').first().click();
  await assertPaymentLinkImport(nextAddress, address);
  nextStage('send amount keyboard, paste and precision guard');
  assert.equal(await page.locator('#send-address').getAttribute('data-text-limit'), '90');
  assert.equal(await page.locator('#send-address').getAttribute('data-text-count'), 'utf16');
  assert.equal(await page.getByRole('button', { name: 'Review payment', exact: true }).isVisible(), true);
  await assertAmountInputGuard('#send-amount');
  nextStage('payment preparation failures remain visible and cancellation ignores late failures');
  // Only synthetic failures cross the real renderer/preload IPC boundary.
  // No transaction is constructed or sent by this fixture.
  await application.evaluate((_electron, moduleUrl) => {
    const { WalletService } = process.getBuiltinModule('module').createRequire(moduleUrl)('./wallet-service.mjs');
    const fixture = { prototype: WalletService.prototype, original: WalletService.prototype.previewSend,
      originalGetState: WalletService.prototype.getState, calls: 0, backgroundPublications: 0 };
    fixture.prototype.getState = function () {
      const snapshot = fixture.originalGetState.call(this);
      if (this === fixture.service && fixture.backgroundStatus) {
        snapshot.network = { ...snapshot.network, status: fixture.backgroundStatus };
      }
      return snapshot;
    };
    fixture.prototype.previewSend = async function () {
      fixture.calls++;
      fixture.service = this;
      this.paymentPreparation = { stage: 'prepare', completed: 0, total: 0 };
      this.emitState();
      try {
        await new Promise(resolve => { fixture.release = resolve; });
        throw new Error('Isolated payment preparation failure.');
      } finally { this.paymentPreparation = null; this.emitState(); }
    };
    globalThis.paymentFailureFixture = fixture;
  }, pathToFileURL(path.join(root, 'src/core/wallet-service.mjs')).href);
  try {
    await page.locator('#send-address').fill(nextAddress);
    await page.locator('#send-amount').fill('3.3872074');
    await page.locator('#send-subtract-fee').check();
    await page.getByRole('button', { name: 'Review payment', exact: true }).click();
    await expect(page.locator('#payment-preparation-status')).toHaveText('Checking spendable outputs…');
    await expect.poll(() => application.evaluate(() => globalThis.paymentFailureFixture.calls)).toBe(1);
    await application.evaluate(() => globalThis.paymentFailureFixture.release());
    await page.getByRole('heading', { name: 'Could not prepare your payment.', exact: true }).waitFor();
    await expect(page.locator('#modal-error')).toHaveText('Isolated payment preparation failure.');
    assert.match(await page.locator('dialog[open]').textContent(), /Nothing was sent/);
    assert.equal(await page.locator('[data-action="confirm-send"]').count(), 0);
    await application.evaluate(() => {
      const fixture = globalThis.paymentFailureFixture;
      // Both main and renderer coalesce state for 200 ms. A one-off forged
      // snapshot can correctly disappear behind a queued real publication.
      // Keep this marker in the scoped fixture's snapshots, including a second
      // queued publication, without changing the service's actual network state.
      fixture.backgroundStatus = 'payment-failure-background-check';
      fixture.onBackgroundState = snapshot => {
        if (snapshot.network.status === fixture.backgroundStatus) fixture.backgroundPublications++;
      };
      fixture.service.on('state', fixture.onBackgroundState);
      fixture.service.statePublisher.request({ immediate: true });
      fixture.service.emitState();
    });
    await expect.poll(() => application.evaluate(() => globalThis.paymentFailureFixture.backgroundPublications)).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.network-pill')).toContainText('payment-failure-background-check');
    await expect(page.locator('#modal-error')).toBeVisible();
    await expect(page.locator('#modal-error')).toHaveText('Isolated payment preparation failure.');
    assert.equal(await application.evaluate(() => globalThis.paymentFailureFixture.calls), 1, 'A failed review must not retry automatically.');
    await page.getByRole('button', { name: 'Back to form', exact: true }).click();
    assert.equal(await page.locator('#send-amount').inputValue(), '3.3872074');
    assert.equal(await page.locator('#send-subtract-fee').isChecked(), true);
    await page.getByRole('button', { name: 'Review payment', exact: true }).click();
    await expect.poll(() => application.evaluate(() => globalThis.paymentFailureFixture.calls)).toBe(2);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await application.evaluate(() => globalThis.paymentFailureFixture.release());
    await page.waitForFunction(() => document.querySelector('#app').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('dialog[open]').count(), 0, 'A cancelled review must not reopen a failure modal.');
    assert.equal(await page.locator('#view-error').isVisible(), false, 'A cancelled review must ignore its late failure.');
    await page.locator('#send-subtract-fee').uncheck();
  } finally {
    await application.evaluate(() => {
      const fixture = globalThis.paymentFailureFixture;
      fixture.release?.();
      fixture.prototype.previewSend = fixture.original;
      fixture.prototype.getState = fixture.originalGetState;
      if (fixture.onBackgroundState) fixture.service.off('state', fixture.onBackgroundState);
      if (fixture.service) { fixture.service.paymentPreparation = null; fixture.service.emitState(); }
      delete globalThis.paymentFailureFixture;
    });
  }
  // Capture the real renderer/preload IPC payload inside the isolated process.
  // The stub neither prepares a real transaction nor contacts a bounty domain.
  await application.evaluate((_electron, moduleUrl) => {
    const { WalletService } = process.getBuiltinModule('node:module').createRequire(moduleUrl)('./wallet-service.mjs');
    const fixture = { prototype: WalletService.prototype, original: WalletService.prototype.previewSend, calls: [] };
    fixture.prototype.previewSend = async function (payload) {
      fixture.calls.push(payload);
      const bounty = payload.domain !== undefined;
      return { previewId: 'isolated-trailing-period-preview', address: bounty ? payload.domain : payload.address,
        amount: payload.amount, fee: '0.000001', total: '123.000001', type: bounty ? 'p2c' : 'payment',
        ...(bounty ? { expectedConnections: payload.expectedConnections, signatureAlgorithmsMask: 7, rsaProbeStatus: 'unavailable' } : {}) };
    };
    globalThis.trailingPeriodPreviewFixture = fixture;
  }, pathToFileURL(path.join(root, 'src/core/wallet-service.mjs')).href);
  try {
    nextStage('send trailing periods submit canonical numeric values');
    await assertTrailingPeriodSendReview({ bounty: false, address: nextAddress });
    await page.getByRole('button', { name: 'Create a bounty', exact: true }).click();
    assert.equal(await page.locator('#send-domain').getAttribute('data-text-limit'), '1024');
    assert.equal(await page.locator('#send-domain').getAttribute('data-text-count'), 'utf16');
    nextStage('bounty amount keyboard, paste and precision guard');
    await assertAmountInputGuard('#send-amount');
    nextStage('bounty trailing periods submit canonical numeric values');
    await assertTrailingPeriodSendReview({ bounty: true });
    assert.equal(await application.evaluate(() => globalThis.trailingPeriodPreviewFixture.calls.length), 2);
  } finally {
    await application.evaluate(() => {
      const fixture = globalThis.trailingPeriodPreviewFixture;
      fixture.prototype.previewSend = fixture.original;
      delete globalThis.trailingPeriodPreviewFixture;
    });
  }
  nextStage('bounty form');
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
  // No real transaction was prepared, and the review fixture was never confirmed.
  await page.locator('[data-view="claims"]').first().click();
  assert.equal(await page.getByRole('button', { name: /^Save/ }).count(), 0, 'Automatic claims should expose autosave without a manual Save button.');
  assert.equal(await page.locator('#claims-rate').inputValue(), '100');
  assert.equal(await page.locator('#claims-concurrent').inputValue(), '100');
  assert.equal(await page.locator('[role="switch"]').getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('#claims-warning').isVisible(), false);
  nextStage('claims trailing periods save integers and preserve editing');
  await assertTrailingPeriodPreference('#claims-rate', 91, ['claims', 'maxConnectionsPerSecond']);
  await assertTrailingPeriodPreference('#claims-concurrent', 92, ['claims', 'maxConcurrent']);
  await assertTrailingPeriodPreference('#claims-lookback', 333, ['claims', 'lookbackBlocks']);
  nextStage('autosave acknowledgement preserves the native numeric caret');
  await page.locator('#claims-rate').fill('12');
  await page.keyboard.press(inputStartKey);
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

  nextStage('autosave errors survive updates and clear only after a successful retry');
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

  nextStage('successful autosave keeps unrelated action errors visible');
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

  nextStage('automatic claim limits and invalid drafts');
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

  nextStage('persistent diagnostic history');
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
  nextStage('precise TLS diagnostic history and transient inline presentation');
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

  nextStage('lock and unlock');
  await page.locator('[data-view="receive"]').first().click();
  for (const [field, value] of Object.entries(receiveDraft)) await page.locator(`#receive-${field}`).fill(value);
  await assertReceiveRequest(nextPaymentUri);
  await page.locator('[data-view="claims"]').first().click();
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
  await page.locator('[data-view="receive"]').first().click();
  for (const field of ['amount', 'label', 'message']) assert.equal(await page.locator(`#receive-${field}`).inputValue(), '', 'Locking must discard every receive request draft.');
  await assertReceiveRequest(`connectcoin:${nextAddress}`);
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
  nextStage('OS event handlers still lock with inactivity locking disabled');
  // Inject Electron events only: do not suspend or lock the machine running
  // the test. Screen-lock delivery itself is supported on Windows/macOS only.
  for (const event of ['suspend', ...(['win32', 'darwin'].includes(process.platform) ? ['lock-screen'] : [])]) {
    await page.locator('#unlock-password').fill(password);
    await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
    await page.locator('[data-view="settings"]').first().click();
    await page.locator('#auto-lock').fill('0');
    await waitForUiCondition(page, async () => (await window.connectwallet.invoke('getState')).config.autoLockMinutes === 0);
    await application.evaluate(({ powerMonitor }, event) => powerMonitor.emit(event), event);
    await page.locator('#unlock-password').waitFor();
    const locked = await page.evaluate(() => window.connectwallet.invoke('getState'));
    assert.equal(locked.phase, 'locked', `${event} must still lock with inactivity locking disabled.`);
    assert.equal(locked.config.autoLockMinutes, 0);
    assert.equal(await page.locator('.seed-word').count(), 0);
  }
  nextStage('close flushes valid numeric and endpoint drafts');
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
  if (stage.includes('amount keyboard, paste and precision guard')) console.error(String(error.message).slice(0, 1000));
  if (stage.includes('trailing period')) console.error(String(error.message).slice(0, 1000));
  if (stage.includes('receive text limits')) console.error(String(error.message).slice(0, 1000));
  if (stage.includes('send payment link')) console.error(String(error.message).slice(0, 1000));
  if (error.code === 'ERR_ASSERTION' && (stage === 'appearance settings preserve wallet and drafts' || /^(?:Native appearance must match|Developer Mode persistence mismatch)/.test(String(error.message)))) console.error(String(error.message).slice(0, 500));
  process.exitCode = 1;
} finally {
  finishStage(passed ? 'completed' : 'failed');
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
if (passed) console.log(`PASS: real Electron isolation, ConnectWallet title and decoded artwork, appearance, Developer Mode visibility and critical alerts, automatic preference persistence with native numeric caret and open details retained, atomic RPC edits, invalid-draft preservation, claims on/off persistence, lock/close flush, BIP39 backup, encrypted wallet, zero-balance RPC fixture, receive URI/QR, Unicode encoding, guarded clipboard copy, direct clipboard Send link/address import with exact precision, preserved address-only amount/fee, cleared stale notes, atomic rejection, local error fade/background/context cleanup, explicit review and late success/error draft-edit/lock race protection, Receive/Send/bounty amount keyboard and paste guards with exact precision and native selection editing, invalid amounts, receive draft persistence and lock erasure, bounty form, >100 warning, lock/unlock, recovery erasure and graceful shutdown. Screenshots: ${screenshots}`);
