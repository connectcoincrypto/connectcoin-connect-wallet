import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import { ConnectionPool } from '../src/core/claim-pool.mjs';
import { pinnedCryptographyVersion, validateHelperSecurity } from './helper-security.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const usage = 'Usage: node scripts/test-packaged.mjs --directory=<output root> --platform=win32|darwin|linux --arch=x64|arm64';

function validateTarget(platform, arch) {
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(usage);
  }
}

export function parsePackagedOptions(args) {
  const options = {};
  for (const arg of args) {
    const match = /^--(directory|platform|arch)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(options, match[1]) || !match[2].trim() || match[2].includes('\0')) throw new Error(usage);
    options[match[1]] = match[2];
  }
  if (!options.directory) throw new Error(usage);
  validateTarget(options.platform, options.arch);
  return { ...options, directory: resolve(options.directory) };
}

export function assertNativeTarget({ platform, arch }, host = process) {
  validateTarget(platform, arch);
  if (platform !== host.platform || arch !== host.arch) {
    throw new Error(`Packaged smoke tests require a native ${platform}/${arch} Node host; current host is ${host.platform}/${host.arch}.`);
  }
}

// Only inspect the selected builder output. Never search other output roots or
// fall back to the development helper, which could conceal a broken package.
export function packagedLayout({ directory, platform, arch }) {
  validateTarget(platform, arch);
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) throw new Error(usage);
  const suffix = arch === 'x64' ? '' : `-${arch}`;
  const folder = platform === 'darwin' ? `mac${suffix}` : `${platform === 'win32' ? 'win' : 'linux'}${suffix}-unpacked`;
  const app = resolve(directory, folder, ...(platform === 'darwin' ? ['ConnectWallet.app'] : []));
  const resources = resolve(app, ...(platform === 'darwin' ? ['Contents', 'Resources'] : ['resources']));
  return {
    app, resources,
    executable: resolve(app, ...(platform === 'darwin' ? ['Contents', 'MacOS', 'ConnectWallet'] : [platform === 'win32' ? 'ConnectWallet.exe' : 'connectwallet'])),
    archive: resolve(resources, 'app.asar'),
    helper: resolve(resources, 'claims-helper', platform === 'win32' ? 'connectwallet-claims.exe' : 'connectwallet-claims'),
    internal: resolve(resources, 'claims-helper', '_internal'),
  };
}

export function validateExecutableHeader(header, { platform, arch }) {
  validateTarget(platform, arch);
  let matches = false;
  if (header.length >= 64 && platform === 'win32' && header.toString('ascii', 0, 2) === 'MZ') {
    const offset = header.readUInt32LE(0x3c);
    matches = offset >= 64 && offset + 26 <= header.length && header.readUInt32LE(offset) === 0x4550 &&
      header.readUInt16LE(offset + 4) === (arch === 'x64' ? 0x8664 : 0xaa64) && header.readUInt16LE(offset + 24) === 0x20b;
  } else if (header.length >= 64 && platform === 'linux') {
    matches = header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      header[4] === 2 && header[5] === 1 && [2, 3].includes(header.readUInt16LE(16)) &&
      header.readUInt16LE(18) === (arch === 'x64' ? 62 : 183);
  } else if (header.length >= 32 && platform === 'darwin') {
    matches = header.readUInt32LE(0) === 0xfeedfacf &&
      header.readUInt32LE(4) === (arch === 'x64' ? 0x01000007 : 0x0100000c) && header.readUInt32LE(12) === 2;
  }
  if (!matches) throw new Error(`Expected a ${platform}/${arch} native executable (PE32+, ELF64 or Mach-O64 for that target).`);
}

function within(root, path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

export function bundledLicensePath(root, path) {
  if (typeof path !== 'string' || !path || /[\\:\0]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid bundled dependency license path.');
  }
  const destination = resolve(root, path);
  if (!within(resolve(root), destination)) throw new Error('Bundled dependency license escapes its directory.');
  return destination;
}

async function requireFile(root, path) {
  const actual = await realpath(path);
  if (!within(root, actual)) throw new Error(`Packaged resource escapes the selected application: ${path}`);
  const details = await stat(actual);
  if (!details.isFile() || details.size === 0) throw new Error(`Missing or empty packaged file: ${path}`);
}

async function verifyExecutable(root, path, target) {
  await requireFile(root, path);
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(65536);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    validateExecutableHeader(header.subarray(0, bytesRead), target);
  } catch (error) {
    throw new Error(`Invalid packaged executable ${path}: ${error.message}`);
  } finally { await file.close(); }
  if (target.platform !== 'win32') await access(path, constants.X_OK);
}

export async function testPackaged(options) {
  assertNativeTarget(options);
  const layout = packagedLayout(options);
  const outputRoot = await realpath(options.directory);
  const appRoot = await realpath(layout.app);
  if (!within(outputRoot, appRoot)) throw new Error('Packaged application escapes the selected output directory.');
  await requireFile(appRoot, layout.archive);
  await verifyExecutable(appRoot, layout.executable, options);
  await verifyExecutable(appRoot, layout.helper, options);

  const expectedPackage = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8'));
  const packagedPackage = JSON.parse(asar.extractFile(layout.archive, 'package.json').toString('utf8'));
  if (packagedPackage.name !== expectedPackage.name || packagedPackage.version !== expectedPackage.version || packagedPackage.main !== 'src/main.mjs') {
    throw new Error('Packaged app name, version or main entry does not match this checkout.');
  }
  for (const path of ['src/main.mjs', 'src/preload.cjs', 'src/ui/index.html', 'src/ui/app.mjs',
    'src/ui/styles.css', 'src/ui/tokens.css', 'assets/icon.png', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const entry = asar.statFile(layout.archive, normalize(path), false);
    if (!entry || entry.link || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
      throw new Error(`Missing or invalid app.asar entry: ${path}`);
    }
  }

  for (const path of ['p2c_roots_v1.pem', 'licenses/LICENSE.connectcoin-p2c-tools', 'licenses/PROVENANCE.md', 'licenses/dependencies/manifest.json']) {
    await requireFile(appRoot, resolve(layout.internal, path));
  }
  const roots = await readFile(resolve(layout.internal, 'p2c_roots_v1.pem'));
  if (!roots.equals(await readFile(resolve(project, 'helpers/p2c_roots_v1.pem')))) throw new Error('Packaged helper roots differ from this checkout.');
  const licenses = resolve(layout.internal, 'licenses/dependencies');
  const manifest = JSON.parse(await readFile(resolve(licenses, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest) || !manifest.length) throw new Error('Missing bundled dependency license manifest.');
  const seen = new Set();
  for (const entry of manifest) {
    const path = bundledLicensePath(licenses, entry?.file);
    if (seen.has(path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid bundled dependency license manifest.');
    seen.add(path);
    await requireFile(appRoot, path);
    if (createHash('sha256').update(await readFile(path)).digest('hex') !== entry.sha256) throw new Error(`Bundled license checksum differs: ${entry.file}`);
  }

  const expectedVersion = pinnedCryptographyVersion(await readFile(resolve(project, 'helpers/requirements.txt'), 'utf8'));
  const selfTest = spawnSync(layout.helper, ['--self-test'], {
    cwd: layout.app, shell: false, windowsHide: true, encoding: 'utf8',
    timeout: 30000, maxBuffer: 8192, input: '',
  });
  if (selfTest.error || selfTest.status !== 0) throw new Error('Packaged Automatic Claims helper failed its self-test.');
  const security = validateHelperSecurity(selfTest.stdout, expectedVersion);
  // Only start/shutdown frames: no claim requests, DNS, TLS, RPC or wallet data.
  const pool = new ConnectionPool({ helper: { command: layout.helper, args: [] } });
  try { await pool.start({}); }
  finally { await pool.close(); }
  console.log(`Packaged ConnectWallet ${packagedPackage.version} verified for ${options.platform}/${options.arch}: app.asar, native executables, roots, ${manifest.length} license files and protocol-4 startup/shutdown.`);
  console.log(`Packaged cryptography ${security.cryptographyVersion}; ${security.opensslVersion}. No GUI was launched.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await testPackaged(parsePackagedOptions(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
