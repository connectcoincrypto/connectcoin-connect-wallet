import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionPool } from '../src/core/claim-pool.mjs';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const python = resolve(base, '.claims-venv', windows ? 'Scripts/python.exe' : 'bin/python');
const build = process.argv.slice(2).includes('--build');
if (process.argv.slice(2).some((arg) => arg !== '--build')) throw new Error('Usage: node scripts/setup-claims.mjs [--build]');

function run(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: base, stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? accept() : reject(new Error(`${command} exited with ${code}`)));
  });
}

try { await access(python); } catch {
  // PYTHON is an executable path, never a shell command. No silent system mutation.
  const command = process.env.PYTHON || (windows ? 'py' : 'python3');
  const prefix = windows && !process.env.PYTHON ? ['-3'] : [];
  await run(command, [...prefix, '-m', 'venv', resolve(base, '.claims-venv')]);
}
await run(python, ['-c', 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ is required"']);
if (build) await run(python, ['-c',
  'import platform, struct, sys; expected = {"x64": ("amd64", "x86_64"), "arm64": ("arm64", "aarch64")}; assert struct.calcsize("P") == 8 and platform.machine().lower() in expected.get(sys.argv[1], ()), "Python architecture must match the native Node/Electron target"', process.arch]);
await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', resolve(base, 'helpers', build ? 'requirements-build.txt' : 'requirements.txt')]);
await run(python, ['-I', resolve(base, 'helpers/claims_bridge.py'), '--self-test']);
// Force the source runtime even if a previously built native helper exists.
// This is the wallet's actual isolated launch/protocol, with no network or keys.
const sourcePool = new ConnectionPool({ helper: { command: python, args: ['-I', resolve(base, 'helpers/claims_bridge.py')] } });
try { await sourcePool.start({}); }
finally { await sourcePool.close(); }
console.log('Isolated source protocol-4 startup and shutdown verified.');
await run(python, ['-m', 'unittest', 'discover', '-s', resolve(base, 'helpers/tests'), '-v']);
if (build) {
  await run(python, [resolve(base, 'helpers/collect_licenses.py')]);
  await run(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'connectwallet-claims',
    '--distpath', resolve(base, 'helpers/bin'), '--workpath', resolve(base, 'tmp/claims-build'),
    '--specpath', resolve(base, 'tmp'), '--paths', resolve(base, 'helpers/vendor'),
    '--add-data', `${resolve(base, 'helpers/p2c_roots_v1.pem')}${windows ? ';' : ':'}.`,
    '--add-data', `${resolve(base, 'helpers/vendor/LICENSE.connectcoin-p2c-tools')}${windows ? ';' : ':'}licenses`,
    '--add-data', `${resolve(base, 'helpers/PROVENANCE.md')}${windows ? ';' : ':'}licenses`,
    '--add-data', `${resolve(base, 'tmp/claims-licenses')}${windows ? ';' : ':'}licenses/dependencies`,
    resolve(base, 'helpers/claims_bridge.py')]);
  await run(resolve(base, 'helpers/bin/connectwallet-claims', windows ? 'connectwallet-claims.exe' : 'connectwallet-claims'), ['--self-test']);
}
console.log(build ? 'Standalone Automatic Claims helper built and verified.' : 'Automatic Claims helper installed and verified.');
