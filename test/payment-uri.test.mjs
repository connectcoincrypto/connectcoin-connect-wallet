import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import QRCode from 'qrcode';
import { buildPaymentUri, PAYMENT_LABEL_MAX_LENGTH, PAYMENT_MESSAGE_MAX_LENGTH, PAYMENT_URI_MAX_LENGTH } from '../src/core/payment-uri.mjs';
import { paymentQrDataUrl } from '../src/core/payment-qr.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';
import { DEFAULT_CONFIG } from '../src/core/config.mjs';

const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const accounts = [0, 1].map(index => {
  const { privateKey, ...account } = deriveAccount(mnemonic, { index });
  privateKey.fill(0);
  return account;
});
const address = accounts[0].address;
const baseUri = `connectcoin:${address}`;

function serviceFixture(t) {
  const service = new WalletService({ directory: process.cwd() });
  service.config = structuredClone(DEFAULT_CONFIG);
  service.session = { data: { receiveIndex: 0, name: 'Payment request test' } };
  service.walletExists = true;
  service.accounts = accounts;
  service.connectClient = () => {};
  t.after(() => service.statePublisher.close());
  return service;
}

test('payment URI omits blank optional fields and keeps an exact decimal amount', () => {
  assert.equal(buildPaymentUri({ address }), baseUri);
  assert.equal(buildPaymentUri({ address, amount: ' ', label: '\t ', message: '\n ' }), baseUri);
  assert.equal(buildPaymentUri({ address, amount: ' 1.2300000000 ' }), `${baseUri}?amount=1.23`);
  assert.equal(buildPaymentUri({ address, amount: '0.0000000001' }), `${baseUri}?amount=0.0000000001`);
  assert.equal(buildPaymentUri({ address, amount: '100000000.0000000000' }), `${baseUri}?amount=100000000`);
});

test('payment URI rejects lossy, ambiguous, zero and out-of-range amounts', () => {
  for (const amount of [0, 1, 1n, null, false, [], {}, '0', '0.0000000000', '-1', '+1', '.1', '1.', '1,5', '01', '1e2', 'NaN', 'Infinity', '1.00000000001', '100000000.0000000001', '100000001', '1000000000']) {
    assert.throws(() => buildPaymentUri({ address, amount }), /amount/i, String(amount));
  }
});

test('payment URI escapes Unicode and query characters without form-style plus encoding', () => {
  const label = 'Café & shop + 🍵';
  const message = 'pedido?amount=999#x / 50%';
  const uri = buildPaymentUri({ address, amount: '2.5', label, message });
  assert.equal(uri, `${baseUri}?amount=2.5&label=Caf%C3%A9%20%26%20shop%20%2B%20%F0%9F%8D%B5&message=pedido%3Famount%3D999%23x%20%2F%2050%25`);
  const parsed = new URL(uri);
  assert.equal(parsed.searchParams.get('label'), label);
  assert.equal(parsed.searchParams.get('message'), message);
  assert.deepEqual([...parsed.searchParams.keys()], ['amount', 'label', 'message']);
  assert.equal(parsed.hash, '');
});

test('payment URI bounds Unicode text and encoded QR length and rejects malformed text', () => {
  assert.equal(PAYMENT_LABEL_MAX_LENGTH, 100);
  assert.equal(PAYMENT_MESSAGE_MAX_LENGTH, 200);
  const label = '🍵'.repeat(10) + 'a'.repeat(90);
  assert.equal(new URL(buildPaymentUri({ address, label })).searchParams.get('label'), label);
  assert.ok(buildPaymentUri({ address, message: 'a'.repeat(200) }).length <= PAYMENT_URI_MAX_LENGTH);
  assert.throws(() => buildPaymentUri({ address, label: 'a'.repeat(101) }), /100 characters/);
  assert.throws(() => buildPaymentUri({ address, message: 'a'.repeat(201) }), /200 characters/);
  assert.throws(() => buildPaymentUri({ address, label: '🍵'.repeat(100), message: '🍵'.repeat(200) }), /too long for a QR code/);
  for (const value of [null, 123, {}, [], 'a\u0000b', 'a\tb', '\ud800', '\udc00']) {
    assert.throws(() => buildPaymentUri({ address, label: value }), /Label/);
    assert.throws(() => buildPaymentUri({ address, message: value }), /Message/);
  }
  assert.throws(() => buildPaymentUri({ address, label: 'a\nb' }), /Label/);
  assert.equal(buildPaymentUri({ address, message: 'a\r\nb\nc' }), `${baseUri}?message=a%0Ab%0Ac`);
});

test('payment URI rejects address injection and unsupported address shapes', () => {
  for (const invalid of [undefined, null, '', `${address}?amount=1`, `${address}#x`, ` ${address}`, address.toUpperCase(), 'https://example.com', address.slice(0, -1)]) {
    assert.throws(() => buildPaymentUri({ address: invalid }), /receive address/);
  }
});

test('payment QR preserves a quiet zone and integer pixels per module for small and large requests', async () => {
  for (const uri of [baseUri, buildPaymentUri({ address, message: '🍵'.repeat(70) })]) {
    const options = { errorCorrectionLevel: 'M', margin: 4, color: { dark: '#17211b', light: '#ffffff' } };
    const modules = QRCode.create(uri, options).modules.size + 8;
    const width = modules * Math.max(4, Math.ceil(280 / modules));
    const expected = await QRCode.toDataURL(uri, { ...options, width });
    const actual = await paymentQrDataUrl(uri);
    assert.equal(actual, expected);
    const png = Buffer.from(actual.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), width);
    assert.equal(width % modules, 0);
    assert.ok(width >= 280 && width / modules >= 4);
  }
});

test('payment requests use only the current unlocked wallet address and encode the full URI', async t => {
  const service = serviceFixture(t);
  const fields = { amount: '1.23', label: 'Coffee', message: 'Thanks!' };
  const request = await service.paymentRequest({ ...fields, address: accounts[1].address });
  assert.equal(request.address, address);
  assert.equal(request.uri, buildPaymentUri({ address, ...fields }));
  assert.equal(request.qrDataUrl, await paymentQrDataUrl(request.uri));
  await service.makeQR();
  assert.equal(service.qrDataUrl, await paymentQrDataUrl(baseUri));
  await service.lock();
  await assert.rejects(service.paymentRequest(fields), /locked or changed/);
});

test('locking while a request QR renders rejects the pending result', async t => {
  const service = serviceFixture(t);
  let finish;
  t.mock.method(QRCode, 'toDataURL', () => new Promise(resolve => { finish = resolve; }));
  const pending = service.paymentRequest({ label: 'before lock' });
  await service.lock();
  finish('data:image/png;base64,stale');
  await assert.rejects(pending, /locked or changed/);
  assert.equal(service.qrDataUrl, null);
});

test('address changes invalidate pending requests and prevent stale default QR replacement', async t => {
  const service = serviceFixture(t);
  const completions = [];
  t.mock.method(QRCode, 'toDataURL', () => new Promise(resolve => { completions.push(resolve); }));
  const pending = service.paymentRequest();
  const oldDefaultQr = service.makeQR();
  service.session.data.receiveIndex = 1;
  service.qrDataUrl = 'current-address-qr';
  completions.forEach(finish => finish('stale-address-qr'));
  await assert.rejects(pending, /receive address changed/);
  await oldDefaultQr;
  assert.equal(service.qrDataUrl, 'current-address-qr');
});

test('copy validation requires the displayed address and URI and rejects stale or edited requests', t => {
  const service = serviceFixture(t);
  const fields = { amount: '1.5', label: 'Coffee' };
  const expectedUri = buildPaymentUri({ address, ...fields });
  const payload = { ...fields, expectedUri, expectedAddress: address };
  assert.deepEqual(service.paymentRequestForCopy(payload), { address, uri: expectedUri });
  for (const invalid of [{ ...fields }, { ...payload, amount: '2' }, { ...payload, expectedUri: `${expectedUri}&amount=99` }, { ...payload, expectedAddress: accounts[1].address }]) {
    assert.throws(() => service.paymentRequestForCopy(invalid), /request changed/);
  }
  service.session.data.receiveIndex = 1;
  assert.throws(() => service.paymentRequestForCopy(payload), /request changed/);
  service.session = null;
  assert.throws(() => service.paymentRequestForCopy(payload), /locked or changed/);
});

test('preload exposes only the intended request actions', async () => {
  let exposed;
  const calls = [];
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
    ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true, value: { accepted: true } }; } },
  };
  runInNewContext(await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return electron; }, window: { addEventListener() {} },
  });
  const payload = { label: 'Coffee' };
  await exposed.invoke('paymentRequest', payload);
  await exposed.invoke('copyPaymentRequest', payload);
  assert.deepEqual(calls, [['connectwallet:action', 'paymentRequest', payload], ['connectwallet:action', 'copyPaymentRequest', payload]]);
  for (const action of ['paymentRequestUri', 'paymentRequestForCopy', 'makeQR', 'writeClipboard']) await assert.rejects(exposed.invoke(action), /Unsupported wallet action/);
});

test('main IPC copies only regenerated current requests from the trusted renderer', async t => {
  const service = serviceFixture(t);
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("ipcMain.handle('connectwallet:action'");
  const end = source.indexOf("window.once('ready-to-show'", start);
  const whitelist = source.match(/const SERVICE_METHODS = ([^\n]+);/)[1];
  let handler;
  const copied = [];
  const frame = { url: 'file:///wallet/index.html' };
  const webContents = { mainFrame: frame };
  runInNewContext(`const SERVICE_METHODS = ${whitelist};\nlet actionInProgress = false;\n${source.slice(start, end)}`, {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } }, service,
    window: { webContents }, UI_URL: frame.url, Buffer,
    clipboard: { writeText: value => copied.push(value) },
  });
  const event = { sender: webContents, senderFrame: frame };
  const requestReply = await handler(event, 'paymentRequest', { amount: '1.25' });
  assert.equal(requestReply.ok, true);
  assert.equal(requestReply.value.uri, `${baseUri}?amount=1.25`);
  const payload = { amount: '1.25', expectedUri: requestReply.value.uri, expectedAddress: address };
  assert.equal((await handler(event, 'copyPaymentRequest', payload)).ok, true);
  assert.deepEqual(copied, [requestReply.value.uri]);
  assert.equal((await handler(event, 'copyPaymentRequest', { ...payload, expectedUri: 'connectcoin:attacker' })).ok, false);
  assert.equal((await handler({ ...event, senderFrame: { url: frame.url } }, 'copyPaymentRequest', payload)).ok, false);
  let releaseRefresh;
  service.refresh = () => new Promise(resolve => { releaseRefresh = resolve; });
  const refreshing = handler(event, 'refresh', {});
  try {
    const duringRefresh = await handler(event, 'paymentRequest', { amount: '2' });
    assert.equal(duringRefresh.ok, true, 'Read-only QR previews must not fail behind a slow refresh.');
    assert.equal(duringRefresh.value.uri, `${baseUri}?amount=2`);
    assert.equal((await handler(event, 'copyPaymentRequest', payload)).ok, false, 'Copy/mutation serialization must remain intact.');
  } finally { releaseRefresh(); await refreshing; }
  service.session.data.receiveIndex = 1;
  assert.equal((await handler(event, 'copyPaymentRequest', payload)).ok, false);
  assert.deepEqual(copied, [requestReply.value.uri]);
});
