import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import { parsePaymentUri } from '../../src/core/payment-uri.mjs';
import { createReceiveRequest, RECEIVE_REQUEST_LIMITS, RECEIVE_METADATA_NOTICE } from '../src/receive-request.mjs';

// Known public point only. These tests do not derive or retain any private key.
const key = secp256k1.Point.BASE.toBytes(true).slice(1);
const words = [1, ...bech32m.toWords(key)];
const address = bech32m.encode('cc', words);
const request = fields => createReceiveRequest({ address, ...fields });

test('an address-only request has no optional URI fields and contains no secret data', () => {
  assert.deepEqual(request(), { uri: `connectcoin:${address}`, address, amount: '', label: '', message: '' });
  assert.equal(createReceiveRequest({ address: address.toUpperCase() }).address, address);
  assert.deepEqual(Reflect.ownKeys(request()), ['uri', 'address', 'amount', 'label', 'message']);
  assert.match(RECEIVE_METADATA_NOTICE, /label and message/);
  assert.match(RECEIVE_METADATA_NOTICE, /not written to the blockchain/);
  assert.match(RECEIVE_METADATA_NOTICE, /Anyone with the link or QR code can read/);
});

test('amount normalization accepts comma, trailing separator and leading zeros without rounding', () => {
  for (const [input, canonical] of [
    ['1.', '1'], ['1,', '1'], ['1,2300000000', '1.23'], ['1.2345678901', '1.2345678901'],
    ['000001.2300', '1.23'], ['.5', '0.5'], [',5', '0.5'], ['0.0000000001', '0.0000000001'],
    ['100000000.', '100000000'], ['100000000,0000000000', '100000000'],
  ]) {
    const result = request({ amount: input });
    assert.equal(result.amount, canonical, input);
    assert.equal(result.uri, `connectcoin:${address}?amount=${canonical}`);
    assert.equal(parsePaymentUri(result.uri).amount, canonical);
  }
});

test('filled amounts must be positive, in range and have at most ten fraction digits', () => {
  const invalid = ['0', '0.', '0,', '.', ',', '0000.0000000000', '-1', '+1', '1e2', 'NaN', 'Infinity',
    '100000000.0000000001', '100000001', '999999999', '1000000000', '1.12345678901',
    '1,12345678901', '1.00000000000', '0.00000000001', '1..', '1,,', '1.,', '1,2.3',
    '1.000,50', '1,000.50', '1 000', ' 1', '1 ', '1\n', '1\u2028', '１', '٠', '1'.repeat(65),
    1, 1n, null, [], { toString: () => '1' }];
  for (const amount of invalid) assert.throws(() => request({ amount }), undefined, String(amount));
});

test('builder rejects wrong-network, malformed checksum and invalid curve addresses', () => {
  const invalid = [bech32m.encode('tcc', words), bech32m.encode('ccrt', words),
    bech32m.encode('cc', [1, ...bech32m.toWords(new Uint8Array(32).fill(255))]),
    address.slice(0, -1) + (address.endsWith('q') ? 'p' : 'q'), '', null, 42, `${address}?amount=1`,
    `connectcoin:${address}?req-unsafe=value`, 'https://example.invalid/'];
  for (const bad of invalid) assert.throws(() => createReceiveRequest({ address: bad }), /valid ConnectCoin mainnet/);
});

test('only explicit form details enter a request even if the address came from a validated URI', () => {
  assert.deepEqual(createReceiveRequest({ address: `connectcoin:${address}?amount=90&label=Old&message=Old`, amount: '2', label: 'New' }), {
    uri: `connectcoin:${address}?amount=2&label=New`, address, amount: '2', label: 'New', message: '',
  });
});

test('labels and messages share desktop normalization and URI encoding exactly', () => {
  const result = request({ amount: '1,25', label: '  My shop & café + #1  ', message: '  Order=42\r\nSecond line\rThird line  ' });
  assert.equal(result.label, 'My shop & café + #1');
  assert.equal(result.message, 'Order=42\nSecond line\nThird line');
  const decoded = parsePaymentUri(result.uri);
  assert.deepEqual(decoded, { address, amount: '1.25', label: result.label, message: result.message, ignoredParameters: [] });
  assert.ok(result.uri.includes('%26'));
  assert.ok(result.uri.includes('%2B'));
  assert.ok(result.uri.includes('%23'));
  assert.ok(result.uri.includes('%0A'));
  assert.equal(request({ label: '   ', message: '  ' }).uri, `connectcoin:${address}`);
});

test('URI metacharacters cannot become extra payment, fee or network instructions', () => {
  const label = 'A&amount=100000000#fragment';
  const message = 'x?network=testnet4&r=https://evil.invalid/"<script>alert(1)</script>';
  const result = request({ amount: '1', label, message });
  const decoded = parsePaymentUri(result.uri);
  assert.equal(decoded.amount, '1');
  assert.equal(decoded.label, label);
  assert.equal(decoded.message, message);
  assert.deepEqual(decoded.ignoredParameters, []);
  assert.equal(result.uri.includes('<script>'), false);
  assert.equal(result.uri.includes('#'), false);
  assert.equal((result.uri.match(/&/g) ?? []).length, 2);
});

test('text limits count Unicode code points rather than UTF-16 code units', () => {
  assert.deepEqual(RECEIVE_REQUEST_LIMITS, { label: 100, message: 200, amountIntegerDigits: 9, amountFractionDigits: 10 });
  assert.ok(Object.isFrozen(RECEIVE_REQUEST_LIMITS));
  assert.equal(request({ label: 'a'.repeat(100), message: 'b'.repeat(200) }).label.length, 100);
  assert.throws(() => request({ label: 'a'.repeat(101) }), /100 characters/);
  assert.throws(() => request({ message: 'b'.repeat(201) }), /200 characters/);
  const unicodeLabel = '😀'.repeat(50) + 'a'.repeat(50);
  assert.equal(unicodeLabel.length, 150);
  assert.equal(request({ label: unicodeLabel }).label, unicodeLabel);
  assert.throws(() => request({ label: unicodeLabel + 'a' }), /100 characters/);
  assert.equal(request({ message: 'é'.repeat(150) }).message, 'é'.repeat(150));
  assert.throws(() => request({ message: 'e\u0301'.repeat(101) }), /200 characters/);
});

test('controls, bidi overrides, unpaired surrogates and invalid text types are rejected before trimming', () => {
  for (const bad of ['\u0000', '\t', '\u007f', '\u0085', '\u061c', '\u200e', '\u200f', '\u202e', '\u2066', '\ud800', '\udfff']) {
    for (const field of ['label', 'message']) {
      assert.throws(() => request({ [field]: `${bad}Example` }), /unsupported character/);
      assert.throws(() => request({ [field]: `Example${bad}` }), /unsupported character/);
    }
  }
  for (const label of ['\nExample', 'Example\r', 'First\r\nSecond', 'First\u2028Second', 'First\u2029Second']) {
    assert.throws(() => request({ label }), /unsupported character/);
  }
  for (const value of [null, 123, false, [], {}, Symbol('text')]) {
    assert.throws(() => request({ label: value }), /Label must be text/);
    assert.throws(() => request({ message: value }), /Message must be text/);
  }
  assert.throws(() => request({ message: ' '.repeat(1025) }), /too long/);
});

test('the complete percent-encoded URI is bounded to 1024 characters without truncating text', () => {
  const nearLimit = request({ label: 'é'.repeat(90), message: 'a'.repeat(200) });
  assert.ok(nearLimit.uri.length <= 1024);
  assert.equal(nearLimit.label, 'é'.repeat(90));
  assert.throws(() => request({ label: '😀'.repeat(100) }), /too long for a QR code/);
  assert.throws(() => request({ message: 'é'.repeat(200) }), /too long for a QR code/);
});

test('unsupported fields and accessor-bearing inputs are not interpreted as instructions', () => {
  for (const value of [null, 1, 'text', []]) assert.throws(() => createReceiveRequest(value), /valid payment request details/);
  assert.throws(() => request({ fee: '1' }), /unsupported field/);
  assert.throws(() => request({ network: 'testnet4' }), /unsupported field/);
  for (const enumerable of [true, false]) {
    const options = { address };
    Object.defineProperty(options, 'label', { enumerable, get() { throw new Error('getter should not run'); } });
    assert.throws(() => createReceiveRequest(options), error => error.message !== 'getter should not run');
  }
  assert.throws(() => createReceiveRequest(Object.assign(Object.create({ amount: '5' }), { address })), /valid payment request details/);
});

test('building a request leaves its public input object unchanged', () => {
  const input = { address, amount: '0001,', label: ' Shop ', message: 'Hello\r\nWorld' };
  const before = structuredClone(input);
  const result = createReceiveRequest(input);
  assert.deepEqual(input, before);
  assert.equal(result.amount, '1');
  assert.equal(result.label, 'Shop');
  assert.equal(result.message, 'Hello\nWorld');
});
