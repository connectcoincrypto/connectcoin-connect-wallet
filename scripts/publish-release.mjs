import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expectedArtifacts, validateVersion } from './verify-installers.mjs';

const execFileAsync = promisify(execFile);
const repository = 'connectcoincrypto/connectcoin-connect-wallet';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const matrix = [['win32', 'x64'], ['linux', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']];
const sorted = values => [...values].sort();
const check = (condition, message) => assert.ok(condition, message);

export function releaseTargets(version) {
  return matrix.map(([platform, arch]) => ({
    platform, arch, key: `${platform}-${arch}`,
    filenames: expectedArtifacts({ version, platform, arch }).map(artifact => artifact.filename),
  }));
}

export function buildAssetPlan(version) {
  const targets = releaseTargets(version);
  return [...targets.flatMap(target => target.filenames), ...targets.map(target => `manifest-${target.key}.json`), 'SHA256SUMS'];
}

function validateOrigin(run, { sha, repositoryId, repository: expectedRepository }) {
  check(run && shaPattern.test(sha), 'Invalid run or expected source revision');
  assert.equal(run.head_sha, sha, 'Workflow source revision must match the publishing checkout');
  assert.equal(run.head_branch, 'main', 'Workflow source branch must be main');
  for (const field of ['repository', 'head_repository']) {
    assert.equal(run[field]?.id, repositoryId, `Wrong workflow ${field} id`);
    assert.equal(run[field]?.full_name, expectedRepository, `Wrong workflow ${field} name`);
  }
  assert.equal(run.status, 'completed', 'Workflow must be completed');
  assert.equal(run.conclusion, 'success', 'Workflow must be successful');
}

export function validateRun(run, context) {
  validateOrigin(run, context);
  assert.equal(run.event, 'workflow_dispatch', 'Installer run must be manually dispatched');
  assert.equal(run.path, '.github/workflows/installers.yml', 'Wrong installer workflow path');
  if (context.runId) assert.equal(String(run.id), context.runId, 'Wrong installer run id');
  return true;
}

export function validateJobs(jobs) {
  check(Array.isArray(jobs), 'Missing installer jobs');
  assert.deepEqual(sorted(jobs.map(job => job.name)), sorted(matrix.map(([platform, arch]) => `${platform} / ${arch}`)), 'Exactly four installer matrix jobs are required');
  for (const job of jobs) {
    assert.equal(job.status, 'completed', `Installer job ${job.name} must be completed`);
    assert.equal(job.conclusion, 'success', `Installer job ${job.name} must be successful`);
  }
  return true;
}

export function validateTestRuns(runs, context) {
  check(Array.isArray(runs), 'Missing Wallet tests runs');
  check(runs.some(run => {
    try {
      validateOrigin(run, context);
      return run.event === 'push' && run.path === '.github/workflows/test.yml';
    } catch { return false; }
  }), 'Successful Wallet tests on main at the same source revision are required');
  return true;
}

export function validateArchiveListing(names, expectedFilenames) {
  check(Array.isArray(names), 'Missing ZIP listing');
  for (const name of names) check(typeof name === 'string' && name && !/[\\/\0:\r\n]/.test(name) && name !== '.' && name !== '..', 'ZIP entries must be plain filenames');
  assert.deepEqual(sorted(names), sorted([...expectedFilenames, 'manifest.json', 'SHA256SUMS']), 'ZIP file allowlist mismatch or duplicate entries');
  return true;
}

export function validateManifest(manifest, { version, platform, arch, sha, expectedFilenames }) {
  assert.equal(manifest.schemaVersion, 1, 'Unknown manifest schema');
  assert.equal(manifest.productName, 'ConnectWallet', 'Wrong manifest product');
  assert.equal(manifest.version, version, 'Wrong manifest version');
  assert.equal(manifest.platform, platform, 'Wrong manifest platform');
  assert.equal(manifest.arch, arch, 'Wrong manifest architecture');
  assert.equal(manifest.sourceRevision, sha, 'Wrong manifest source revision');
  assert.equal(manifest.sourceDirty, false, 'Build source must remain clean');
  assert.equal(manifest.signing, 'not verified', 'Unexpected manifest signing status');
  assert.equal(manifest.notarization, 'not verified', 'Unexpected manifest notarization status');
  check(Array.isArray(manifest.artifacts), 'Missing manifest artifacts');
  assert.deepEqual(sorted(manifest.artifacts.map(file => file.filename)), sorted(expectedFilenames), 'Manifest installer set mismatch');
  for (const file of manifest.artifacts) {
    check(Number.isSafeInteger(file.size) && file.size > 0, 'Invalid manifest installer size');
    check(typeof file.sha256 === 'string' && digestPattern.test(file.sha256), 'Invalid manifest SHA-256');
  }
  return true;
}

export function validateAssets(assets, files) {
  check(Array.isArray(assets) && Array.isArray(files), 'Missing release assets');
  assert.deepEqual(sorted(assets.map(asset => asset.name)), sorted(files.map(file => file.filename)), 'Release asset set mismatch');
  for (const file of files) {
    check(Number.isSafeInteger(file.size) && file.size > 0 && digestPattern.test(file.sha256), 'Invalid expected release asset');
    const asset = assets.find(item => item.name === file.filename);
    assert.equal(asset.state, 'uploaded', `Asset ${file.filename} is not uploaded`);
    assert.equal(asset.size, file.size, `Asset ${file.filename} size mismatch`);
    assert.equal(asset.digest, `sha256:${file.sha256}`, `Asset ${file.filename} digest mismatch`);
  }
  return true;
}

export async function ensureDraftAsset(api, release, file, existing) {
  let asset = existing;
  if (asset?.state === 'starter') {
    // GitHub can leave an empty starter after an interrupted upload. Remove
    // only that incomplete asset, after rechecking that the release is a draft.
    check(Number.isSafeInteger(asset.id) && asset.id > 0 && asset.size === 0 && asset.name === file.filename, 'Invalid incomplete release asset');
    const current = await api.request('GET', `/releases/${release.id}`);
    assert.equal(current.draft, true, 'Refusing to modify a published release');
    assert.equal(current.tag_name, release.tag_name, 'Draft tag changed');
    assert.equal(current.target_commitish, release.target_commitish, 'Draft source revision changed');
    await api.request('DELETE', `/releases/assets/${asset.id}`);
    asset = undefined;
  }
  if (!asset) {
    console.log(`Uploading ${file.filename} (${file.size} bytes)`);
    asset = await api.upload(release.id, file);
  }
  validateAssets([asset], [file]);
  return asset;
}

export async function verifyTagTarget(api, tag, sha, { createIfMissing = false } = {}) {
  check(tag.startsWith('v'), 'Invalid release tag');
  validateVersion(tag.slice(1));
  check(shaPattern.test(sha), 'Invalid tag source revision');
  const endpoint = `/git/ref/tags/${encodeURIComponent(tag)}`;
  let reference;
  try { reference = await api.request('GET', endpoint); }
  catch (error) {
    if (error.status !== 404) throw error;
    if (!createIfMissing) return null;
    try { await api.request('POST', '/git/refs', { ref: `refs/tags/${tag}`, sha }); }
    catch (creationError) {
      // Another publisher may have created the ref. Never force-update a tag.
      if (creationError.status !== 422) throw creationError;
    }
    reference = await api.request('GET', endpoint);
  }
  let object = reference.object;
  const visited = new Set();
  while (object?.type === 'tag') {
    check(shaPattern.test(object.sha) && !visited.has(object.sha) && visited.size < 8, 'Invalid or cyclic annotated tag');
    visited.add(object.sha);
    object = (await api.request('GET', `/git/tags/${object.sha}`)).object;
  }
  assert.equal(object?.type, 'commit', 'Release tag must resolve to a commit');
  assert.equal(object.sha, sha, 'Release tag points at the wrong source revision');
  return object.sha;
}

export function parseArguments(args) {
  check(args.length === 1, 'Exactly one --run-id=<installer-run-id> argument is required');
  const match = /^--run-id=([1-9]\d*)$/.exec(args[0]);
  check(match && Number.isSafeInteger(Number(match[1])), 'Invalid installer run id');
  return { runId: match[1] };
}

export class GitHubApi {
  constructor(token) {
    check(typeof token === 'string' && token.length > 0, 'GITHUB_TOKEN is required');
    this.headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    this.base = `https://api.github.com/repos/${repository}`;
  }

  async responseJson(response) {
    if (!response.ok) {
      const error = new Error(`GitHub request failed with HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  async request(method, endpoint, body) {
    const response = await fetch(`${this.base}${endpoint}`, {
      method, headers: { ...this.headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', signal: AbortSignal.timeout(120000),
    });
    return this.responseJson(response);
  }

  async download(artifactId, destination, expectedDigest) {
    check(/^sha256:[a-f0-9]{64}$/.test(expectedDigest), 'A GitHub artifact SHA-256 digest is required');
    let url = new URL(`${this.base}/actions/artifacts/${artifactId}/zip`);
    let response;
    const signal = AbortSignal.timeout(15 * 60 * 1000);
    for (let redirects = 0; redirects <= 5; redirects++) {
      // Signed artifact URLs may point at cloud storage. Never forward the
      // GitHub token outside the API origin or follow a plaintext redirect.
      check(url.protocol === 'https:' && !url.username && !url.password, 'Invalid artifact redirect URL');
      response = await fetch(url, { headers: url.origin === 'https://api.github.com' ? this.headers : {}, redirect: 'manual', signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      check(location && redirects < 5, 'Too many or invalid artifact redirects');
      await response.body?.cancel();
      url = new URL(location, url);
    }
    check(response.ok && response.body, `Artifact download failed with HTTP ${response.status}`);
    const hash = createHash('sha256');
    const meter = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    assert.equal(`sha256:${hash.digest('hex')}`, expectedDigest, 'Downloaded archive digest mismatch');
  }

  async upload(releaseId, file) {
    const response = await fetch(`https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(file.filename)}`, {
      method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) },
      body: createReadStream(file.localPath), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    return this.responseJson(response);
  }
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function regularFile(file) {
  const info = await lstat(file);
  check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0, `Expected a nonempty regular file: ${file}`);
  return info;
}

async function listReleases(api) {
  const releases = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await api.request('GET', `/releases?per_page=100&page=${page}`);
    check(Array.isArray(batch), 'Invalid release list');
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  throw new Error('Release list exceeded its safety bound');
}

async function checkBuild(api, runId, context) {
  const [run, jobs, tests, main] = await Promise.all([
    api.request('GET', `/actions/runs/${runId}`),
    api.request('GET', `/actions/runs/${runId}/jobs?filter=latest&per_page=100`),
    api.request('GET', `/actions/workflows/test.yml/runs?head_sha=${context.sha}&event=push&status=completed&per_page=100`),
    api.request('GET', '/git/ref/heads/main'),
  ]);
  validateRun(run, { ...context, runId });
  assert.equal(jobs.total_count, 4, 'Exactly four installer jobs are required');
  validateJobs(jobs.jobs);
  validateTestRuns(tests.workflow_runs, context);
  assert.equal(main.object?.type, 'commit');
  assert.equal(main.object.sha, context.sha, 'main changed; publish a build of the current main revision');
  return run;
}

async function stageArtifacts(api, runId, context, version, directory) {
  const response = await api.request('GET', `/actions/runs/${runId}/artifacts?per_page=100`);
  assert.equal(response.total_count, 4, 'Exactly four installer archives are required');
  const targets = releaseTargets(version);
  assert.deepEqual(sorted(response.artifacts.map(artifact => artifact.name)), sorted(targets.map(target => `ConnectWallet-${target.key}-${context.sha}`)), 'Installer archive set mismatch');
  const files = [];
  for (const target of targets) {
    const artifact = response.artifacts.find(item => item.name === `ConnectWallet-${target.key}-${context.sha}`);
    check(Number.isSafeInteger(artifact.id) && artifact.id > 0 && artifact.expired === false, 'Invalid or expired installer archive');
    assert.equal(String(artifact.workflow_run?.id), runId, 'Wrong artifact workflow run');
    assert.equal(artifact.workflow_run?.repository_id, context.repositoryId, 'Wrong artifact repository');
    assert.equal(artifact.workflow_run?.head_repository_id, context.repositoryId, 'Wrong artifact source repository');
    assert.equal(artifact.workflow_run?.head_branch, 'main', 'Wrong artifact source branch');
    assert.equal(artifact.workflow_run?.head_sha, context.sha, 'Wrong artifact source revision');
    const archive = join(directory, `${target.key}.zip`);
    console.log(`Downloading and verifying ${target.key}`);
    await api.download(artifact.id, archive, artifact.digest);
    const { stdout } = await execFileAsync('unzip', ['-Z1', archive], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
    validateArchiveListing(stdout.trimEnd().split(/\r?\n/), target.filenames);
    const extracted = join(directory, target.key);
    await mkdir(extracted);
    // Every permitted member is a unique basename. No archive-supplied path or
    // directory is passed through, and links are rejected before any reads.
    const names = [...target.filenames, 'manifest.json', 'SHA256SUMS'];
    await execFileAsync('unzip', ['-q', archive, ...names, '-d', extracted], { timeout: 180000, maxBuffer: 65536 });
    for (const name of names) await regularFile(join(extracted, name));
    const manifestPath = join(extracted, 'manifest.json');
    check((await lstat(manifestPath)).size <= 1024 * 1024, 'Manifest exceeds its size bound');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    validateManifest(manifest, { ...target, version, sha: context.sha, expectedFilenames: target.filenames });
    const sumsPath = join(extracted, 'SHA256SUMS');
    check((await lstat(sumsPath)).size <= 65536, 'Checksum file exceeds its size bound');
    const sums = (await readFile(sumsPath, 'utf8')).trimEnd().split(/\r?\n/);
    assert.deepEqual(sorted(sums), sorted(manifest.artifacts.map(file => `${file.sha256}  ${file.filename}`)), 'Artifact checksum list mismatch');
    for (const file of manifest.artifacts) {
      const localPath = join(extracted, file.filename);
      assert.equal((await regularFile(localPath)).size, file.size, 'Installer size mismatch');
      assert.equal(await hashFile(localPath), file.sha256, 'Installer SHA-256 mismatch');
      files.push({ filename: file.filename, size: file.size, sha256: file.sha256, localPath });
    }
    files.push({ filename: `manifest-${target.key}.json`, size: (await lstat(manifestPath)).size, sha256: await hashFile(manifestPath), localPath: manifestPath });
  }
  const checksumPath = join(directory, 'SHA256SUMS');
  await writeFile(checksumPath, `${sorted(files.map(file => `${file.sha256}  ${file.filename}`)).join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  files.push({ filename: 'SHA256SUMS', size: (await lstat(checksumPath)).size, sha256: await hashFile(checksumPath), localPath: checksumPath });
  assert.deepEqual(sorted(files.map(file => file.filename)), sorted(buildAssetPlan(version)), 'Final release asset plan mismatch');
  return files;
}

function releaseNotes(version, runId, sha) {
  const source = `https://github.com/${repository}/blob/v${version}`;
  return `# ConnectWallet ${version}\n\nDesktop wallet for ConnectCoin mainnet with local encrypted keys, BIP39 recovery, CONN payments, QR codes, transaction history and optional Automatic Claims. Claims are disabled by default. The native claims helper and Python runtime are bundled.\n\n## Downloads\n\n- Windows x64: assisted EXE installer or MSI. Use one format at a time; back up your wallet and uninstall the previous format before switching.\n- macOS Intel x64 and Apple Silicon arm64: DMG or ZIP.\n- Linux x64: DEB, RPM, AppImage or tar.gz, built on Ubuntu 22.04. AppImage may require FUSE 2.\n\nInstallers use English and do not start the wallet or enable claims automatically. Windows downloads are unsigned. macOS downloads are ad-hoc signed, not Developer-ID signed or notarized by Apple. Operating-system security warnings may appear. Do not run the wallet as root or disable its sandbox.\n\nVerify downloads against SHA256SUMS; four platform manifests are included. Hashes verify integrity, not publisher identity. Automated checks cover wallet logic, packaged helper startup, architecture, resources and installer metadata; they do not establish clean-machine installation/uninstallation or GUI compatibility on every OS.\n\nBack up your recovery phrase securely. The wallet relies on a trusted server over an unencrypted RPC connection for chain state and does not independently validate blockchain consensus.\n\nSee the [installer guide](${source}/docs/installers.md) and [README](${source}/README.md).\n\nBuilt and checked by [Wallet installers run ${runId}](https://github.com/${repository}/actions/runs/${runId}) from commit \`${sha}\`.\n`;
}

async function publish(runId) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run this publisher only through its manual GitHub workflow');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'Publication must be manually dispatched');
  assert.equal(process.env.GITHUB_REPOSITORY, repository, 'Wrong publishing repository');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Publication must run on main');
  const sha = process.env.GITHUB_SHA;
  check(shaPattern.test(sha), 'Invalid publishing source revision');
  const checkout = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 });
  assert.equal(checkout.stdout.trim(), sha, 'Publishing checkout does not match GITHUB_SHA');
  const version = validateVersion(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
  const tag = `v${version}`;
  const api = new GitHubApi(process.env.GITHUB_TOKEN);
  const repo = await api.request('GET', '');
  assert.equal(repo.full_name, repository, 'Wrong GitHub repository');
  check(Number.isSafeInteger(repo.id) && repo.id > 0, 'Invalid repository id');
  const context = { sha, repository, repositoryId: repo.id };
  await checkBuild(api, runId, context);
  await verifyTagTarget(api, tag, sha);
  let release = (await listReleases(api)).find(item => item.tag_name === tag);
  if (release) {
    assert.equal(release.draft, true, 'Refusing to overwrite an already published release');
    assert.equal(release.target_commitish, sha, 'Existing draft targets a different source revision');
  }
  check(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP), 'RUNNER_TEMP must be an absolute path');
  const directory = await realpath(await mkdtemp(join(process.env.RUNNER_TEMP, 'connectwallet-release-')));
  const files = await stageArtifacts(api, runId, context, version, directory);
  const body = releaseNotes(version, runId, sha);
  if (!release) release = await api.request('POST', '/releases', { tag_name: tag, target_commitish: sha, name: `ConnectWallet ${tag}`, body, draft: true, prerelease: false });
  assert.equal(release.draft, true, 'Release must remain a draft during upload');
  assert.equal(release.tag_name, tag, 'Wrong release tag');
  assert.equal(release.target_commitish, sha, 'Wrong draft source revision');
  const existing = await api.request('GET', `/releases/${release.id}/assets?per_page=100`);
  check(existing.every(asset => files.some(file => file.filename === asset.name)), 'Existing draft has unexpected assets');
  for (const file of files) {
    assert.equal((await regularFile(file.localPath)).size, file.size, 'Local asset size changed');
    assert.equal(await hashFile(file.localPath), file.sha256, 'Local asset digest changed');
    await ensureDraftAsset(api, release, file, existing.find(item => item.name === file.filename));
  }
  validateAssets(await api.request('GET', `/releases/${release.id}/assets?per_page=100`), files);
  // Repeat source/build checks after transfers. Pin/verify the tag before the
  // irreversible publication step; a wrong existing tag is never overwritten.
  await checkBuild(api, runId, context);
  release = await api.request('GET', `/releases/${release.id}`);
  assert.equal(release.draft, true, 'Release was published by another actor');
  assert.equal(release.tag_name, tag, 'Release tag changed');
  assert.equal(release.target_commitish, sha, 'Release source revision changed');
  await verifyTagTarget(api, tag, sha, { createIfMissing: true });
  release = await api.request('PATCH', `/releases/${release.id}`, { draft: false, prerelease: false, make_latest: 'true', name: `ConnectWallet ${tag}`, body });
  assert.equal(release.draft, false, 'Release was not published');
  assert.equal(release.tag_name, tag, 'Published tag mismatch');
  assert.equal(await verifyTagTarget(api, tag, sha), sha, 'Published tag is missing');
  validateAssets(await api.request('GET', `/releases/${release.id}/assets?per_page=100`), files);
  const url = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
  console.log(`Published ${url} with ${files.length} verified assets from ${sha}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `Published [ConnectWallet ${tag}](${url}) with ${files.length} verified assets.\n\nSource: \`${sha}\`; installer run: \`${runId}\`.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await publish(parseArguments(process.argv.slice(2)).runId); }
  catch (error) { console.error(`Release publication stopped: ${error.message}`); process.exitCode = 1; }
}
