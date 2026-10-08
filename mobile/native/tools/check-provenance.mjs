import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, relative, sep } from 'node:path';

const root = fileURLToPath(new URL('../vendor/core/', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'provenance.json'), 'utf8'));
if (!/^[a-f0-9]{40}$/.test(manifest.checkout_head) || !Array.isArray(manifest.files) || manifest.files.length < 10) throw new Error('Invalid provenance manifest');
const seen = new Set();
for (const entry of manifest.files) {
  if (typeof entry.path !== 'string' || seen.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.vendored_sha256)) throw new Error('Invalid provenance entry');
  seen.add(entry.path);
  const path = resolve(root, entry.path);
  const inside = relative(root, path);
  if (inside === '..' || inside.startsWith(`..${sep}`) || resolve(root, inside) !== path) throw new Error('Path escaped vendor root');
  const bytes = await readFile(path);
  // Git checkouts may normalize LF to CRLF. Consensus root bytes are immutable;
  // the repository attributes must retain LF for that pinned file.
  const digest = createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
  if (digest !== entry.vendored_sha256) throw new Error(`Vendored Core file changed without review: ${entry.path}`);
}
const roots = await readFile(resolve(root, 'src/consensus/p2c_roots_v1.pem'));
if (createHash('sha256').update(roots).digest('hex') !== 'f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9') throw new Error('Consensus trust roots changed');
console.log(`Verified ${seen.size} vendored Core source files and the immutable version-1 root bundle.`);
