import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, GENESIS, readConfig, validateConfig, validateDeveloperMode, validateRpcEndpoint, validateTip, writeConfig } from '../src/core/config.mjs';

test('config defaults use plaintext ConnectCoin4 TCP and strip unrelated/secret fields', () => {
  assert.deepEqual(validateConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(validateConfig({ rpc: { host: 'CONNECTCOIN4.COM', password: 'secret' }, mnemonic: 'never save this' }), DEFAULT_CONFIG);
  assert.equal(validateConfig(JSON.parse('{"__proto__":{"network":"main"}}')).network, 'testnet4');
  assert.equal(Object.prototype.network, undefined);
  assert.throws(() => validateConfig(Object.create({ rpc: { host: 'evil' } })), /plain/);
  assert.throws(() => validateConfig({ get rpc() { throw new Error('executed'); } }), /plain/);
  assert.throws(() => validateConfig({ rpc: false }), /plain/);
  assert.throws(() => validateConfig({ rpc: null }), /plain/);
  assert.throws(() => validateConfig({ claims: [] }), /plain/);
  assert.throws(() => { DEFAULT_CONFIG.rpc.host = 'evil'; });
});
test('endpoint validation supports IPv4/IPv6 and rejects URLs, Unicode control text and bad ports', () => {
  for (const host of ['127.0.0.1', '::1', '2001:db8::1', 'node.example', 'localhost']) assert.equal(validateRpcEndpoint({ host, port: 48190 }).host, host);
  for (const host of ['https://node.example', 'node.example/path', 'node.example:48190', '[::1]', '999.2.3.4', 'example..com', 'example.com.', '-example.com', 'x'.repeat(64) + '.com', 'abc\n.com', 'bücher.example', 'abc\u202e.com', 'fe80::1%eth0', '']) assert.throws(() => validateRpcEndpoint({ host, port: 48190 }));
  for (const port of [0, 65536, -1, 1.5, '48190', Infinity, NaN]) assert.throws(() => validateRpcEndpoint({ host: 'localhost', port }));
});

test('claims default off with 100 starts and concurrent connections without overwriting saved limits', async () => {
  const expected = { enabled: false, maxConnectionsPerSecond: 100, maxConcurrent: 100, lookbackBlocks: 600 };
  assert.deepEqual(DEFAULT_CONFIG.claims, expected);
  assert.deepEqual(validateConfig({}).claims, expected);
  assert.deepEqual(validateConfig({ claims: { maxConcurrent: 20 } }).claims, { ...expected, maxConcurrent: 20 });
  const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(example.claims, expected);
  const directory = await mkdtemp(path.join(tmpdir(), 'connectwallet-claims-defaults-test-'));
  try {
    assert.deepEqual((await readConfig(directory)).claims, expected);
    const custom = { enabled: true, maxConnectionsPerSecond: 5, maxConcurrent: 12, lookbackBlocks: 300 };
    await writeConfig(directory, { claims: custom });
    assert.deepEqual((await readConfig(directory)).claims, custom);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('connectwallet-claims-defaults-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Automatic Claims preference accepts only booleans and migrates legacy limits without enabling execution', async () => {
  for (const enabled of [true, false]) assert.equal(validateConfig({ claims: { enabled } }).claims.enabled, enabled);
  for (const enabled of [undefined, null, '', 'true', 'false', 0, 1, {}, [], new Boolean(false)]) {
    assert.throws(() => validateConfig({ claims: { enabled } }), /Automatic Claims/);
  }
  let accessed = false;
  assert.throws(() => validateConfig({ claims: { get enabled() { accessed = true; return true; } } }), /plain/);
  assert.equal(accessed, false);
  const directory = await mkdtemp(path.join(tmpdir(), 'connectwallet-claims-migration-test-'));
  try {
    const limits = { maxConnectionsPerSecond: 3, maxConcurrent: 7, lookbackBlocks: 42 };
    const legacy = JSON.stringify({ version: 1, claims: limits, theme: 'dark', developerMode: true });
    const file = path.join(directory, 'config.json');
    await writeFile(file, legacy);
    const loaded = await readConfig(directory);
    assert.deepEqual(loaded.claims, { enabled: false, ...limits });
    assert.equal(await readFile(file, 'utf8'), legacy, 'reading an older profile must not rewrite it');
    for (const enabled of [true, false]) {
      const expected = { ...loaded, claims: { ...loaded.claims, enabled } };
      await writeConfig(directory, expected);
      assert.deepEqual(await readConfig(directory), expected);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), expected);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('connectwallet-claims-migration-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
test('network, claims, fee and lock bounds are explicit and testnet only by default', () => {
  assert.throws(() => validateConfig({ network: 'main' }), /testnet4/);
  assert.throws(() => validateConfig({ network: 'regtest' }), /testnet4/);
  assert.equal(validateConfig({ network: 'regtest' }, { allowRegtest: true }).network, 'regtest');
  for (const input of [{ version: 2 }, { autoLockMinutes: 0 }, { autoLockMinutes: 61 }, { feeRate: 1200 }, { feeRate: 100001 }, { claims: { maxConcurrent: 0 } }, { claims: { maxConnectionsPerSecond: 257 } }, { claims: { lookbackBlocks: 601 } }]) assert.throws(() => validateConfig(input));
});

test('appearance defaults to the system, accepts only explicit supported preferences and persists', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'connectwallet-theme-config-test-'));
  try {
    assert.equal(validateConfig({ version: 1 }).theme, 'system');
    for (const theme of ['system', 'light', 'dark']) {
      await writeConfig(directory, { theme });
      assert.equal((await readConfig(directory)).theme, theme);
    }
    for (const theme of [null, undefined, '', 'Dark', 'auto', true, 1, {}, []]) {
      assert.throws(() => validateConfig({ theme }), /appearance/);
    }
    // Existing installations did not have a theme field: no migration or wallet
    // change is necessary to get the OS default.
    await writeFile(path.join(directory, 'config.json'), '{"version":1,"network":"testnet4"}');
    assert.equal((await readConfig(directory)).theme, 'system');
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('connectwallet-theme-config-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
test('Developer Mode defaults off and accepts only boolean values without invoking getters or coercion', async () => {
  assert.equal(DEFAULT_CONFIG.developerMode, false);
  assert.equal(validateConfig({}).developerMode, false);
  const example = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.equal(example.developerMode, false);
  assert.deepEqual(validateConfig(example), DEFAULT_CONFIG);
  for (const developerMode of [true, false]) {
    assert.equal(validateDeveloperMode(developerMode), developerMode);
    assert.equal(validateConfig({ developerMode }).developerMode, developerMode);
  }
  const invalid = [undefined, null, '', 'true', 'false', 0, 1, NaN, {}, [], new Boolean(false), 1n, Symbol('developerMode'), () => true];
  for (const developerMode of invalid) {
    const error = { message: 'Choose whether Developer Mode should be enabled.' };
    assert.throws(() => validateDeveloperMode(developerMode), error);
    assert.throws(() => validateConfig({ developerMode }), error);
  }
  let invoked = false;
  assert.throws(() => validateConfig({ get developerMode() { invoked = true; return true; } }), /plain data objects/);
  assert.throws(() => validateDeveloperMode({ valueOf() { invoked = true; return true; } }), /Developer Mode/);
  assert.equal(invoked, false);
});
test('legacy configurations default Developer Mode off and persist either preference without changing other settings', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'connectwallet-developer-mode-config-test-'));
  try {
    const legacy = {
      version: 1, network: 'testnet4', theme: 'dark',
      rpc: { host: '127.0.0.1', port: 18000 },
      claims: { maxConnectionsPerSecond: 5, maxConcurrent: 12, lookbackBlocks: 300 },
      autoLockMinutes: 30, feeRate: 2000,
    };
    const file = path.join(directory, 'config.json');
    const saved = JSON.stringify(legacy);
    await writeFile(file, saved);
    const loaded = await readConfig(directory);
    assert.deepEqual(loaded, { ...legacy, claims: { enabled: false, ...legacy.claims }, developerMode: false });
    assert.equal(await readFile(file, 'utf8'), saved);
    for (const developerMode of [true, false]) {
      const expected = { ...loaded, developerMode };
      assert.deepEqual(await writeConfig(directory, expected), expected);
      assert.deepEqual(await readConfig(directory), expected);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), expected);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('connectwallet-developer-mode-config-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
test('chain tip validates network and pinned genesis, including height-zero consistency', () => {
  const tip = { chain: 'testnet4', genesis_hash: GENESIS.testnet4, height: 12, hash: 'a'.repeat(64), mediantime: 1789136800 };
  assert.deepEqual(validateTip(tip), tip);
  for (const changed of [{ chain: 'main' }, { genesis_hash: 'b'.repeat(64) }, { height: -1 }, { height: '12' }, { hash: 'q'.repeat(64) }, { mediantime: Infinity }, { height: 0 }]) assert.throws(() => validateTip({ ...tip, ...changed }));
  assert.throws(() => validateTip(tip, '__proto__'));
  assert.throws(() => validateTip(Object.create(tip)));
  assert.deepEqual(validateTip({ ...tip, height: 0, hash: GENESIS.testnet4 }).hash, GENESIS.testnet4);
});
test('config file creation is bounded, atomic, sanitized and rejects malformed UTF8', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'connectwallet-config-test-'));
  try {
    assert.deepEqual(await readConfig(directory), DEFAULT_CONFIG);
    await writeConfig(directory, { rpc: { host: '127.0.0.1', port: 18000 }, mnemonic: 'must not persist' });
    assert.equal((await readConfig(directory)).rpc.port, 18000);
    assert.equal((await readFile(path.join(directory, 'config.json'), 'utf8')).includes('must not persist'), false);
    assert.deepEqual(await readdir(directory), ['config.json']);
    await writeFile(path.join(directory, 'config.json'), 'x'.repeat(16385));
    await assert.rejects(readConfig(directory), /too large/);
    await writeFile(path.join(directory, 'config.json'), Buffer.from([0xff]));
    await assert.rejects(readConfig(directory));
  } finally {
    assert.ok(path.basename(directory).startsWith('connectwallet-config-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
