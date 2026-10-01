import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { buildPaymentUri, parsePaymentUri, parseClipboardPaymentText, PAYMENT_URI_MAX_LENGTH } from '../src/core/payment-uri.mjs';
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

test('clipboard parser distinguishes a plain address from a URI without weakening URI-only parsing', () => {
  for (const text of [address, address.toUpperCase(), ` ${address} `]) {
    assert.deepEqual(parseClipboardPaymentText(text), { ...empty, kind: 'address' });
    assert.throws(() => parsePaymentUri(text), /connectcoin:/);
  }
  const fields = { address, amount: '0.0000000001', label: 'Café 🍵', message: 'Line 1\nLine 2' };
  for (const text of [uri, ` ${uri} `, `CONNECTCOIN:${address.toUpperCase()}/`]) {
    assert.deepEqual(parseClipboardPaymentText(text), { ...empty, kind: 'uri' });
  }
  assert.deepEqual(parseClipboardPaymentText(buildPaymentUri(fields)), { ...fields, ignoredParameters: [], kind: 'uri' });
  assert.equal(Object.hasOwn(parsePaymentUri(uri), 'kind'), false);
});

test('clipboard parser rejects unrelated text, address injection, mixed case, controls and oversize text', () => {
  for (const text of [undefined, null, 1, [], {}, '', ' ', 'private clipboard canary',
    `https://${address}`, `bitcoin:${address}`, `${address}?amount=1`, `${address}/`, `${address}#fragment`,
    `${address} ${address}`, `${address[0].toUpperCase()}${address.slice(1)}`, address.slice(0, -1),
    `${address}\n`, `\t${address}`, `${address}\r\n`, `${uri}\n`, `${address}\u0000`, `${address}\ud800`,
    `${address}\u202e`, `\u2066${address}`, `${address}${' '.repeat(PAYMENT_URI_MAX_LENGTH)}`]) {
    assert.throws(() => parseClipboardPaymentText(text), error => {
      assert.ok(!error.message.includes('canary'));
      assert.ok(!error.message.includes(address));
      return true;
    });
  }
  const atLimit = `${uri}?custom=${'a'.repeat(PAYMENT_URI_MAX_LENGTH - uri.length - 8)}`;
  assert.deepEqual(parseClipboardPaymentText(atLimit).ignoredParameters, ['custom']);
  assert.throws(() => parseClipboardPaymentText(`${atLimit}a`), /1024/);
});

test('clipboard URI validation never falls back to a plain address after an invalid payment instruction', () => {
  for (const query of ['amount=1e2', 'amount=1&amount=2', 'amount=1&req-amount=2',
    'req-unknown=canary', 'r=https%3A%2F%2Fexample.com', 'network=main', 'fee=1',
    'label=%FF', 'label=%00', 'message=%E2%80%AE', 'label=hi#fragment', '']) {
    const text = `${uri}?${query}`;
    let expectedError;
    assert.throws(() => parsePaymentUri(text), error => { expectedError = error.message; return true; });
    assert.throws(() => parseClipboardPaymentText(text), error => error.message === expectedError);
  }
});

test('address normalization never repairs a non-ASCII Unicode lookalike', t => {
  const account = deriveAccount(mnemonic, { network: 'testnet4', index: 1 });
  account.privateKey.fill(0);
  const uppercase = account.address.toUpperCase();
  assert.ok(uppercase.includes('K'));
  const lookalike = uppercase.replace('K', '\u212a');
  assert.equal(lookalike.toLowerCase(), account.address, 'Kelvin sign folds to an ASCII k');
  const service = fixture(t);
  assert.equal(service.parseClipboardPaymentRequest({ text: uppercase }).address, account.address);
  assert.throws(() => parsePaymentUri(`connectcoin:${lookalike}`), /supported ConnectCoin address/);
  for (const text of [lookalike, `connectcoin:${lookalike}`]) {
    assert.throws(() => parseClipboardPaymentText(text));
    assert.throws(() => service.parseClipboardPaymentRequest({ text }));
  }
});

function fixture(t) {
  const service = new WalletService({ directory: process.cwd() });
  service.config = { ...structuredClone(DEFAULT_CONFIG), network: 'testnet4' };
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

test('clipboard service verifies both kinds locally against checksum and the current wallet network', t => {
  const service = fixture(t);
  const sentinel = {}; service.preview = sentinel;
  service.rpc = { request() { assert.fail('Clipboard import must not call RPC'); } };
  for (const network of ['main', 'testnet4', 'regtest']) {
    service.config.network = network;
    const expected = { ...empty, address: addresses[network] };
    assert.deepEqual(service.parseClipboardPaymentRequest({ text: addresses[network].toUpperCase() }), { ...expected, kind: 'address' });
    assert.deepEqual(service.parseClipboardPaymentRequest({ text: `connectcoin:${addresses[network]}` }), { ...expected, kind: 'uri' });
    assert.equal(service.preview, sentinel);
    assert.deepEqual(service.session.data, {});
    const replacement = addresses[network].at(-1) === 'q' ? 'p' : 'q';
    const invalid = [addresses[network].slice(0, -1) + replacement, ...Object.entries(addresses).filter(([chain]) => chain !== network).map(([, value]) => value)];
    for (const badAddress of invalid) {
      for (const text of [badAddress, `connectcoin:${badAddress}`]) {
        assert.throws(() => service.parseClipboardPaymentRequest({ text }), error => {
          assert.match(error.message, /invalid or belongs to a different network/);
          assert.ok(!error.message.includes(badAddress)); return true;
        });
      }
    }
  }
  service.session = null;
  for (const text of [address, uri]) assert.throws(() => service.parseClipboardPaymentRequest({ text }), /locked or changed/);
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
  await assert.rejects(exposed.invoke('parseClipboardPaymentRequest', { text: address }), /Unsupported wallet action/);
  await assert.rejects(exposed.invoke('parseClipboardPaymentText', { text: address }), /Unsupported wallet action/);
});

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function pasteFixture(t, { actionInProgress = true } = {}) {
  const service = fixture(t);
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("ipcMain.handle('connectwallet:action'");
  const end = source.indexOf("window.once('ready-to-show'", start);
  const whitelist = source.match(/const SERVICE_METHODS = ([^\n]+);/)[1];
  let handler;
  const clipboard = {
    text: uri, reads: 0, error: null, readGate: null,
    writes: [], writeError: null, writeGate: null,
    // Electron 44 returns Promises, even without a deliberately delayed OS read.
    async readText() {
      this.reads++;
      const text = this.text;
      if (this.readGate) await this.readGate;
      if (this.error) throw this.error;
      return text;
    },
    async writeText(text) {
      this.writes.push(text);
      if (this.writeGate) await this.writeGate;
      if (this.writeError) throw this.writeError;
    },
  };
  const frame = { url: 'file:///wallet/index.html' }, webContents = { mainFrame: frame };
  runInNewContext(`const SERVICE_METHODS = ${whitelist};\nlet actionInProgress = ${actionInProgress};\n${source.slice(start, end)}`, {
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
  assert.equal(reply.ok, true); assert.deepEqual(reply.value, { ...empty, kind: 'uri' });
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

test('main IPC returns only the normalized address or complete URI fields, never renderer-supplied text', async t => {
  const { service, clipboard, handler, event } = await pasteFixture(t);
  const sentinel = {}; service.preview = sentinel;
  clipboard.text = ` ${address.toUpperCase()} `;
  const bare = await handler(event, 'pastePaymentRequest', { text: 'private renderer canary', uri: `${uri}?amount=99` });
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.value, { ...empty, kind: 'address' });
  clipboard.text = `${uri}?amount=1.0000000001&label=Coffee&message=Order&custom=canary`;
  const payment = await handler(event, 'pastePaymentRequest', {});
  assert.equal(payment.ok, true);
  assert.deepEqual(payment.value, { ...empty, kind: 'uri', amount: '1.0000000001', label: 'Coffee', message: 'Order', ignoredParameters: ['custom'] });
  assert.ok(!JSON.stringify(payment).includes('canary'));
  assert.equal(clipboard.reads, 2);
  assert.equal(service.preview, sentinel);
});

test('main IPC awaits one delayed clipboard read before parsing or replying', async t => {
  const { service, clipboard, handler, event } = await pasteFixture(t);
  const read = Promise.withResolvers();
  clipboard.readGate = read.promise;
  let parses = 0, settled = false;
  const original = service.parseClipboardPaymentRequest.bind(service);
  service.parseClipboardPaymentRequest = payload => { parses++; return original(payload); };
  const pending = handler(event, 'pastePaymentRequest', { text: 'private renderer canary' });
  pending.then(() => { settled = true; });
  try {
    await nextTurn();
    assert.equal(clipboard.reads, 1);
    assert.equal(parses, 0);
    assert.equal(settled, false);
    clipboard.text = 'changed clipboard canary';
  } finally { read.resolve(); }
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { ...empty, kind: 'uri' });
  assert.equal(parses, 1);
  assert.equal(clipboard.reads, 1);
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

test('non-string async clipboard results receive a friendly fixed error without parsing or coercion', async t => {
  const { service, clipboard, handler, event } = await pasteFixture(t);
  let parses = 0;
  service.parseClipboardPaymentRequest = () => { parses++; return empty; };
  const privateObject = { value: 'private clipboard canary', toString() { assert.fail('Clipboard objects must not be coerced'); } };
  let expectedError;
  for (const value of [undefined, null, 42, false, [], privateObject]) {
    clipboard.text = value;
    const result = await handler(event, 'pastePaymentRequest', {});
    assert.equal(result.ok, false);
    assert.equal(result.value, undefined);
    assert.match(result.error, /clipboard|Copy/i);
    assert.doesNotMatch(result.error, /canary|TypeError|trim|is not a function|toString/);
    assert.ok(result.error.length < 300);
    expectedError ??= result.error;
    assert.equal(result.error, expectedError);
  }
  assert.equal(parses, 0);
  assert.equal(clipboard.reads, 6);
});

test('lock or wallet epoch changes during an async clipboard read prevent parsing and returning its result', async t => {
  for (const change of ['lock', 'epoch']) {
    const { service, clipboard, handler, event } = await pasteFixture(t);
    const read = Promise.withResolvers();
    clipboard.readGate = read.promise;
    let parses = 0;
    service.parseClipboardPaymentRequest = () => { parses++; return { ...empty, kind: 'uri' }; };
    const pending = handler(event, 'pastePaymentRequest', {});
    try {
      await nextTurn();
      assert.equal(clipboard.reads, 1);
      assert.equal(parses, 0);
      if (change === 'lock') service.session = null;
      else service.epoch++;
    } finally { read.resolve(); }
    const result = await pending;
    assert.equal(result.ok, false);
    assert.match(result.error, /locked or changed/);
    assert.equal(result.value, undefined);
    assert.equal(parses, 0, 'Do not parse a clipboard read from a discarded security context');
    assert.equal(clipboard.reads, 1);
  }
});

test('Paste snapshots clipboard once, ignores renderer URI and refuses a late result after locking', async t => {
  const { service, clipboard, handler, event } = await pasteFixture(t);
  const original = service.parseClipboardPaymentRequest.bind(service);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered = false;
  service.parseClipboardPaymentRequest = async payload => {
    const result = original(payload);
    entered = true;
    await gate;
    return result;
  };
  const reply = handler(event, 'pastePaymentRequest', { uri: 'private renderer canary' });
  try {
    await nextTurn();
    assert.equal(entered, true, 'Wait for the async clipboard read before testing the later parse race');
    assert.equal(clipboard.reads, 1);
    clipboard.text = 'changed clipboard canary';
    service.session = null;
    service.epoch++;
  } finally { release(); }
  const result = await reply;
  assert.equal(result.ok, false);
  assert.match(result.error, /locked or changed/);
  assert.equal(clipboard.reads, 1);
  assert.equal(result.value, undefined);
});

async function copyFixture(t) {
  const context = await pasteFixture(t, { actionInProgress: false });
  context.service.session.data.receiveIndex = 0;
  context.service.accounts = [{ address, change: 0, index: 0 }];
  context.service.getState = () => ({ wallet: { address } });
  const payment = { amount: '1.5', label: 'Coffee' };
  const expectedUri = buildPaymentUri({ address, ...payment });
  return { ...context, expectedUri, payload: { ...payment, expectedAddress: address, expectedUri } };
}

test('Copy address and payment request await the async clipboard write before reporting success', async t => {
  for (const method of ['copyAddress', 'copyPaymentRequest']) {
    const { clipboard, handler, event, payload, expectedUri } = await copyFixture(t);
    const write = Promise.withResolvers();
    clipboard.writeGate = write.promise;
    let settled = false;
    const pending = handler(event, method, method === 'copyAddress' ? {} : payload);
    pending.then(() => { settled = true; });
    try {
      await nextTurn();
      assert.deepEqual(clipboard.writes, [method === 'copyAddress' ? address : expectedUri]);
      assert.equal(settled, false, 'An unfinished OS clipboard write is not a successful copy');
      const overlapping = await handler(event, method, method === 'copyAddress' ? {} : payload);
      assert.equal(overlapping.ok, false);
      assert.match(overlapping.error, /in progress/);
      assert.equal(clipboard.writes.length, 1);
    } finally { write.resolve(); }
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.value.copied, true);
    assert.equal(clipboard.reads, 0);
  }
});

test('async clipboard write rejections never report copied or expose private platform errors', async t => {
  for (const method of ['copyAddress', 'copyPaymentRequest']) {
    const { clipboard, handler, event, payload } = await copyFixture(t);
    let expectedError;
    for (const privateError of ['private clipboard canary', 'another private platform detail']) {
      clipboard.writeError = new Error(privateError);
      const result = await handler(event, method, method === 'copyAddress' ? {} : payload);
      assert.equal(result.ok, false);
      assert.equal(result.value, undefined);
      assert.match(result.error, /Could not copy|Could not write|clipboard/i);
      assert.doesNotMatch(result.error, /canary|private|platform detail/);
      expectedError ??= result.error;
      assert.equal(result.error, expectedError);
    }
    clipboard.writeError = null;
    const retry = await handler(event, method, method === 'copyAddress' ? {} : payload);
    assert.equal(retry.ok, true, 'A rejected clipboard write must release the action gate');
    assert.equal(retry.value.copied, true);
  }
});

test('an async clipboard write completing after lock or epoch change never reports stale success', async t => {
  for (const method of ['copyAddress', 'copyPaymentRequest']) {
    for (const change of ['lock', 'epoch']) {
      const { service, clipboard, handler, event, payload } = await copyFixture(t);
      const write = Promise.withResolvers();
      clipboard.writeGate = write.promise;
      const pending = handler(event, method, method === 'copyAddress' ? {} : payload);
      try {
        await nextTurn();
        assert.equal(clipboard.writes.length, 1);
        if (change === 'lock') service.session = null;
        else service.epoch++;
      } finally { write.resolve(); }
      const result = await pending;
      assert.equal(result.ok, false);
      assert.match(result.error, /locked or changed/);
      assert.equal(result.value, undefined);
      // An OS write that already began is not cancellable; only its stale
      // success notification is suppressed. Do not falsely test native undo.
      assert.equal(clipboard.writes.length, 1);
    }
  }
});
