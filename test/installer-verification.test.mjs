import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { link, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expectedArtifacts,
  parseArguments,
  validateArtifactSet,
  validateArtifactSignature,
  validateVersion,
  verifyInstallers,
} from '../scripts/verify-installers.mjs';

const version = '1.2.3';

function payload(extension) {
  const buffer = Buffer.alloc(extension === 'exe' ? 1024 : 512, 0);
  switch (extension) {
    case 'exe':
      buffer.write('MZ');
      buffer.writeUInt32LE(768, 0x3c);
      buffer.write('PE\0\0', 768);
      break;
    case 'msi': Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(buffer); break;
    case 'dmg': buffer.write('koly', buffer.length - 512); break;
    case 'zip': Buffer.from('504b0304', 'hex').copy(buffer); break;
    case 'deb': buffer.write('!<arch>\n'); break;
    case 'rpm': Buffer.from('edabeedb', 'hex').copy(buffer); break;
    case 'AppImage':
      Buffer.from('7f454c46', 'hex').copy(buffer);
      buffer.write('AI', 8);
      buffer[10] = 2;
      break;
    case 'tar.gz': Buffer.from('1f8b0800', 'hex').copy(buffer); break;
    default: throw new Error(`Unknown fixture: ${extension}.`);
  }
  return buffer;
}

function samples(buffer, extension) {
  return {
    size: buffer.length,
    head: buffer.subarray(0, 512),
    tail: buffer.subarray(Math.max(0, buffer.length - 512)),
    peHeader: extension === 'exe' && buffer.length >= 64
      ? buffer.subarray(buffer.readUInt32LE(0x3c), buffer.readUInt32LE(0x3c) + 4) : undefined,
  };
}

async function fixture(t, platform = 'win32', arch = 'x64', packageVersion = version) {
  // macOS may expose its temporary directory through /var -> /private/var.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'connectwallet-installer-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'artifacts');
  await mkdir(directory);
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: packageVersion }));
  const artifacts = expectedArtifacts({ version: packageVersion, platform, arch });
  for (const artifact of artifacts) await writeFile(join(directory, artifact.filename), payload(artifact.extension));
  return { root, directory, platform, arch, artifacts };
}

test('installer matrix has explicit stable filenames and supported architectures', () => {
  for (const [platform, arch, os, extensions] of [
    ['win32', 'x64', 'Windows', ['exe', 'msi']],
    ['darwin', 'x64', 'macOS', ['dmg', 'zip']],
    ['darwin', 'arm64', 'macOS', ['dmg', 'zip']],
    ['linux', 'x64', 'Linux', ['deb', 'rpm', 'AppImage', 'tar.gz']],
  ]) {
    assert.deepEqual(expectedArtifacts({ version, platform, arch }), extensions.map(extension => ({
      filename: `ConnectWallet-${version}-${os}-${arch}.${extension}`, extension,
    })));
  }
  for (const [platform, arch] of [['win32', 'arm64'], ['linux', 'arm64'], ['darwin', 'universal'], ['freebsd', 'x64'], ['__proto__', 'x64']]) {
    assert.throws(() => expectedArtifacts({ version, platform, arch }), /Unsupported installer target/);
  }
});

test('package version must be semantic and cannot supply path components', () => {
  for (const value of ['0.1.0', '1.2.3-rc.1', '1.2.3+build.4', '1.2.3-alpha.1+build.4']) assert.equal(validateVersion(value), value);
  for (const value of [undefined, 123, '', '1.2', '01.2.3', '1.2.3-01', '../1.2.3', '1.2.3/extra', '1.2.3\\extra', '1.2.3\n']) {
    assert.throws(() => validateVersion(value), /valid semantic version/);
  }
});

test('CLI arguments require explicit output directory, platform and architecture', () => {
  assert.deepEqual(parseArguments(['--directory=C:\\output with spaces', '--platform=win32', '--arch=x64']), {
    directory: 'C:\\output with spaces', platform: 'win32', arch: 'x64',
  });
  assert.deepEqual(parseArguments(['--help']), { help: true });
  for (const args of [[], ['--directory=dist'], ['--directory=dist', '--platform=win32'], ['--directory='], ['--arch=x64', '--arch=arm64'], ['--publish=always']]) {
    assert.throws(() => parseArguments(args), /required argument|Invalid or duplicate argument/);
  }
});

test('exact installer set rejects missing, stale, duplicate and escaped names', () => {
  const expected = expectedArtifacts({ version, platform: 'win32', arch: 'x64' });
  const filenames = expected.map(artifact => artifact.filename);
  assert.equal(validateArtifactSet([...filenames, 'builder-debug.yml', 'win-unpacked', 'SHA256SUMS'], expected), true);
  assert.throws(() => validateArtifactSet(filenames.slice(0, 1), expected), /Missing installer payloads/);
  for (const unexpected of ['old.exe', 'other.MSI', 'source.zip', 'ConnectWallet-0.1.0-Windows-x64.exe']) {
    assert.throws(() => validateArtifactSet([...filenames, unexpected], expected), /Unexpected installer payloads/);
  }
  assert.throws(() => validateArtifactSet([...filenames, filenames[0]], expected), /Duplicate/);
  for (const invalid of ['../outside.exe', '..\\outside.exe', '/absolute.exe', 'C:\\outside.exe', 'payload.exe:stream']) {
    assert.throws(() => validateArtifactSet([...filenames, invalid], expected), /inside the explicit output directory/);
  }
});

test('all installer formats require their own nonempty file signature', () => {
  for (const extension of ['exe', 'msi', 'dmg', 'zip', 'deb', 'rpm', 'AppImage', 'tar.gz']) {
    const buffer = payload(extension);
    assert.equal(validateArtifactSignature(extension, samples(buffer, extension)), true);
    assert.throws(() => validateArtifactSignature(extension, samples(Buffer.alloc(0), extension)), /empty/);
    assert.throws(() => validateArtifactSignature(extension, samples(Buffer.alloc(512), extension)), /file signature/);
    assert.throws(() => validateArtifactSignature(extension, samples(Buffer.from('<html>download error</html>'), extension)), /file signature/);
  }
  assert.throws(() => validateArtifactSignature('unknown', samples(payload('zip'), 'zip')), /Unsupported installer format/);
});

test('PE pointer, DMG footer, nonempty ZIP, AppImage marker and gzip flags are checked', () => {
  const exe = payload('exe');
  exe.writeUInt32LE(exe.length, 0x3c);
  assert.throws(() => validateArtifactSignature('exe', samples(exe, 'exe')), /file signature/);
  exe.writeUInt32LE(8, 0x3c);
  exe.write('PE\0\0', 8);
  assert.throws(() => validateArtifactSignature('exe', samples(exe, 'exe')), /file signature/);
  const dmg = Buffer.alloc(1024);
  dmg.write('koly');
  assert.throws(() => validateArtifactSignature('dmg', samples(dmg, 'dmg')), /file signature/);
  const emptyZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  assert.throws(() => validateArtifactSignature('zip', samples(emptyZip, 'zip')), /file signature/);
  const appImage = payload('AppImage');
  appImage[10] = 3;
  assert.throws(() => validateArtifactSignature('AppImage', samples(appImage, 'AppImage')), /file signature/);
  appImage.fill(0, 8, 11);
  assert.throws(() => validateArtifactSignature('AppImage', samples(appImage, 'AppImage')), /file signature/);
  const gzip = payload('tar.gz');
  gzip[3] = 0x20;
  assert.throws(() => validateArtifactSignature('tar.gz', samples(gzip, 'tar.gz')), /file signature/);
});

for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['linux', 'x64']]) {
  test(`verification writes reproducible hashes and honest metadata for ${platform}/${arch}`, async t => {
    const options = await fixture(t, platform, arch);
    await mkdir(join(options.directory, 'unpacked'));
    await writeFile(join(options.directory, 'builder-debug.yml'), 'metadata');
    const manifest = await verifyInstallers(options);
    assert.equal(manifest.version, version);
    assert.equal(manifest.platform, platform);
    assert.equal(manifest.arch, arch);
    assert.equal(manifest.signing, 'not verified');
    assert.equal(manifest.notarization, 'not verified');
    assert.equal(manifest.sourceRevision, null);
    assert.equal(manifest.sourceDirty, null);
    assert.match(manifest.sourceRevisionBasis, /build provenance not verified/);
    const sums = [];
    for (const artifact of manifest.artifacts) {
      const original = payload(artifact.format);
      assert.equal(artifact.size, original.length);
      assert.equal(artifact.sha256, createHash('sha256').update(original).digest('hex'));
      assert.deepEqual(await readFile(join(options.directory, artifact.filename)), original);
      sums.push(`${artifact.sha256}  ${artifact.filename}\n`);
    }
    assert.equal(await readFile(join(options.directory, 'SHA256SUMS'), 'utf8'), sums.join(''));
    assert.deepEqual(JSON.parse(await readFile(join(options.directory, 'manifest.json'), 'utf8')), manifest);
    assert.equal((await verifyInstallers(options)).artifacts.length, options.artifacts.length);
  });
}

test('validation reads the repository version and rejects invalid package versions', async t => {
  const options = await fixture(t);
  await writeFile(join(options.root, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  await assert.rejects(verifyInstallers(options), /Missing installer payloads.*Unexpected installer payloads/);
  await writeFile(join(options.root, 'package.json'), JSON.stringify({ version: '../outside' }));
  await assert.rejects(verifyInstallers(options), /valid semantic version/);
});

test('sourceDirty distinguishes clean and dirty Git checkouts from unavailable status', async t => {
  const options = await fixture(t);
  const initialized = spawnSync('git', ['init', '--quiet', options.root], { encoding: 'utf8', windowsHide: true });
  if (initialized.error?.code === 'ENOENT') return t.skip('Git is unavailable on this host.');
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal((await verifyInstallers(options)).sourceDirty, true);
  // No commit is needed: an empty repository with all fixtures ignored is clean.
  await writeFile(join(options.root, '.git', 'info', 'exclude'), '*\n');
  assert.equal((await verifyInstallers(options)).sourceDirty, false);
});

test('missing, empty, invalid and directory payloads cannot produce success reports', async t => {
  for (const kind of ['missing', 'empty', 'invalid', 'directory']) {
    const options = await fixture(t);
    const path = join(options.directory, options.artifacts[0].filename);
    if (kind === 'missing' || kind === 'directory') await rm(path);
    if (kind === 'empty') await writeFile(path, '');
    if (kind === 'invalid') await writeFile(path, '<html>failed download</html>');
    if (kind === 'directory') await mkdir(path);
    await assert.rejects(verifyInstallers(options), /Missing installer payloads|empty|file signature|regular file/);
    await assert.rejects(readFile(join(options.directory, 'SHA256SUMS')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(options.directory, 'manifest.json')), { code: 'ENOENT' });
  }
});

test('symlinked payloads and report paths are rejected without changing external targets', async t => {
  const options = await fixture(t);
  const external = join(options.root, 'external-file');
  await writeFile(external, payload('exe'));
  const installer = join(options.directory, options.artifacts[0].filename);
  await rm(installer);
  let directoryLink = false;
  try {
    await symlink(external, installer, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    // Windows junctions exercise the same rejection without Developer Mode.
    directoryLink = true;
    await symlink(options.root, installer, 'junction');
  }
  await assert.rejects(verifyInstallers(options), /Symlinks/);
  await rm(installer);
  await writeFile(installer, payload('exe'));
  await symlink(directoryLink ? options.root : external, join(options.directory, 'manifest.json'), directoryLink ? 'junction' : 'file');
  await assert.rejects(verifyInstallers(options), /Symlinks/);
  assert.deepEqual(await readFile(external), payload('exe'));
});

test('hardlinked reports cannot overwrite a file outside the explicit output directory', async t => {
  const options = await fixture(t);
  const external = join(options.root, 'external-report');
  await writeFile(external, 'preserve this file');
  await link(external, join(options.directory, 'manifest.json'));
  await assert.rejects(verifyInstallers(options), /regular file with no links/);
  assert.equal(await readFile(external, 'utf8'), 'preserve this file');
  await assert.rejects(readFile(join(options.directory, 'SHA256SUMS')), { code: 'ENOENT' });
});

test('symlinked output directories and linked ancestors are rejected', async t => {
  const options = await fixture(t);
  const linked = join(options.root, 'linked-output');
  await symlink(options.directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyInstallers({ ...options, directory: linked }), /not a symlink/);
  const parentLink = join(options.root, 'linked-parent');
  const parentDirectory = join(options.root, 'parent');
  await mkdir(parentDirectory);
  await mkdir(join(parentDirectory, 'output'));
  await symlink(parentDirectory, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyInstallers({ ...options, directory: join(parentLink, 'output') }), /resolve through symlinks/);
});

test('CLI returns an error for incomplete arguments and advertises its local-only scope', () => {
  const script = fileURLToPath(new URL('../scripts/verify-installers.mjs', import.meta.url));
  const failed = spawnSync(process.execPath, [script, '--directory=dist'], { encoding: 'utf8', windowsHide: true });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Missing required argument: --platform/);
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', windowsHide: true });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Does not execute installers, publish/);
});

test('CLI uses the real package version and records the current repository Git revision', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const options = await fixture(t, 'win32', 'x64', pkg.version);
  const script = fileURLToPath(new URL('../scripts/verify-installers.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, `--directory=${options.directory}`, '--platform=win32', '--arch=x64'], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(options.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  const revision = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(manifest.sourceRevision, revision.status === 0 ? revision.stdout.trim() : null);
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536,
  });
  assert.equal(manifest.sourceDirty, status.status === 0 ? status.stdout.trim().length > 0 : null);
});
