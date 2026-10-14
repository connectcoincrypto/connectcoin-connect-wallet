// Offline differential reference only. Never build or select it as app runtime.
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionPool } from '../src/core/claim-pool.mjs';

if (process.argv.length !== 2) throw new Error('Usage: node scripts/setup-python-reference.mjs');
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
const python = resolve(base, '.claims-venv', windows ? 'Scripts/python.exe' : 'bin/python');
const run = (command, args) => new Promise((accept, reject) => {
  const child = spawn(command, args, { cwd: base, stdio: 'inherit', shell: false, windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited with ${code}`)));
});
try { await access(python); } catch {
  // Executable path only; never a shell command or global Python mutation.
  const command = process.env.PYTHON || (windows ? 'py' : 'python3');
  await run(command, [...(windows && !process.env.PYTHON ? ['-3'] : []), '-m', 'venv', resolve(base, '.claims-venv')]);
}
await run(python, ['-c', 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ is required"']);
await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', resolve(base, 'helpers/requirements.txt')]);
await run(python, ['-I', resolve(base, 'helpers/claims_bridge.py'), '--self-test']);
const reference = new ConnectionPool({ helper: { command: python, args: ['-I', resolve(base, 'helpers/claims_bridge.py')] } });
try { await reference.start({}); } finally { await reference.close(); }
await run(python, ['-m', 'unittest', 'discover', '-s', resolve(base, 'helpers/tests'), '-v']);
console.log('Isolated Python reference validated; it is not the desktop runtime.');
