import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG, readConfig } from '../src/core/config.mjs';

const config = { ...structuredClone(DEFAULT_CONFIG), claims: { ...DEFAULT_CONFIG.claims, enabled: false } };
const serialized = JSON.stringify(config);

async function fixture(t, contents, chunkSize, { readErrorAt = Infinity } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'wallet-config-short-read-'));
  const path = join(directory, 'config.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path, contents);
  const realOpen = fs.open;
  let reads = 0, closes = 0;
  const stub = t.mock.method(fs, 'open', async (name, flags, ...rest) => {
    const handle = await realOpen(name, flags, ...rest);
    if (name !== path || flags !== 'r') return handle;
    return {
      stat: () => handle.stat(),
      async read(buffer, offset, length, position) {
        if (++reads === readErrorAt) throw Object.assign(new Error('Injected configuration read failure'), { code: 'EIO' });
        return handle.read(buffer, offset, Math.min(length, chunkSize), position);
      },
      async close() { closes++; return handle.close(); },
    };
  });
  syncBuiltinESMExports();
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports(); });
  return { directory, path, reads: () => reads, closes: () => closes };
}

for (const chunkSize of [1, 7, 127]) test(`short configuration reads of ${chunkSize} bytes retain the saved safety and connection settings`, async t => {
  const { directory, path, reads, closes } = await fixture(t, serialized, chunkSize);
  assert.deepEqual(await readConfig(directory), config);
  assert.ok(reads() > 1); assert.equal(closes(), 1);
  assert.equal(await fs.readFile(path, 'utf8'), serialized);
});

test('a complete configuration JSON prefix cannot hide corrupt trailing bytes after a short read', async t => {
  const contents = serialized + '\nnot valid JSON';
  const { directory, path, closes } = await fixture(t, contents, Buffer.byteLength(serialized));
  await assert.rejects(readConfig(directory), SyntaxError);
  assert.equal(closes(), 1); assert.equal(await fs.readFile(path, 'utf8'), contents);
});

test('a read error after a valid configuration prefix must fail without replacing the saved settings', async t => {
  const contents = serialized + '\n';
  const { directory, path, closes } = await fixture(t, contents, Buffer.byteLength(serialized), { readErrorAt: 2 });
  await assert.rejects(readConfig(directory), { code: 'EIO' });
  assert.equal(closes(), 1); assert.equal(await fs.readFile(path, 'utf8'), contents);
});

for (const size of [16384, 16385]) test(`short configuration reads enforce the exact 16 KiB boundary at ${size} bytes`, async t => {
  const contents = serialized + ' '.repeat(size - Buffer.byteLength(serialized));
  const { directory, path, closes } = await fixture(t, contents, Buffer.byteLength(serialized));
  if (size === 16384) assert.deepEqual(await readConfig(directory), config);
  else await assert.rejects(readConfig(directory), /Configuration file is too large/);
  assert.equal(closes(), 1); assert.equal((await fs.stat(path)).size, size);
});
