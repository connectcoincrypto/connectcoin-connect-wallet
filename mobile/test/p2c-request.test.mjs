import test from 'node:test';
import assert from 'node:assert/strict';
import { createP2CRequest, MAX_EXPECTED_CONNECTIONS } from '../src/p2c-request.mjs';

const draft = { domain: 'example.com', amount: '1', expectedConnections: '1' };

test('P2C form produces only the three public native review fields', () => {
  assert.deepEqual(createP2CRequest({ ...draft, domain: ' EXAMPLE.COM ', amount: '0001,25', expectedConnections: '1000.', mask: 1, target: 'fake' }),
    { domain: 'example.com', amount: '1.25', expectedConnections: '1000' });
  assert.equal(createP2CRequest({ ...draft, domain: 'xn--bcher-kva.example.com' }).domain, 'xn--bcher-kva.example.com');
  assert.equal(createP2CRequest({ ...draft, amount: '2.' }).amount, '2');
  assert.equal(createP2CRequest({ ...draft, amount: '.5' }).amount, '0.5');
});

test('P2C expected count uses exact integers including the full 256-bit boundary', () => {
  for (const expectedConnections of ['1', '9007199254740993', MAX_EXPECTED_CONNECTIONS]) {
    assert.equal(createP2CRequest({ ...draft, expectedConnections }).expectedConnections, expectedConnections);
  }
  for (const expectedConnections of ['', '0', '-1', '1e3', '1.1', ' 1', '1\n', '01', '9'.repeat(79), String((1n << 256n) + 1n), 1, null]) {
    assert.throws(() => createP2CRequest({ ...draft, expectedConnections }), /Expected connections/);
  }
});

test('P2C domain rejects URLs, local destinations and implicit Unicode remapping', () => {
  for (const domain of ['', 'localhost', '127.0.0.1', '[::1]', 'example.123', 'https://example.com', 'example.com/path',
    'user@example.com', 'example.com:443', 'example.com.', 'a..com', '-a.com', 'a-.com', 'a'.repeat(64) + '.com',
    'x.'.repeat(126) + 'com', 'a.local', 'a.localdomain', 'a.internal', 'a.test', 'a.invalid', 'a.onion', 'a.localhost',
    'home.arpa', 'router.home.arpa', 'a b.com', 'a\nb.com', 'bücher.com', 'K.com', 'example。com', null, 123]) {
    assert.throws(() => createP2CRequest({ ...draft, domain }), /public domain/);
  }
});

test('P2C rewards stay exact and within the money range without silently truncating', () => {
  for (const amount of ['0.0000000001', '100000000', '100000000.0000000000']) {
    assert.equal(createP2CRequest({ ...draft, amount }).amount, amount);
  }
  for (const amount of ['0', '', '-1', '1e3', '1.00000000001', '100000000.0000000001', '100000001', '1\n', null, 1]) {
    assert.throws(() => createP2CRequest({ ...draft, amount }));
  }
});
