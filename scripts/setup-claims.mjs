// C++ is the desktop runtime. Python is an explicitly selected test reference.
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { availableParallelism } from 'node:os';
import { ConnectionPool } from '../src/core/claim-pool.mjs';
import { validateNativeHelperSecurity } from './helper-security.mjs';
import { NATIVE_LICENSE_FILES, NATIVE_ROOT_SHA256 } from './native-helper-manifest.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.slice(2).some(arg => arg !== '--build')) throw new Error('Usage: node scripts/setup-claims.mjs [--build]');
const cmake = process.env.CMAKE || 'cmake';
const directory = resolve(base, 'tmp/native-build');
const destination = resolve(base, 'helpers/native-bin/connectwallet-claims');
const python = resolve(base, '.claims-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const parallel = process.env.CONNECTWALLET_BUILD_JOBS ?? String(Math.min(4, availableParallelism()));
if (!/^[1-9][0-9]*$/.test(parallel) || Number(parallel) > 256) throw new Error('Invalid CONNECTWALLET_BUILD_JOBS.');
const run = (command, args) => new Promise((accept, reject) => {
  const child = spawn(command, args, { cwd: base, stdio: 'inherit', shell: false, windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited with ${code}`)));
});
// This installs only the isolated offline reference and runs its regression suite.
// The reference is never packaged or used as a silent runtime fallback.
await run(process.execPath, ['scripts/setup-python-reference.mjs']);
await run(cmake, ['-S', resolve(base, 'native'), '-B', directory, '-DCMAKE_BUILD_TYPE=Release',
  `-DCLAIMER_TEST_PYTHON=${python}`, '-DCLAIMER_REQUIRE_FIXTURE_TESTS=ON',
  ...(process.platform === 'win32' ? ['-A', process.arch === 'arm64' ? 'ARM64' : 'x64'] : []),
  ...(process.platform === 'darwin' ? ['-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0', `-DCMAKE_OSX_ARCHITECTURES=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`] : []),
  `-DCMAKE_INSTALL_PREFIX=${destination}`]);
await run(cmake, ['--build', directory, '--config', 'Release', '--parallel', parallel]);
await run(process.env.CTEST || 'ctest', ['--test-dir', directory, '-C', 'Release', '--output-on-failure']);
await run(cmake, ['--install', directory, '--config', 'Release', '--component', 'claimerRuntime']);
const name = process.platform === 'win32' ? 'connectwallet-claims.exe' : 'connectwallet-claims';
const command = resolve(destination, name);
const built = [resolve(directory, 'Release', name), resolve(directory, name)].find(existsSync);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (!built || hash(await readFile(built)) !== hash(await readFile(command))) throw new Error('Installed helper differs from the fresh build.');
const { stdout } = await promisify(execFile)(command, ['--self-test', '--require-native-mbedtls'], { timeout: 30000, windowsHide: true, maxBuffer: 65536 });
validateNativeHelperSecurity(stdout);
const pool = new ConnectionPool({ helper: { command, args: [], native: true } });
try { await pool.start({}); } finally { await pool.close(); }
const files = [];
for (const file of NATIVE_LICENSE_FILES) files.push({ file, sha256: hash(await readFile(resolve(destination, 'licenses', file))) });
await writeFile(resolve(destination, 'licenses/manifest.json'), JSON.stringify({ provider: 'mbedtls', version: '3.6.7', rootsSha256: NATIVE_ROOT_SHA256, files }, null, 2) + '\n');
console.log('C++ Automatic Claims helper built; Python/native regressions and offline protocol startup/shutdown verified.');
