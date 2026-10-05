import { test, expect } from '@playwright/test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import QRCode from 'qrcode';

const address = bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.toBytes(true).slice(1))]);
const otherAddress = bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.double().toBytes(true).slice(1))]);
const testnet = bech32m.encode('tcc', [1, ...bech32m.toWords(secp256k1.Point.BASE.toBytes(true).slice(1))]);

async function openReceive(page) {
  await page.goto('/');
  await page.locator('#watch-address').fill(address);
  await page.getByRole('button', { name: 'Watch address', exact: true }).click();
  await expect(page.locator('#current-address')).toHaveText(address);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.locator('#copy-link')).toBeEnabled();
  await expect(page.locator('#receive-qr')).toBeVisible();
}

async function isolateClipboard(page) {
  // Copy tests must not overwrite the user's operating-system clipboard.
  await page.addInitScript(() => {
    window.testCopiedLink = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async value => { window.testCopiedLink = value; },
      readText: async () => window.testCopiedLink,
    } });
  });
}

async function rejectPaste(locator, text) {
  // A real ClipboardEvent tests the capture-phase paste restriction. We only
  // use this helper for rejected pastes, which must have no native insertion.
  return locator.evaluate((input, value) => {
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    const transfer = new DataTransfer(); transfer.setData('text/plain', value);
    return !input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, text);
}

async function expectQrMatches(page, uri) {
  const modules = QRCode.create(uri, { errorCorrectionLevel: 'M' }).modules;
  // Compare the actual PNG's black/white modules to an independent QR build.
  // Comparing just src changes would miss a QR published for an older URI.
  const pixels = await page.locator('#receive-qr').evaluate(async (image, size) => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const scale = canvas.width / (size + 8);
    return Array.from({ length: size * size }, (_, index) => {
      const x = Math.floor((index % size + 4.5) * scale);
      const y = Math.floor((Math.floor(index / size) + 4.5) * scale);
      return data[(y * canvas.width + x) * 4] < 128 ? 1 : 0;
    });
  }, modules.size);
  expect(pixels).toEqual(Array.from(modules.data));
}

async function freezeReceiveTimers(page) {
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2030-01-01T00:01:00Z'));
}

test('old-WebView fallback is static and does not load the wallet runtime', async ({ page }) => {
  await page.goto('/unsupported-webview.html');
  await expect(page.getByRole('heading', { name: 'Update Android System WebView' })).toBeVisible();
  await expect(page.locator('script')).toHaveCount(0);
  await expect(page.locator('input, textarea, button')).toHaveCount(0);
});

test('first launch is honest, English, and has no private-key entry', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Your wallet,')).toBeVisible();
  await expect(page.locator('#preview-notice')).toBeVisible();
  await expect(page.locator('#watch-address')).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Watch address', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/alpha-start.png', fullPage: true });
});

test('rejects wrong network and bad checksum without reflecting input', async ({ page }) => {
  await page.goto('/');
  for (const input of [testnet, 'cc1p<script>alert(1)</script>', 'NEVER A VALID SECRET']) {
    await page.locator('#watch-address').fill(input);
    await page.getByRole('button', { name: 'Watch address', exact: true }).click();
    await expect(page.locator('#setup-error')).toHaveText('Enter a valid mainnet ConnectCoin public address or "connectcoin:" payment link.');
    await expect(page.locator('#wallet-panel')).toBeHidden();
  }
});

test('watch-only receive, bounded preview errors, saved defaults and removal', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await isolateClipboard(page);
  await page.goto('/');
  await page.locator('#watch-address').fill(`connectcoin:${address}?amount=1&label=Ignored`);
  await page.getByRole('button', { name: 'Watch address', exact: true }).click();
  await expect(page.locator('#current-address')).toHaveText(address);
  await expect(page.locator('#wallet-error')).toContainText('Live queries require the Android app');
  await expect(page.locator('#balance')).toHaveText('—');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.locator('#receive-qr')).toBeVisible();
  await expect(page.locator('#receive-address')).toHaveText(address);
  await page.getByRole('button', { name: 'Copy payment link', exact: true }).click();
  await expect(page.locator('#copy-status')).toHaveText('Payment link copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`connectcoin:${address}`);
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#mobile-data')).not.toBeChecked();
  await expect(page.locator('#background')).not.toBeChecked();
  await page.locator('#mobile-data').check();
  await page.locator('#background').check();
  await expect(page.locator('#claims-status')).toContainText('native claims not available');
  await expect(page.locator('#global-error')).toBeEmpty();
  await page.screenshot({ path: 'test-results/alpha-claims.png', fullPage: true });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('CapacitorStorage.connectwallet.mobile.alpha.public-profile.v1'))).toContain('"allowBackground":true');
  await page.reload();
  await expect(page.locator('#current-address')).toHaveText(address);
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#mobile-data')).toBeChecked();
  await expect(page.locator('#background')).toBeChecked();
  await page.getByRole('button', { name: 'Remove watched address', exact: true }).click();
  await expect(page.locator('#setup-panel')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('CapacitorStorage.connectwallet.mobile.alpha.public-profile.v1'))).toContain('"address":""');
  await page.reload();
  await expect(page.locator('#setup-panel')).toBeVisible();
  expect(errors).toEqual([]);
});

test('fits small devices and landscape', async ({ page }) => {
  await page.goto('/');
  await page.locator('#watch-address').fill(address);
  await page.getByRole('button', { name: 'Watch address', exact: true }).click();
  for (const size of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    for (const section of ['Overview', 'Receive', 'Send', 'Claims']) {
      await page.getByRole('button', { name: section, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});

test('send pastes a mainnet address or URI directly and never signs from browser preview', async ({ page }) => {
  await isolateClipboard(page);
  await openReceive(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#review-payment')).toBeDisabled();
  await page.evaluate(value => { window.testCopiedLink = value; }, `connectcoin:${otherAddress}?amount=1.2345678901`);
  await page.locator('#paste-payment').click();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('1.2345678901');
  await page.evaluate(value => { window.testCopiedLink = value; }, address);
  await page.locator('#paste-payment').click();
  await expect(page.locator('#send-address')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('');
  for (const invalid of [testnet, 'not-an-address']) {
    await page.evaluate(value => { window.testCopiedLink = value; }, invalid);
    await page.locator('#paste-payment').click();
    await expect(page.locator('#send-status')).toHaveText('Copy a valid ConnectCoin address or "connectcoin:" payment link.');
    await expect(page.locator('#send-address')).toHaveValue(address);
  }
  await expect(page.locator('#review-payment')).toBeDisabled();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
});

test('claims preview shows zero real counters and cannot start an invented native session', async ({ page }) => {
  await openReceive(page);
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#start-claims')).toBeDisabled();
  await expect(page.locator('#stop-claims')).toBeDisabled();
  for (const id of ['attempts', 'valid', 'invalid', 'targetHits', 'submitted', 'unknown', 'connectionsPerSecond', 'eligible']) {
    await expect(page.locator('#claims-' + id)).toHaveText('0');
  }
  await expect(page.locator('#claims-receipt')).toBeHidden();
  await expect(page.locator('#check-claim')).toBeHidden();
});

test('receive amount normalizes comma and final decimal separator while blocking letters and excess precision', async ({ page }) => {
  await openReceive(page);
  const amount = page.locator('#receive-amount');
  await amount.fill('1,');
  await expect(amount).toHaveValue('1.');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}?amount=1`);
  await expect(page.locator('#receive-error')).toBeEmpty();
  await amount.fill('1,2345678901');
  await expect(amount).toHaveValue('1.2345678901');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}?amount=1.2345678901`);
  await amount.pressSequentially('9abc+-e.,');
  await expect(amount).toHaveValue('1.2345678901');
  expect(await rejectPaste(amount, '2')).toBe(true);
  await expect(amount).toHaveValue('1.2345678901');
  await expect(page.locator('#receive-error')).toContainText('Nothing was pasted');
  await amount.fill('100000000.');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}?amount=100000000`);
  await expect(page.locator('#receive-error')).toBeEmpty();
});

test('receive label and message enforce Unicode code-point limits and reject oversized paste', async ({ page }) => {
  await openReceive(page);
  const label = page.locator('#receive-label'), message = page.locator('#receive-message');
  const labelLimit = '😀'.repeat(50) + 'a'.repeat(50);
  await label.fill(labelLimit);
  await expect(label).toHaveValue(labelLimit);
  await expect(page.locator('#label-count')).toHaveText('100/100');
  await label.pressSequentially('Z');
  await expect(label).toHaveValue(labelLimit);
  expect(await rejectPaste(label, 'extra')).toBe(true);
  await expect(label).toHaveValue(labelLimit);
  await expect(page.locator('#receive-error')).toContainText('100 characters');
  await expect(page.locator('#receive-error')).not.toContainText('extra');
  await label.fill('');
  const messageLimit = '😀'.repeat(50) + 'b'.repeat(150);
  await message.fill(messageLimit);
  await expect(message).toHaveValue(messageLimit);
  await expect(page.locator('#message-count')).toHaveText('200/200');
  await message.pressSequentially('Z');
  await expect(message).toHaveValue(messageLimit);
  expect(await rejectPaste(message, 'private-pasted-value'.repeat(100))).toBe(true);
  await expect(message).toHaveValue(messageLimit);
  await expect(page.locator('#receive-error')).toContainText('200 characters');
  await expect(page.locator('#receive-error')).not.toContainText('private-pasted-value');
  await message.fill('Order 42\nThank you');
  await expect(page.locator('#message-count')).toHaveText('18/200');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}?message=Order%2042%0AThank%20you`);
  await expect(page.locator('#receive-metadata-notice')).toContainText('not written to the blockchain');
});

test('only the newest request publishes QR, URI and copy together after rapid changes', async ({ page }) => {
  await isolateClipboard(page);
  await openReceive(page);
  await freezeReceiveTimers(page);
  await page.evaluate(() => {
    window.testReceiveStates = [];
    new MutationObserver(() => window.testReceiveStates.push({
      uri: document.getElementById('receive-uri').value,
      src: document.getElementById('receive-qr').getAttribute('src'),
      hidden: document.getElementById('qr-card').hidden,
      disabled: document.getElementById('copy-link').disabled,
    })).observe(document.getElementById('receive'), { attributes: true, subtree: true });
  });
  await page.locator('#receive-amount').fill('1.');
  await expect(page.locator('#copy-link')).toBeDisabled();
  await expect(page.locator('#receive-uri')).toHaveValue('');
  await expect(page.locator('#receive-qr')).not.toHaveAttribute('src');
  await page.clock.runFor(119);
  await page.locator('#receive-amount').fill('2,50');
  await page.locator('#receive-label').fill('Newest & only');
  await page.locator('#receive-message').fill('Order 2');
  await expect(page.locator('#copy-link')).toBeDisabled();
  await expect(page.locator('#qr-card')).toBeHidden();
  await page.clock.runFor(120);
  const uri = `connectcoin:${address}?amount=2.5&label=Newest%20%26%20only&message=Order%202`;
  await expect(page.locator('#copy-link')).toBeEnabled();
  await expect(page.locator('#receive-uri')).toHaveValue(uri);
  await expectQrMatches(page, uri);
  await page.locator('#copy-link').click();
  await expect(page.locator('#copy-status')).toHaveText('Payment link copied.');
  expect(await page.evaluate(() => window.testCopiedLink)).toBe(uri);
  const states = await page.evaluate(() => window.testReceiveStates);
  expect(states.some(state => state.disabled && state.hidden && state.uri === '' && state.src === null)).toBe(true);
  expect(states.some(state => !state.disabled)).toBe(true);
  for (const state of states.filter(state => !state.disabled)) {
    expect(state.uri).toBe(uri);
    expect(state.hidden).toBe(false);
    expect(state.src).toMatch(/^data:image\/png;base64,/);
  }
  await page.clock.runFor(1000);
  await expect(page.locator('#receive-uri')).toHaveValue(uri);
  await expectQrMatches(page, uri);
});

test('invalid requests remove the previously valid QR and disable every copy path', async ({ page }) => {
  await isolateClipboard(page);
  await openReceive(page);
  await page.locator('#receive-amount').fill('3');
  await expect(page.locator('#copy-link')).toBeEnabled();
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}?amount=3`);
  await page.locator('#copy-link').click();
  const previousCopy = await page.evaluate(() => window.testCopiedLink);
  for (const value of ['0.', '100000001']) {
    await page.locator('#receive-amount').fill(value);
    await expect(page.locator('#copy-link')).toBeDisabled();
    await expect(page.locator('#receive-uri')).toHaveValue('');
    await expect(page.locator('#receive-qr')).not.toHaveAttribute('src');
    await expect(page.locator('#qr-card')).toBeHidden();
    await expect(page.locator('#receive-error')).toContainText('greater than 0');
    await expect(page.locator('#copy-status')).toBeEmpty();
    // Even a programmatic click must not copy an old request from a closure.
    await page.locator('#copy-link').dispatchEvent('click');
    expect(await page.evaluate(() => window.testCopiedLink)).toBe(previousCopy);
  }
  await page.locator('#receive-amount').fill('');
  await page.locator('#receive-label').fill('😀'.repeat(100));
  await expect(page.locator('#label-count')).toHaveText('100/100');
  await expect(page.locator('#receive-error')).toContainText('too long for a QR code');
  await expect(page.locator('#copy-link')).toBeDisabled();
  await expect(page.locator('#receive-uri')).toHaveValue('');
  await expect(page.locator('#receive-qr')).not.toHaveAttribute('src');
});

test('clear details and reload restore an address-only request without saving metadata', async ({ page }) => {
  await openReceive(page);
  const draft = { 'receive-amount': '4,', 'receive-label': 'Private local draft', 'receive-message': 'Not persisted' };
  for (const [id, value] of Object.entries(draft)) await page.locator(`#${id}`).fill(value);
  await expect(page.locator('#receive-uri')).toHaveValue(new RegExp('amount=4&label='));
  await page.locator('#clear-request').click();
  for (const id of Object.keys(draft)) await expect(page.locator(`#${id}`)).toHaveValue('');
  await expect(page.locator('#label-count')).toHaveText('0/100');
  await expect(page.locator('#message-count')).toHaveText('0/200');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}`);
  await expectQrMatches(page, `connectcoin:${address}`);
  for (const [id, value] of Object.entries(draft)) await page.locator(`#${id}`).fill(value);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('CapacitorStorage.connectwallet.mobile.alpha.public-profile.v1'))).toContain(address);
  const saved = await page.evaluate(() => localStorage.getItem('CapacitorStorage.connectwallet.mobile.alpha.public-profile.v1'));
  expect(saved).not.toContain('Private local draft');
  expect(saved).not.toContain('Not persisted');
  await page.reload();
  await expect(page.locator('#current-address')).toHaveText(address);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  for (const id of Object.keys(draft)) await expect(page.locator(`#${id}`)).toHaveValue('');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}`);
});

test('removing or changing address cancels a queued QR and drops the previous draft', async ({ page }) => {
  await openReceive(page);
  await freezeReceiveTimers(page);
  await page.locator('#receive-label').fill('Old address draft');
  await page.locator('#receive-message').fill('Do not reuse');
  await page.getByRole('button', { name: 'Remove watched address', exact: true }).click();
  await expect(page.locator('#setup-panel')).toBeVisible();
  await expect(page.locator('#receive-uri')).toHaveValue('');
  await expect(page.locator('#receive-qr')).not.toHaveAttribute('src');
  await expect(page.locator('#copy-link')).toBeDisabled();
  await page.locator('#watch-address').fill(otherAddress);
  await page.getByRole('button', { name: 'Watch address', exact: true }).click();
  await expect(page.locator('#current-address')).toHaveText(otherAddress);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  for (const id of ['receive-amount', 'receive-label', 'receive-message']) await expect(page.locator(`#${id}`)).toHaveValue('');
  await page.clock.runFor(1000);
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${otherAddress}`);
  await expectQrMatches(page, `connectcoin:${otherAddress}`);
  await expect(page.locator('#receive-error')).toBeEmpty();
});

test('payment request fields, long links and QR fit the smallest supported viewport', async ({ page }) => {
  await isolateClipboard(page);
  await openReceive(page);
  await page.locator('#receive-amount').fill('12345678.1234567890');
  await page.locator('#receive-label').fill('a'.repeat(100));
  await page.locator('#receive-message').fill('b'.repeat(200));
  await expect(page.locator('#copy-link')).toBeEnabled();
  for (const size of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const id of ['receive-amount', 'receive-label', 'receive-message', 'receive-uri', 'copy-link']) {
      const bounds = await page.locator(`#${id}`).boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width);
    }
    await page.locator('#copy-link').click();
    await expect(page.locator('#copy-status')).toHaveText('Payment link copied.');
    expect(await page.evaluate(() => window.testCopiedLink)).toBe(await page.locator('#receive-uri').inputValue());
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.screenshot({ path: 'test-results/alpha-receive-small.png', fullPage: true });
});
