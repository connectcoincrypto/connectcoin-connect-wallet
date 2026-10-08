import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32, bech32m } from '@scure/base';
import { DEFAULT_CONFIG } from '../../src/core/config.mjs';
import { MAINNET_GENESIS, RPC_ENDPOINT, parseMainnetAddress, formatConn, validateTip,
  validateBalance, validateHistory, mergeHistory } from '../src/model.mjs';

// Public curve points only: no private keys, seed phrases, vault or network.
const publicKey = secp256k1.Point.BASE.toBytes(true).slice(1);
const address = bech32m.encode('cc', [1, ...bech32m.toWords(publicKey)]);
const otherAddress = bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.double().toBytes(true).slice(1))]);
const hash = n => n.toString(16).padStart(64, '0');
const tip = () => ({ chain: 'main', genesis_hash: MAINNET_GENESIS, height: 200, hash: hash(100), mediantime: 1700000000 });
const balance = () => ({ address, tip: tip(), unit: 'connects', confirmed: '100000000000', immature: '10000000000',
  available_confirmed: '70000000000', pending_received: '5000000000', pending_spent: '20000000000',
  pending_delta: '-15000000000', total: '85000000000' });
const confirmed = (id = 1, height = 199) => ({ txid: hash(id), status: 'confirmed', block_height: height,
  block_hash: height === 200 ? hash(100) : height === 0 ? MAINNET_GENESIS : hash(height), confirmations: 201 - height,
  received: '10000000000', spent: '20000000000', balance_delta: '-10000000000' });
const pending = (id = 2) => ({ ...confirmed(id), status: 'pending', block_height: null, block_hash: null, confirmations: 0 });
const history = (items = [confirmed(), pending()]) => ({ address, tip: tip(), unit: 'connects', live: true, items, next_cursor: null });

test('mainnet constants are pinned and endpoint immutable', () => {
  assert.equal(MAINNET_GENESIS, '30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e');
  assert.deepEqual(RPC_ENDPOINT, { host: 'connectcoin4.com', port: 48190, tls: false });
  assert.deepEqual({ host: RPC_ENDPOINT.host, port: RPC_ENDPOINT.port }, DEFAULT_CONFIG.rpc);
  assert.ok(Object.isFrozen(RPC_ENDPOINT));
});

test('mainnet addresses accept canonical, uppercase and validated payment URIs', () => {
  for (const input of [address, `  ${address}  `, address.toUpperCase(), `connectcoin:${address}?amount=1.2345678901&label=Public%20test&message=Hello`, `CONNECTCOIN:${address.toUpperCase()}`]) {
    assert.equal(parseMainnetAddress(input), address);
  }
});

test('mainnet addresses reject invalid checksum, curve, version, size, encoding and network', () => {
  const words = [1, ...bech32m.toWords(publicKey)];
  const bad = [address.slice(0, -1) + (address.endsWith('q') ? 'p' : 'q'),
    bech32m.encode('tcc', words), bech32m.encode('ccrt', words), bech32.encode('cc', words),
    bech32m.encode('cc', [0, ...words.slice(1)]), bech32m.encode('cc', [1, ...bech32m.toWords(new Uint8Array(32).fill(255))]),
    bech32m.encode('cc', [1, ...bech32m.toWords(new Uint8Array(31))]),
    bech32m.encode('cc', [1, ...bech32m.toWords(new Uint8Array(33))]),
    'CC' + address.slice(2), '', {}, null, 123, `${address}\n<script>`, address + '\u202e', 'x'.repeat(1025)];
  for (const input of bad) assert.throws(() => parseMainnetAddress(input), /valid ConnectCoin mainnet address/);
});

test('mainnet URI parsing rejects unsafe or malformed metadata without echoing it', () => {
  for (const suffix of ['?amount=-1', '?amount=1.00000000001', '?req-unsafe=secret', '?address=other', '?label=%FF', '?amount=1&amount=2', '?message=%3Cscript%3E&network=testnet4']) {
    assert.throws(() => parseMainnetAddress(`connectcoin:${address}${suffix}`), error => !error.message.includes('secret') && !error.message.includes('<script>'));
  }
});

test('CONN formatting is exact through 10 decimals and the complete money range', () => {
  for (const [integer, decimal] of [['0', '0'], ['1', '0.0000000001'], ['-1', '-0.0000000001'],
    ['10000000000', '1'], ['12345678901', '1.2345678901'], ['9007199254740993', '900719.9254740993'],
    ['-15000000000', '-1.5'], ['1000000000000000000', '100000000'], ['-1000000000000000000', '-100000000']]) {
    assert.equal(formatConn(integer), decimal);
  }
  for (const value of ['-0', '00', '+1', ' 1', '1.0', '1e10', 'NaN', '1000000000000000001', '-1000000000000000001', '1'.repeat(1000), 1, 1n, null]) {
    assert.throws(() => formatConn(value));
  }
});

test('tip validates the network, genesis anchor and strict bounded schema', () => {
  assert.deepEqual(validateTip(tip()), tip());
  assert.deepEqual(validateTip({ ...tip(), height: 0, hash: MAINNET_GENESIS }), { ...tip(), height: 0, hash: MAINNET_GENESIS });
  for (const patch of [{ chain: 'testnet4' }, { genesis_hash: hash(1) }, { height: -1 }, { height: -0 },
    { height: 1.2 }, { height: Number.MAX_SAFE_INTEGER + 1 }, { hash: 'A'.repeat(64) }, { hash: {} },
    { mediantime: '1' }, { mediantime: Infinity }, { height: 0 }, { unexpected: '<script>' }]) {
    assert.throws(() => validateTip({ ...tip(), ...patch }));
  }
  assert.throws(() => validateTip({ ...tip(), hash: undefined }));
  assert.throws(() => validateTip(Object.assign(Object.create({ evil: true }), tip())));
  const accessor = tip();
  Object.defineProperty(accessor, 'hash', { get() { throw new Error('getter ran'); }, enumerable: true });
  assert.throws(() => validateTip(accessor), error => error.message !== 'getter ran');
});

test('balance validates every amount and exact BigInt identities with no extra fields', () => {
  const input = balance(), output = validateBalance(input, address);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.tip, input.tip);
  const patches = [{ address: otherAddress }, { address: address.toUpperCase() }, { unit: 'CONN' }, { pending_delta: '15000000000' },
    { total: '85000000001' }, { confirmed: '1000000000000000001' }, { immature: '-1' }, { available_confirmed: '-1' },
    { pending_received: 1 }, { pending_spent: '01' }, { unexpected: true }];
  for (const patch of patches) assert.throws(() => validateBalance({ ...balance(), ...patch }, address));
  for (const field of Object.keys(balance())) {
    const missing = balance(); delete missing[field];
    assert.throws(() => validateBalance(missing, address));
  }
  const maximum = { ...balance(), confirmed: '1000000000000000000', immature: '0', available_confirmed: '1000000000000000000',
    pending_received: '0', pending_spent: '0', pending_delta: '0', total: '1000000000000000000' };
  assert.deepEqual(validateBalance(maximum, address), maximum);
});

test('history returns clean, detached rows with consistent confirmation and amount metadata', () => {
  const input = history(), output = validateHistory(input, address);
  assert.deepEqual(output, input);
  assert.notEqual(output.items, input.items);
  assert.notEqual(output.items[0], input.items[0]);
  assert.deepEqual(validateHistory(history([]), address).items, []);
  assert.equal(validateHistory({ ...history(), next_cursor: 'eyJjdXJzb3IiOjF9.signature' }, address).next_cursor, 'eyJjdXJzb3IiOjF9.signature');
  for (const patch of [{ address: otherAddress }, { unit: 'CONN' }, { live: false }, { live: undefined },
    { items: null }, { next_cursor: '' }, { next_cursor: 'raw cursor\n' }, { next_cursor: 'a'.repeat(1025) + '.b' },
    { next_cursor: 1 }, { next_cursor: undefined }, { unexpected: true }]) {
    assert.throws(() => validateHistory({ ...history(), ...patch }, address));
  }
  assert.throws(() => validateHistory({ ...history([]), next_cursor: 'a.b' }, address));
});

test('history rejects malformed rows, duplicate page records and inconsistent block locations', () => {
  const patches = [{ txid: 'x'.repeat(64) }, { status: 'unknown' }, { block_height: 201 }, { block_height: -1 },
    { block_height: null }, { block_height: 0 }, { block_hash: 'UPPER' }, { confirmations: 1 }, { confirmations: 0 },
    { confirmations: Number.MAX_SAFE_INTEGER + 1 }, { received: '-1' }, { spent: '1.5' }, { balance_delta: '0' },
    { unexpected: true }];
  for (const patch of patches) assert.throws(() => validateHistory(history([{ ...confirmed(), ...patch }]), address));
  assert.throws(() => validateHistory(history([{ ...confirmed(1, 200), block_hash: hash(99) }]), address));
  for (const patch of [{ block_height: 200 }, { block_hash: hash(1) }, { confirmations: 1 }]) {
    assert.throws(() => validateHistory(history([{ ...pending(), ...patch }]), address));
  }
  assert.throws(() => validateHistory(history([confirmed(), confirmed()]), address));
  assert.throws(() => validateHistory(history(new Array(1)), address));
});

test('history enforces 500-row pages before copying and allows the exact limit', () => {
  assert.equal(validateHistory(history(Array.from({ length: 500 }, (_, i) => pending(i))), address).items.length, 500);
  assert.throws(() => validateHistory(history(Array.from({ length: 501 }, (_, i) => pending(i))), address));
});

test('merge deduplicates with newest incoming state, sorts pending first and never mutates input', () => {
  const old = [pending(5), confirmed(3, 190), confirmed(2, 195)];
  const next = [confirmed(5, 200), pending(7), pending(6), confirmed(1, 195), confirmed(5, 200)];
  const before = structuredClone([old, next]);
  const merged = mergeHistory(old, next);
  assert.deepEqual(merged.map(row => row.txid), [7, 6].sort((a, b) => a - b).concat([5, 1, 2, 3]).map(hash));
  assert.equal(merged.find(row => row.txid === hash(5)).status, 'confirmed');
  assert.deepEqual([old, next], before);
  assert.notEqual(merged.at(-1), old[1]);
  assert.equal(mergeHistory([confirmed(1)], [pending(1)])[0].status, 'pending');
});

test('merge keeps at most the 2000 newest rows and bounds supplied arrays', () => {
  const old = Array.from({ length: 2000 }, (_, i) => confirmed(i, 190));
  const next = [pending(3000), confirmed(3001, 200)];
  const merged = mergeHistory(old, next);
  assert.equal(merged.length, 2000);
  assert.deepEqual(merged.slice(0, 2).map(row => row.txid), [hash(3000), hash(3001)]);
  assert.equal(mergeHistory([], []).length, 0);
  assert.throws(() => mergeHistory(new Array(2001), []));
  assert.throws(() => mergeHistory([], new Array(2001)));
  assert.throws(() => mergeHistory(null, []));
  assert.throws(() => mergeHistory([], [{ ...pending(), received: 'NaN' }]));
});
