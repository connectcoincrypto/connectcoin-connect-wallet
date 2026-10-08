import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32, bech32m } from '@scure/base';
import { parsePaymentIntake } from '../src/payment-intake.mjs';

// Public points only. Intake tests never access a wallet, camera or network.
const publicKey = secp256k1.Point.BASE.toBytes(true).slice(1);
const words = [1, ...bech32m.toWords(publicKey)];
const address = bech32m.encode('cc', words);
const uri = `connectcoin:${address}`;
const emptyDraft = { address, amount: '', label: '', message: '' };

test('QR accepts bare mainnet addresses and uppercase without retaining stale draft fields', () => {
  for (const text of [address, address.toUpperCase(), `  ${address}  `, uri, `CONNECTCOIN:${address.toUpperCase()}`]) {
    assert.deepEqual(parsePaymentIntake(text), emptyDraft);
    assert.deepEqual(parsePaymentIntake(text, { source: 'qr' }), emptyDraft);
  }
  const previous = parsePaymentIntake(`${uri}?amount=2&label=Old&message=Old`);
  assert.deepEqual(previous, { address, amount: '2', label: 'Old', message: 'Old' });
  assert.deepEqual(parsePaymentIntake(address), emptyDraft);
  assert.deepEqual(parsePaymentIntake(`${uri}?amount=`), emptyDraft);
});

test('external intake requires a connectcoin URI and accepts the shared OS trailing-slash compatibility', () => {
  for (const text of [uri, `CONNECTCOIN:${address.toUpperCase()}`, `${uri}/`]) {
    assert.deepEqual(parsePaymentIntake(text, { source: 'external' }), emptyDraft);
  }
  assert.throws(() => parsePaymentIntake(address, { source: 'external' }), /connectcoin:/);
  for (const source of ['clipboard', 'https', '', null, false]) {
    assert.throws(() => parsePaymentIntake(uri, { source }), /source/);
  }
});

test('payment amounts remain exact, normalize trailing zeros and support known required aliases', () => {
  for (const [input, expected] of [['1.2300000000', '1.23'], ['0.0000000001', '0.0000000001'],
    ['900719.9254740993', '900719.9254740993'], ['100000000.0000000000', '100000000']]) {
    assert.deepEqual(parsePaymentIntake(`${uri}?amount=${input}`, { source: 'external' }), { ...emptyDraft, amount: expected });
  }
  assert.deepEqual(parsePaymentIntake(`${uri}?req-amount=2.000&req-label=Alice&req-message=Lunch`),
    { address, amount: '2', label: 'Alice', message: 'Lunch' });
  for (const amount of ['0', '-1', '01', '1e3', '1.00000000001', '100000000.0000000001', '%201', '1%20', '1,2', 'NaN']) {
    assert.throws(() => parsePaymentIntake(`${uri}?amount=${amount}`));
  }
});

test('metadata is decoded as bounded plain text with literal plus and normalized message newlines', () => {
  assert.deepEqual(parsePaymentIntake(`${uri}?label=Alice+Bob&message=Ol%C3%A1%20%26%20hello%0D%0Aworld`),
    { address, amount: '', label: 'Alice+Bob', message: 'Olá & hello\nworld' });
  const html = '<img src=x onerror=alert(1)>';
  assert.deepEqual(parsePaymentIntake(`${uri}?label=${encodeURIComponent(html)}&message=%3Cscript%3Ehello%3C%2Fscript%3E`),
    { address, amount: '', label: html, message: '<script>hello</script>' });
  // The renderer must use textContent for these fields, never markup.
  for (const suffix of [`label=${'a'.repeat(101)}`, `message=${'a'.repeat(201)}`, 'label=%00',
    'label=%0A', 'message=%E2%80%AE', 'label=%FF', 'message=%', 'message=%ED%A0%80']) {
    assert.throws(() => parsePaymentIntake(`${uri}?${suffix}`));
  }
});

test('checksum, network, witness encoding and curve membership are independently checked', () => {
  const invalidAddresses = [
    address.slice(0, -1) + (address.endsWith('q') ? 'p' : 'q'),
    bech32m.encode('tcc', words), bech32m.encode('ccrt', words), bech32.encode('cc', words),
    bech32m.encode('cc', [0, ...words.slice(1)]),
    bech32m.encode('cc', [1, ...bech32m.toWords(new Uint8Array(32).fill(255))]),
    bech32m.encode('cc', [1, ...bech32m.toWords(new Uint8Array(31))]),
    `CC${address.slice(2)}`,
  ];
  for (const candidate of invalidAddresses) {
    assert.throws(() => parsePaymentIntake(candidate));
    assert.throws(() => parsePaymentIntake(`connectcoin:${candidate}`, { source: 'external' }));
  }
});

test('malformed paths, authorities and percent-encoded addresses never become a payment', () => {
  for (const text of [`connectcoin://${address}`, `connectcoin://host/${address}`, `${uri}/extra`, `${uri}//`,
    `connectcoin:/${address}`, `connectcoin:${address.replace('cc', '%63%63')}`, `${uri}#fragment`, `${uri}?`,
    `${uri}?label`, `${uri}?=value`, `${uri}?label=x&&message=y`, `${uri}?label=x&`, `${uri}?label=x y`]) {
    assert.throws(() => parsePaymentIntake(text));
    assert.throws(() => parsePaymentIntake(text, { source: 'external' }));
  }
});

test('malicious schemes, wrapped HTML and malformed URIs never fall back to address-only parsing', () => {
  const marker = 'PRIVATE_PAYLOAD_MARKER';
  for (const text of [`https://example.com/${address}`, `javascript:alert('${marker}')`, `data:text/html,${marker}`,
    `file:///${marker}`, `intent://${address}#Intent;scheme=connectcoin;end`, `<a href="${uri}">${marker}</a>`,
    `${uri}?amount=2&req-${marker.toLowerCase()}=true`]) {
    for (const source of ['qr', 'external']) {
      assert.throws(() => parsePaymentIntake(text, { source }), error => !error.message.includes(marker));
    }
  }
});

test('duplicate parameters and unsupported required fields are rejected', () => {
  for (const query of ['amount=1&amount=2', 'amount=1&req-amount=2', 'req-amount=1&amount=2',
    'label=A&%6cabel=B', 'message=A&req-message=B', 'note=A&note=B', 'req-feature=true']) {
    assert.throws(() => parsePaymentIntake(`${uri}?${query}`));
  }
});

test('only harmless optional metadata is ignored, never remote payment or fee instructions', () => {
  assert.deepEqual(parsePaymentIntake(`${uri}?note=%3Cscript%3Eevil%3C%2Fscript%3E&merchant=https%3A%2F%2Fexample.com%2Frequest&amount=1`),
    { ...emptyDraft, amount: '1' });
  for (const key of ['r', 'pj', 'pjos', 'payjoin', 'payment-protocol', 'network', 'chain', 'fee', 'feerate',
    'fee-rate', 'address', 'domain', 'lightning', 'lno', 'lna']) {
    assert.throws(() => parsePaymentIntake(`${uri}?${key}=https%3A%2F%2Fexample.com`));
  }
});

test('input is bounded before trimming and rejects control characters without coercion', () => {
  const prefix = `${uri}?note=`;
  assert.deepEqual(parsePaymentIntake(prefix + 'a'.repeat(1024 - prefix.length)), emptyDraft);
  for (const text of [prefix + 'a'.repeat(1025 - prefix.length), `${' '.repeat(1024)}${uri}`, null, undefined, 1,
    { toString() { throw new Error('coercion ran'); } }, `${uri}\n`, `${uri}\r`, `${uri}\0`, `${uri}\ud800`]) {
    assert.throws(() => parsePaymentIntake(text), error => error.message !== 'coercion ran');
  }
});
