import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

export const GENESIS = Object.freeze({
  testnet4: '710dc5910cbef40216bd82ccfb66af2273b2b1d336b034c5794966904cb603bf',
  regtest: '53c5145452f6957a2674ab904726afc2d7643c4a4fb9c2beab193ea983e500f0',
});
export const DEFAULT_CONFIG = Object.freeze({
  version: 1, network: 'testnet4', rpc: Object.freeze({ host: 'connectcoin4.com', port: 48190 }),
  claims: Object.freeze({ enabled: false, maxConnectionsPerSecond: 100, maxConcurrent: 100, lookbackBlocks: 600 }),
  autoLockMinutes: 15, feeRate: 1500, theme: 'system', developerMode: false,
});
export function validateTheme(theme) {
  if (!['system', 'light', 'dark'].includes(theme)) throw new Error('Choose System, Light or Dark appearance.');
  return theme;
}
export function validateDeveloperMode(developerMode) {
  if (typeof developerMode !== 'boolean') throw new Error('Choose whether Developer Mode should be enabled.');
  return developerMode;
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value)); }
function dataObject(value) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw new Error('Configuration must contain plain data objects.');
  return value;
}
export function validateRpcEndpoint(input) {
  dataObject(input);
  const { host, port } = input;
  if (typeof host !== 'string' || host.length > 253 || host.includes('%') ||
      (!isIP(host) && (/^(?:[0-9]+\.){3}[0-9]+$/.test(host) || !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(host)))) {
    throw new Error('Enter an RPC hostname or IP address, without a URL or path.');
  }
  return { host: host.toLowerCase(), port: integer(port, 1, 65535, 'RPC port') };
}
export function validateConfig(input, { allowRegtest = false } = {}) {
  dataObject(input);
  if (Object.hasOwn(input, 'rpc')) dataObject(input.rpc);
  if (Object.hasOwn(input, 'claims')) dataObject(input.claims);
  const merged = { ...DEFAULT_CONFIG, ...input, rpc: { ...DEFAULT_CONFIG.rpc, ...input.rpc }, claims: { ...DEFAULT_CONFIG.claims, ...input.claims } };
  if (merged.version !== 1) throw new Error('Unsupported configuration version.');
  if (merged.network !== 'testnet4' && !(allowRegtest && merged.network === 'regtest')) throw new Error('This release supports ConnectCoin testnet4 only.');
  return {
    version: 1, network: merged.network, theme: validateTheme(merged.theme),
    developerMode: validateDeveloperMode(merged.developerMode),
    rpc: validateRpcEndpoint(merged.rpc),
    claims: {
      enabled: boolean(merged.claims.enabled, 'Automatic Claims'),
      maxConnectionsPerSecond: integer(merged.claims.maxConnectionsPerSecond, 1, 256, 'Connection starts per second'),
      maxConcurrent: integer(merged.claims.maxConcurrent, 1, 256, 'Simultaneous connections'),
      lookbackBlocks: integer(merged.claims.lookbackBlocks, 1, 600, 'Recent blocks'),
    },
    autoLockMinutes: integer(merged.autoLockMinutes, 1, 60, 'Auto-lock minutes'),
    feeRate: integer(merged.feeRate, 1201, 100000, 'Fee rate'),
  };
}
function boolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`Choose whether ${name} should be enabled.`);
  return value;
}
export async function writeConfig(directory, config, options) {
  const validated = validateConfig(config, options);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'config.json');
  const temporary = join(directory, `.config-${randomBytes(12).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(validated, null, 2) + '\n');
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, file);
  } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  return validated;
}
export async function readConfig(directory, options) {
  let handle;
  try {
    handle = await open(join(directory, 'config.json'), 'r');
    if (!(await handle.stat()).isFile()) throw new Error('Configuration must be a regular file.');
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw new Error('Configuration file is too large.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    return validateConfig(JSON.parse(text), options);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return writeConfig(directory, DEFAULT_CONFIG, options);
  } finally { await handle?.close(); }
}

export function validateTip(tip, network = 'testnet4') {
  if (!Object.hasOwn(GENESIS, network) || !plain(tip) || tip.chain !== network || tip.genesis_hash !== GENESIS[network] ||
      !Number.isSafeInteger(tip.height) || tip.height < 0 || !/^[0-9a-f]{64}$/.test(tip.hash) ||
      !Number.isSafeInteger(tip.mediantime) || tip.mediantime < 0 || (tip.height === 0 && tip.hash !== GENESIS[network])) {
    throw new Error('The RPC server returned an unexpected network or invalid chain tip.');
  }
  return tip;
}
