import { access, readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionPool } from '../src/core/claim-pool.mjs';
import { pinnedCryptographyVersion, validateHelperSecurity } from './helper-security.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = resolve(root, 'helpers/bin/connectwallet-claims', process.platform === 'win32' ? 'connectwallet-claims.exe' : 'connectwallet-claims');
try {
  await access(helper);
  await access(resolve(root, 'assets/icon.png'));
  await access(resolve(root, 'assets/icon.ico'));
} catch {
  throw new Error('Desktop packaging requires the native Automatic Claims helper and icons. Run npm run build:claims and npm run build:icon on this operating system first.');
}
const expectedVersion = pinnedCryptographyVersion(await readFile(resolve(root, 'helpers/requirements.txt'), 'utf8'));
const selfTest = spawnSync(helper, ['--self-test'], {
  cwd: root, shell: false, windowsHide: true, encoding: 'utf8',
  timeout: 30000, maxBuffer: 8192, input: '',
});
if (selfTest.error || selfTest.status !== 0) throw new Error('Bundled Automatic Claims helper failed its self-test. Run npm run build:claims.');
const security = validateHelperSecurity(selfTest.stdout, expectedVersion);
console.log(`Bundled cryptography ${security.cryptographyVersion}; ${security.opensslVersion}.`);
// A legacy one-shot executable can pass its own self-test but still be
// incompatible with the wallet. Exercise the real protocol-4 handshake too;
// this sends no DNS requests, TLS connections, RPC calls or wallet data.
const pool = new ConnectionPool({ helper: { command: helper, args: [] } });
try { await pool.start({}); }
finally { await pool.close(); }
// An older helper may lack RSA probing. Exercise the new mode with an
// invalid request so packaging cannot silently ship it; no DNS/TLS is attempted.
await new Promise((accept, reject) => {
  const child = spawn(helper, ['--probe-rsa', '--require-rsa-exponent-64'], { cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
  let output = '', bytes = 0, failed = false;
  const fail = () => { failed = true; child.kill(); reject(new Error('Bundled helper lacks the RSA probe. Run npm run build:claims.')); };
  child.once('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) fail(); else output += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) fail(); });
  child.once('close', code => {
    if (failed) return;
    try {
      const reply = JSON.parse(output);
      if (code !== 1 || reply.type !== 'error' || reply.message !== 'Invalid or incomplete RSA probe request.') return fail();
      accept();
    } catch { fail(); }
  });
  child.stdin.end('{}\n');
});
console.log('Native protocol-4 helper, RSA probe and desktop assets verified for packaging.');
