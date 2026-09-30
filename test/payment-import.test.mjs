import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { buildPaymentUri, parsePaymentUri, PAYMENT_URI_MAX_LENGTH } from '../src/core/payment-uri.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';
import { DEFAULT_CONFIG } from '../src/core/config.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';

const mnemonic = 'abandon '.repeat(11) + 'about';
const addresses = Object.fromEntries(['main', 'testnet4', 'regtest'].map(network => {
  const account = deriveAccount(mnemonic, { network }); account.privateKey.fill(0);
  return [network, account.address];
}));
const address = addresses.testnet4, uri = `connectcoin:${address}`;
const empty = { address, amount: '', label: '', message: '', ignoredParameters: [] };

test('imports ConnectWallet and uppercase Core requests without losing exact decimal or Unicode fields', () => {
  const fields = { address, amount: '0.0000000001', label: 'Café + tea 🍵 & shop', message: 'Line 1\nLine 2? # & = % + /' };
  assert.deepEqual(parsePaymentUri(buildPaymentUri(fields)), { ...fields, ignoredParameters: [] });
  assert.deepEqual(parsePaymentUri(`CONNECTCOIN:${address.toUpperCase()}/?amount=100000000.0000000000&label=A+B&message=%F0%9F%8D%B5`), {
    address, amount: '100000000', label: 'A+B', message: '🍵', ignoredParameters: [],
  });
  assert.deepEqual(parsePaymentUri(uri), empty);
  assert.deepEqual(parsePaymentUri(` ${uri} `), empty);
  assert.deepEqual(parsePaymentUri(`${uri}?amount=&label=&message=`), empty);
  assert.deepEqual(parsePaymentUri(`${uri}?req-amount=1.2300000000&req-label=Coffee&req-message=Order`), { ...empty, amount: '1.23', label: 'Coffee', message: 'Order' });
});

test('rejects malformed, ambiguous, lossy and out-of-range amounts', () => {
  for (const value of ['0', '0.0000000000', '-1', '+1', '01', '.1', '1.', '1,5', '1e2', 'Infinity', 'NaN', '1.00000000001', '100000000.0000000001', '100000001', '1000000000', ' 1', '1 ']) {
    assert.throws(() => parsePaymentUri(`${uri}?amount=${encodeURIComponent(value)}`), /amount/i, value);
  }
});

test('rejects duplicate fields including encoded names and required aliases', () => {
  for (const query of ['amount=1&amount=2', 'label=a&req-label=b', 'req-message=a&message=b', 'req-amount=1&amount=2', 'amount=1&%61mount=2', 'custom=a&custom=b']) {
    assert.throws(() => parsePaymentUri(`${uri}?${query}`), /duplicate/, query);
  }
});

test('ignores ordinary optional parameters explicitly but rejects unsupported payment instructions', () => {
  assert.deepEqual(parsePaymentUri(`${uri}?order-id=123&custom=ignored%20value&amount=1`), { ...empty, amount: '1', ignoredParameters: ['order-id', 'custom'] });
  for (const name of ['req-unknown', 'req-r', 'r', 'pj', 'pjos', 'payjoin', 'payment-protocol', 'network', 'chain', 'fee', 'feerate', 'fee-rate', 'feeRate', 'address', 'domain', 'lightning', 'lno', 'lna']) {
    assert.throws(() => parsePaymentUri(`${uri}?${name}=canary`), /feature|unsupported/, name);
  }
});

test('rejects malformed Unicode, percent escapes, controls and bidirectional text with fixed errors', () => {
  for (const value of ['%', '%0', '%zz', '%C0%AF', '%FF', '%ED%A0%80', '%E2%82', '\ud800', '\udc00', '%00', '%09', '%E2%80%AE', '%E2%81%A6']) {
    for (const name of ['label', 'message', 'custom']) {
      assert.throws(() => parsePaymentUri(`${uri}?${name}=${value}`), error => !error.message.includes('canary'), `${name}=${value}`);
    }
  }
  for (const name of ['label', 'custom']) assert.throws(() => parsePaymentUri(`${uri}?${name}=a%0Ab`), /unsupported/);
  assert.equal(parsePaymentUri(`${uri}?message=a%0D%0Ab`).message, 'a\nb');
  assert.throws(() => parsePaymentUri(`${uri}?%FF=canary`), error => !error.message.includes('canary'));
});

test('rejects wrong scheme, injection, malformed query and oversized requests without truncation', () => {
  for (const value of [undefined, null, {}, [], 1, '', address, `bitcoin:${address}`, `https://${address}`, `connectcoin://${address}`, `${uri}/path`, `${uri}//`, `${uri}#fragment`, `${uri}?label=hi#amount=1`, `${uri}?label=raw space`, `${uri}?`, `${uri}?label`, `${uri}?=1`, `${uri}?label=a&&amount=1`, `${uri}?label=a&`, `${uri}?Amount=1`, `connectcoin:${address[0].toUpperCase()}${address.slice(1)}`, `connectcoin:%74${address.slice(1)}`]) {
    assert.throws(() => parsePaymentUri(value));
  }
  assert.throws(() => parsePaymentUri(`${uri}?label=${'a'.repeat(101)}`), /100 characters/);
  assert.throws(() => parsePaymentUri(`${uri}?message=${'a'.repeat(201)}`), /200 characters/);
  const atLimit = `${uri}?custom=${'a'.repeat(PAYMENT_URI_MAX_LENGTH - uri.length - 8)}`;
  assert.equal(atLimit.length, PAYMENT_URI_MAX_LENGTH);
  assert.deepEqual(parsePaymentUri(atLimit).ignoredParameters, ['custom']);
  assert.throws(() => parsePaymentUri(`${atLimit}a`), /1024/);
});

function fixture(t) {
  const service = new WalletService({ directory: process.cwd() });
  service.config = structuredClone(DEFAULT_CONFIG);
  service.session = { data: {} };
  t.after(() => service.statePublisher.close());
  return service;
}

test('service validates the checksum and current network locally with no RPC or side effects', t => {
  const service = fixture(t);
  const sentinel = {}; service.preview = sentinel;
  service.rpc = { request() { assert.fail('Import must not call RPC'); } };
  assert.deepEqual(service.parsePaymentRequest({ uri }), empty);
  assert.equal(service.preview, sentinel);
  const replacement = address.at(-1) === 'q' ? 'p' : 'q';
  for (const badAddress of [address.slice(0, -1) + replacement, addresses.main, addresses.regtest]) {
    assert.throws(() => service.parsePaymentRequest({ uri: `connectcoin:${badAddress}` }), error => {
      assert.match(error.message, /invalid or belongs to a different network/);
      assert.ok(!error.message.includes(badAddress)); return true;
    });
  }
  service.session = null;
  assert.throws(() => service.parsePaymentRequest({ uri }), /locked or changed/);
});

test('preload exposes only the intended importer method', async () => {
  let exposed;
  const calls = [];
  runInNewContext(await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return {
      contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true, value: empty }; } },
    }; }, window: { addEventListener() {} },
  });
  assert.deepEqual(await exposed.invoke('pastePaymentRequest'), empty);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['connectwallet:action', 'pastePaymentRequest', {}]]);
  await assert.rejects(exposed.invoke('parsePaymentRequest', { uri }), /Unsupported wallet action/);
  await assert.rejects(exposed.invoke('readClipboard'), /Unsupported wallet action/);
  await assert.rejects(exposed.invoke('parsePaymentUri', { uri }), /Unsupported wallet action/);
});

async function pasteFixture(t) {
  const service = fixture(t);
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("ipcMain.handle('connectwallet:action'");
  const end = source.indexOf("window.once('ready-to-show'", start);
  const whitelist = source.match(/const SERVICE_METHODS = ([^\n]+);/)[1];
  let handler;
  const clipboard = { text: uri, reads: 0, error: null, readText() {
    this.reads++;
    if (this.error) throw this.error;
    return this.text;
  } };
  const frame = { url: 'file:///wallet/index.html' }, webContents = { mainFrame: frame };
  runInNewContext(`const SERVICE_METHODS = ${whitelist};\nlet actionInProgress = true;\n${source.slice(start, end)}`, {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } }, service,
    window: { webContents }, UI_URL: frame.url, Buffer, clipboard,
  });
  const event = { sender: webContents, senderFrame: frame };
  return { service, clipboard, handler, event, frame };
}

test('main IPC reads clipboard only for trusted unlocked Paste requests, including during refresh', async t => {
  const { service, clipboard, handler, event, frame } = await pasteFixture(t);
  assert.equal(clipboard.reads, 0);
  const reply = await handler(event, 'pastePaymentRequest', {});
  assert.equal(reply.ok, true); assert.deepEqual(reply.value, empty);
  assert.equal(clipboard.reads, 1);
  assert.equal((await handler({ ...event, senderFrame: { url: frame.url } }, 'pastePaymentRequest', {})).ok, false);
  assert.equal((await handler({ ...event, sender: {} }, 'pastePaymentRequest', {})).ok, false);
  assert.equal((await handler(event, 'pastePaymentRequest', null)).ok, false);
  assert.equal(clipboard.reads, 1);
  clipboard.text = `${uri}?req-canary=attacker-canary`;
  const invalid = await handler(event, 'pastePaymentRequest', {});
  assert.equal(invalid.ok, false); assert.ok(!invalid.error.includes('canary'));
  assert.equal(clipboard.reads, 2);
  service.session = null;
  assert.match((await handler(event, 'pastePaymentRequest', {})).error, /locked or changed/);
  assert.equal(clipboard.reads, 2, 'locked wallet must not read clipboard');
});

test('clipboard failures, unrelated text and oversized links never expose clipboard content', async t => {
  const { clipboard, handler, event } = await pasteFixture(t);
  for (const value of ['', ' \n ', 'private clipboard canary', `${uri}?label=${'s'.repeat(100000)}`]) {
    clipboard.text = value;
    const reply = await handler(event, 'pastePaymentRequest', {});
    assert.equal(reply.ok, false);
    assert.equal(reply.value, undefined);
    assert.ok(!reply.error.includes('canary'));
    assert.ok(reply.error.length < 300);
  }
  clipboard.error = new Error('clipboard private canary');
  const reply = await handler(event, 'pastePaymentRequest', {});
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Could not read the clipboard/);
  assert.ok(!reply.error.includes('canary'));
});

test('Paste snapshots clipboard once, ignores renderer URI and refuses a late result after locking', async t => {
  const { service, clipboard, handler, event } = await pasteFixture(t);
  const original = service.parsePaymentRequest.bind(service);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  service.parsePaymentRequest = async payload => {
    const result = original(payload);
    await gate;
    return result;
  };
  const reply = handler(event, 'pastePaymentRequest', { uri: 'private renderer canary' });
  assert.equal(clipboard.reads, 1);
  clipboard.text = 'changed clipboard canary';
  service.session = null;
  service.epoch++;
  release();
  const result = await reply;
  assert.equal(result.ok, false);
  assert.match(result.error, /locked or changed/);
  assert.equal(clipboard.reads, 1);
  assert.equal(result.value, undefined);
});
