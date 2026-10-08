import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, parseSettings, resolvedTheme, rpcEndpoint } from '../src/settings.mjs';

test('Settings defaults are immutable and use the production endpoint', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { theme: 'dark', autoLockMinutes: 0, rpcHost: 'connectcoin4.com', rpcPort: 48190 });
  assert.equal(Object.isFrozen(DEFAULT_SETTINGS), true);
  assert.throws(() => { DEFAULT_SETTINGS.rpcPort = 1; }, TypeError);
  assert.deepEqual(parseSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  assert.notEqual(parseSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  assert.equal(rpcEndpoint(DEFAULT_SETTINGS), 'connectcoin4.com:48190');
});

test('Settings normalize public form fields and emit only the native save contract', () => {
  const input = { theme: 'system', autoLockMinutes: '0005', rpcHost: '  RPC.ConnectCoin4.COM  ', rpcPort: '048190', futureSetting: true };
  const original = { ...input };
  const settings = parseSettings(input);
  assert.deepEqual(settings, { theme: 'system', autoLockMinutes: 5, rpcHost: 'rpc.connectcoin4.com', rpcPort: 48190 });
  assert.deepEqual(input, original);
  assert.equal(rpcEndpoint(settings), 'rpc.connectcoin4.com:48190');
});

test('Settings require all four own data fields', () => {
  for (const value of [undefined, null, [], '', 1, true]) assert.throws(() => parseSettings(value), /object/);
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const partial = { ...DEFAULT_SETTINGS };
    delete partial[key];
    assert.throws(() => parseSettings(partial), new RegExp(key));
    const accessor = { ...DEFAULT_SETTINGS };
    Object.defineProperty(accessor, key, { get() { throw new Error('Accessor must not run.'); } });
    assert.throws(() => parseSettings(accessor), new RegExp(key));
  }
  assert.throws(() => parseSettings(Object.create(DEFAULT_SETTINGS)), /include/);
  assert.deepEqual(parseSettings(Object.assign(Object.create(null), DEFAULT_SETTINGS)), DEFAULT_SETTINGS);
});

test('Auto-lock accepts disabled and maximum delays without rounding or coercion', () => {
  for (const value of [0, 1, 1440, '0', '1', '1440']) {
    assert.equal(parseSettings({ ...DEFAULT_SETTINGS, autoLockMinutes: value }).autoLockMinutes, Number(value));
  }
  for (const value of [-1, 1441, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '', ' ', ' 5', '5 ', '5\n', '5.0', '5,0', '1e2', '+5', '-0', '0x10', '１４', false, true, null, undefined, [], {}, 1n]) {
    assert.throws(() => parseSettings({ ...DEFAULT_SETTINGS, autoLockMinutes: value }), /Auto-lock minutes/);
  }
});

test('RPC ports accept only integers in the TCP port range', () => {
  for (const value of [1, 48190, 65535, '1', '48190', '65535']) {
    assert.equal(parseSettings({ ...DEFAULT_SETTINGS, rpcPort: value }).rpcPort, Number(value));
  }
  for (const value of [0, -1, 65536, 48190.5, NaN, Infinity, '', ' ', ' 48190', '48190 ', '48190\n', '48190.0', '4e4', '+48190', '0xffff', '９', false, true, null, undefined, [], {}, 1n]) {
    assert.throws(() => parseSettings({ ...DEFAULT_SETTINGS, rpcPort: value }), /RPC port/);
  }
});

test('RPC hostnames follow the native public DNS label and length policy', () => {
  const maxLength = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
  assert.equal(maxLength.length, 253);
  for (const host of ['connectcoin4.com', 'rpc-2.example.com', '1rpc.example.com', 'a.b', 'xn--bcher-kva.example', maxLength]) {
    assert.equal(parseSettings({ ...DEFAULT_SETTINGS, rpcHost: host }).rpcHost, host);
  }
  for (const host of ['', '.', 'localhost', 'rpc', 'rpc.localhost', 'RPC.LOCAL', 'rpc.internal', '127.0.0.1', '8.8.8.8', '999.1.2.3', '123.456', '::1', '[2001:db8::1]', '2001:db8::1',
    'https://example.com', 'tcp://example.com', 'example.com:48190', 'user@example.com', 'example.com/path', 'example.com\\path', 'example.com?port=1', 'example.com#rpc',
    'rpc example.com', 'rpc\n.example.com', 'rpc\t.example.com', 'rpc\0.example.com', 'bücher.example', '\u212A.example', 'rpc_example.com', '-rpc.example.com', 'rpc-.example.com',
    '.example.com', 'example.com.', 'rpc..example.com', `${'a'.repeat(64)}.example.com`, `${maxLength}d`, null, 123, {}]) {
    assert.throws(() => parseSettings({ ...DEFAULT_SETTINGS, rpcHost: host }), /public RPC hostname/);
  }
});

test('Appearance preserves explicit choices and resolves system preference', () => {
  for (const theme of ['dark', 'light', 'system']) assert.equal(parseSettings({ ...DEFAULT_SETTINGS, theme }).theme, theme);
  assert.equal(resolvedTheme('system', true), 'dark');
  assert.equal(resolvedTheme('system', false), 'light');
  for (const prefersDark of [true, false]) {
    assert.equal(resolvedTheme('dark', prefersDark), 'dark');
    assert.equal(resolvedTheme('light', prefersDark), 'light');
  }
  for (const theme of ['', 'auto', 'Dark', ' dark', 'light ', null, undefined, 1]) {
    assert.throws(() => parseSettings({ ...DEFAULT_SETTINGS, theme }), /appearance/);
    assert.throws(() => resolvedTheme(theme, true), /appearance/);
  }
});
