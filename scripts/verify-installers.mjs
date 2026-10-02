import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = Object.freeze({
  win32: { label: 'Windows', architectures: ['x64'], extensions: ['exe', 'msi'] },
  darwin: { label: 'macOS', architectures: ['x64', 'arm64'], extensions: ['dmg', 'zip'] },
  linux: { label: 'Linux', architectures: ['x64'], extensions: ['deb', 'rpm', 'AppImage', 'tar.gz'] },
});
const installerExtension = /\.(?:exe|msi|dmg|zip|deb|rpm|appimage|tar\.gz)$/i;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validateVersion(version) {
  if (typeof version !== 'string' || version.length > 128 || !versionPattern.test(version)) {
    throw new Error('package.json must contain a valid semantic version.');
  }
  return version;
}

export function expectedArtifacts({ version, platform, arch }) {
  validateVersion(version);
  const target = Object.hasOwn(targets, platform) ? targets[platform] : undefined;
  if (!target || !target.architectures.includes(arch)) {
    throw new Error(`Unsupported installer target: ${platform}/${arch}. Expected win32/x64, darwin/x64, darwin/arm64 or linux/x64.`);
  }
  return target.extensions.map(extension => ({
    filename: `ConnectWallet-${version}-${target.label}-${arch}.${extension}`,
    extension,
  }));
}

function assertBasename(filename) {
  if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..' || /[\\/\0:]/.test(filename)) {
    throw new Error(`Artifact must be a filename inside the explicit output directory: ${JSON.stringify(filename)}.`);
  }
}

// Builder metadata and unpacked application directories are allowed; other
// installer payloads (including stale versions or architectures) are not.
export function validateArtifactSet(filenames, expected) {
  const wanted = new Set(expected.map(artifact => artifact.filename));
  const actual = new Set();
  for (const filename of filenames) {
    assertBasename(filename);
    if (actual.has(filename)) throw new Error(`Duplicate artifact filename: ${filename}.`);
    actual.add(filename);
  }
  const missing = [...wanted].filter(filename => !actual.has(filename));
  const unexpected = [...actual].filter(filename => installerExtension.test(filename) && !wanted.has(filename));
  if (missing.length || unexpected.length) {
    throw new Error([
      missing.length ? `Missing installer payloads: ${missing.join(', ')}.` : '',
      unexpected.length ? `Unexpected installer payloads: ${unexpected.join(', ')}.` : '',
    ].filter(Boolean).join(' '));
  }
  return true;
}

const matches = (buffer, bytes, offset = 0) => Buffer.isBuffer(buffer)
  && buffer.length >= offset + bytes.length
  && buffer.subarray(offset, offset + bytes.length).equals(Buffer.from(bytes));

// Pure format checks use only small samples. The file reader obtains the PE
// signature at e_lfanew separately, even when it lies beyond the first 512 bytes.
// These signatures identify containers; they do not verify their full contents,
// cryptographic signatures, installability, or the architecture of their payload.
export function validateArtifactSignature(extension, { size, head, tail, peHeader } = {}) {
  if (!Number.isSafeInteger(size) || size <= 0 || !Buffer.isBuffer(head)) {
    throw new Error('Installer payload is empty or has an invalid size.');
  }
  let valid = false;
  switch (extension) {
    case 'exe': {
      if (head.length >= 64 && matches(head, [0x4d, 0x5a])) {
        const offset = head.readUInt32LE(0x3c);
        valid = offset >= 64 && offset <= size - 4
          && matches(peHeader ?? head.subarray(offset, offset + 4), [0x50, 0x45, 0, 0]);
      }
      break;
    }
    case 'msi':
      valid = size >= 512 && matches(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
      break;
    case 'dmg':
      valid = size >= 512 && Buffer.isBuffer(tail) && tail.length === 512 && matches(tail, [0x6b, 0x6f, 0x6c, 0x79]);
      break;
    case 'zip':
      valid = size >= 30 && matches(head, [0x50, 0x4b, 0x03, 0x04]);
      break;
    case 'deb':
      valid = size > 8 && matches(head, [0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]);
      break;
    case 'rpm':
      valid = size >= 96 && matches(head, [0xed, 0xab, 0xee, 0xdb]);
      break;
    case 'AppImage':
      valid = size >= 64 && matches(head, [0x7f, 0x45, 0x4c, 0x46])
        && matches(head, [0x41, 0x49], 8) && (head[10] === 1 || head[10] === 2);
      break;
    case 'tar.gz':
      valid = size >= 18 && matches(head, [0x1f, 0x8b, 0x08]) && (head[3] & 0xe0) === 0;
      break;
    default:
      throw new Error(`Unsupported installer format: ${extension}.`);
  }
  if (!valid) throw new Error(`Invalid ${extension} installer file signature.`);
  return true;
}

function artifactPath(directory, filename) {
  assertBasename(filename);
  const path = resolve(directory, filename);
  const within = relative(directory, path);
  if (!within || within.startsWith('..') || isAbsolute(within)) {
    throw new Error(`Artifact path is outside the explicit directory: ${filename}.`);
  }
  return path;
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function inspectDirectory(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('An explicit installer directory is required.');
  const absolute = resolve(directory);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Installer directory must be a real directory, not a symlink.');
  const canonical = await realpath(absolute);
  if (relative(absolute, canonical) !== '') throw new Error('Installer directory must not resolve through symlinks.');
  const entries = await readdir(canonical);
  for (const filename of entries) {
    const entry = await lstat(artifactPath(canonical, filename));
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in the installer directory: ${filename}.`);
  }
  return { directory: canonical, entries };
}

async function sample(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function inspectArtifact(directory, artifact) {
  const path = artifactPath(directory, artifact.filename);
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Installer payload must be a regular file: ${artifact.filename}.`);
  if (relative(path, await realpath(path)) !== '') throw new Error(`Installer payload resolves outside its expected path: ${artifact.filename}.`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await handle.stat();
    if (!sameFile(before, initial) || !initial.isFile()) throw new Error(`Installer payload changed during validation: ${artifact.filename}.`);
    const size = initial.size;
    const head = await sample(handle, Math.min(size, 512), 0);
    const tail = artifact.extension === 'dmg' && size >= 512 ? await sample(handle, 512, size - 512) : undefined;
    let peHeader;
    if (artifact.extension === 'exe' && head.length >= 64) {
      const offset = head.readUInt32LE(0x3c);
      if (offset >= 64 && offset <= size - 4) peHeader = await sample(handle, 4, offset);
    }
    try {
      validateArtifactSignature(artifact.extension, { size, head, tail, peHeader });
    } catch (error) {
      throw new Error(`${artifact.filename}: ${error.message}`, { cause: error });
    }
    const hash = createHash('sha256');
    let bytesRead = 0;
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
      bytesRead += chunk.length;
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (bytesRead !== size || after.size !== size || after.mtimeMs !== initial.mtimeMs || after.ctimeMs !== initial.ctimeMs) {
      throw new Error(`Installer payload changed while hashing: ${artifact.filename}.`);
    }
    return { filename: artifact.filename, format: artifact.extension, size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function inspectReport(directory, filename) {
  const path = artifactPath(directory, filename);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Report must be a regular file with no links: ${filename}.`);
    }
    return { path, stat };
  } catch (error) {
    if (error.code === 'ENOENT') return { path, stat: null };
    throw error;
  }
}

async function writeReport(report, content) {
  // Open without truncating, then check identity before changing an existing
  // report. Exclusive creation also prevents following a newly introduced link.
  const flags = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
    | (report.stat ? 0 : constants.O_CREAT | constants.O_EXCL);
  const handle = await open(report.path, flags, 0o644);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || (report.stat && !sameFile(report.stat, current))) {
      throw new Error(`Report changed during validation: ${report.path}.`);
    }
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

async function sourceRevision(root) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 1024,
    });
    const revision = stdout.trim();
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision) ? revision : null;
  } catch {
    return null;
  }
}

async function sourceDirty(root) {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
      cwd: root, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536,
    });
    return stdout.trim().length > 0;
  } catch {
    // Unavailable Git, a timeout, or output exceeding the bound is unknown,
    // never evidence that the checkout was clean.
    return null;
  }
}

export async function verifyInstallers({ directory, platform, arch, root = repositoryRoot } = {}) {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const expected = expectedArtifacts({ version: pkg.version, platform, arch });
  const inspected = await inspectDirectory(directory);
  validateArtifactSet(inspected.entries, expected);
  const artifacts = [];
  for (const artifact of expected) artifacts.push(await inspectArtifact(inspected.directory, artifact));
  const [revision, dirty] = await Promise.all([sourceRevision(root), sourceDirty(root)]);
  const manifest = {
    schemaVersion: 1,
    productName: 'ConnectWallet',
    version: pkg.version,
    platform,
    os: targets[platform].label,
    arch,
    generatedAt: new Date().toISOString(),
    sourceRevision: revision,
    sourceDirty: dirty,
    sourceRevisionBasis: 'Repository HEAD at verification; artifact build provenance not verified.',
    signing: 'not verified',
    notarization: 'not verified',
    validation: 'Expected filenames, nonempty files, container signatures and SHA-256; installation and contained payloads not verified.',
    artifacts,
  };
  const checksumReport = await inspectReport(inspected.directory, 'SHA256SUMS');
  const manifestReport = await inspectReport(inspected.directory, 'manifest.json');
  await writeReport(checksumReport, artifacts.map(artifact => `${artifact.sha256}  ${artifact.filename}\n`).join(''));
  await writeReport(manifestReport, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function parseArguments(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true };
  const options = {};
  for (const argument of args) {
    const match = /^--(directory|platform|arch)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(options, match[1])) throw new Error(`Invalid or duplicate argument: ${argument}.`);
    options[match[1]] = match[2];
  }
  for (const key of ['directory', 'platform', 'arch']) {
    if (!options[key]?.trim()) throw new Error(`Missing required argument: --${key}=...`);
  }
  return options;
}

const help = 'Usage: node scripts/verify-installers.mjs --directory=<output-dir> --platform=win32|darwin|linux --arch=x64|arm64\nSupported targets: win32/x64, darwin/x64, darwin/arm64, linux/x64.\nValidates local files and writes SHA256SUMS and manifest.json. Does not execute installers, publish, or verify signing/notarization.';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(help);
    else {
      const manifest = await verifyInstallers(options);
      console.log(`Verified ${manifest.artifacts.length} ${manifest.os}/${manifest.arch} installer containers for ConnectWallet ${manifest.version}.`);
      console.log('Wrote SHA256SUMS and manifest.json. Signing and notarization: not verified.');
    }
  } catch (error) {
    console.error(`Installer verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
