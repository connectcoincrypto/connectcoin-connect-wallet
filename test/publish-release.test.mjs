import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAssetPlan,
  ensureDraftAsset,
  GitHubApi,
  parseArguments,
  releaseTargets,
  releaseNotes,
  validateArchiveListing,
  validateAssets,
  validateJobs,
  validateManifest,
  validateRun,
  validateTestRuns,
  verifyTagTarget,
} from '../scripts/publish-release.mjs';

const version = '1.2.3';
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const repositoryId = 1234;
const repository = 'connectcoincrypto/connectcoin-connect-wallet';
const provenance = { sha, repositoryId, repository };
const tag = `v${version}`;
const expectedTargets = [
  { platform: 'win32', arch: 'x64', key: 'win32-x64', filenames: [
    `ConnectWallet-${version}-Windows-x64.exe`, `ConnectWallet-${version}-Windows-x64.msi`,
  ] },
  { platform: 'linux', arch: 'x64', key: 'linux-x64', filenames: [
    `ConnectWallet-${version}-Linux-x64.deb`, `ConnectWallet-${version}-Linux-x64.rpm`,
    `ConnectWallet-${version}-Linux-x64.AppImage`, `ConnectWallet-${version}-Linux-x64.tar.gz`,
  ] },
  { platform: 'darwin', arch: 'x64', key: 'darwin-x64', filenames: [
    `ConnectWallet-${version}-macOS-x64.dmg`, `ConnectWallet-${version}-macOS-x64.zip`,
  ] },
  { platform: 'darwin', arch: 'arm64', key: 'darwin-arm64', filenames: [
    `ConnectWallet-${version}-macOS-arm64.dmg`, `ConnectWallet-${version}-macOS-arm64.zip`,
  ] },
];
const expectedAssetNames = [
  ...expectedTargets.flatMap(target => target.filenames),
  ...expectedTargets.map(target => `manifest-${target.key}.json`),
  'SHA256SUMS',
];

test('1.1.0 release notes describe fee deduction and preserve distribution disclosures', () => {
  const notes = releaseNotes('1.1.0', '5678', sha);
  for (const text of ['# ConnectWallet 1.1.0', '## New in 1.1.0', 'Use all balance', 'Deduct fees from payment',
    'uncertain', 'Windows downloads are unsigned', 'not Developer-ID signed or notarized', 'SHA256SUMS',
    '/blob/v1.1.0/docs/installers.md', '/actions/runs/5678', sha]) assert.ok(notes.includes(text), text);
  assert.equal((notes.match(/## Downloads/g) ?? []).length, 1);
  assert.ok(!releaseNotes('1.0.0', '5678', sha).includes('## New in 1.1.0'));
  assert.ok(!releaseNotes('1.2.0', '5678', sha).includes('## New in 1.1.0'));
});

test('adding 1.1.1 release notes preserves the previously published 1.1.0 text exactly', () => {
  const notes = releaseNotes('1.1.0', '5678', sha);
  assert.equal(createHash('sha256').update(notes).digest('hex'),
    '4a81fe0f613227aa9f42e8ad5989ac175512e17d651ae77ff41ee063630d22fd');
});

test('1.1.2 release notes describe bounded start admission without overstating performance', () => {
  const notes = releaseNotes('1.1.2', '5678', sha);
  for (const text of ['# ConnectWallet 1.1.2', '## New in 1.1.2', 'start acknowledgment',
    'rate and concurrency limits', 'bounded pending-start queue', 'Recovery probes',
    'connection actually starts', 'mobile alpha is not included', 'English', 'unsigned',
    'not Developer-ID signed or notarized', '/blob/v1.1.2/docs/installers.md', sha]) {
    assert.ok(notes.includes(text), text);
  }
  assert.ok(notes.indexOf('## New in 1.1.2') < notes.indexOf('## Downloads'));
  assert.equal((notes.match(/## New in 1\.1\.2/g) ?? []).length, 1);
  assert.doesNotMatch(notes, /## New in 1\.1\.1|\d+(?:\.\d+)?%|\d+(?:\.\d+)?x faster/i);
  for (const version of ['1.1.0', '1.1.1', '1.2.0']) {
    assert.ok(!releaseNotes(version, '5678', sha).includes('## New in 1.1.2'));
  }
});

test('1.1.1 release notes describe the startup, locking and synchronization changes with their limits', () => {
  const notes = releaseNotes('1.1.1', '5678', sha);
  for (const text of [
    '# ConnectWallet 1.1.1', '## New in 1.1.1', 'Desktop inactivity auto-lock is off by default',
    'Existing saved timeouts are preserved', 'Lock after inactivity', '**0**',
    'supported operating-system screen-lock events', 'an unattended wallet can remain unlocked',
    'up to four address reads and two address subscriptions', 'subscribed before its baseline is read',
    'shared RPC limits and server cooldowns remain enforced', 'quota-window wait',
    'Incremental balances and transaction history', 'compatible RPC servers', 'published atomically',
    'Expired journals or reorganizations', 'older servers', 'session-only, not an on-disk history cache',
    'common account path is derived once', 'public-only branches', 'Locking or replacing the session discards this cache',
    'signing keys, signing behavior and encrypted wallet format are unchanged',
    'Local startup diagnostics', 'without logging passwords, recovery phrases or private keys',
  ]) assert.ok(notes.includes(text), text);
  assert.ok(notes.indexOf('## New in 1.1.1') < notes.indexOf('## Downloads'));
  assert.equal((notes.match(/## New in 1\.1\.1/g) ?? []).length, 1);
  assert.equal((notes.match(/## Downloads/g) ?? []).length, 1);
  assert.doesNotMatch(notes, /## New in 1\.1\.0|\d+(?:\.\d+)?%|\d+(?:\.\d+)?x faster/i);
});

test('1.1.1 release notes preserve replacement review, upgrade and distribution disclosures', () => {
  const notes = releaseNotes('1.1.1', '5678', sha);
  for (const text of [
    'Allow replacing pending transactions', 'off by default', 'fresh server information',
    'payment review listing the conflicting transaction IDs', 'cancel earlier payments or be rejected by the node',
    'check the transaction before retrying', 'does not retry an uncertain broadcast automatically',
    'does not change ConnectCoin consensus or the P2P protocol', 'Close ConnectWallet before upgrading',
    'same Windows installer family', 'Claims are disabled by default', 'Installers use English',
    'Windows downloads are unsigned', 'not Developer-ID signed or notarized', 'SHA256SUMS',
    'trusted server over an unencrypted RPC connection', 'does not independently validate blockchain consensus',
    '/blob/v1.1.1/docs/installers.md', '/blob/v1.1.1/README.md', '/actions/runs/5678', sha,
  ]) assert.ok(notes.includes(text), text);
  for (const otherVersion of ['1.0.0', '1.1.0', '1.2.0']) {
    assert.ok(!releaseNotes(otherVersion, '5678', sha).includes('## New in 1.1.1'));
  }
});

function run(overrides = {}) {
  return {
    id: 5678,
    path: '.github/workflows/installers.yml',
    event: 'workflow_dispatch',
    head_branch: 'main',
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    repository: { id: repositoryId, full_name: repository },
    head_repository: { id: repositoryId, full_name: repository },
    ...overrides,
  };
}

function testRun(overrides = {}) {
  return run({ path: '.github/workflows/test.yml', event: 'push', ...overrides });
}

function jobs() {
  return expectedTargets.map(({ platform, arch }, index) => ({
    id: index + 1, name: `${platform} / ${arch}`, status: 'completed', conclusion: 'success',
  }));
}

function manifest(target = expectedTargets[0], overrides = {}) {
  return {
    schemaVersion: 1,
    productName: 'ConnectWallet',
    version,
    platform: target.platform,
    os: { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[target.platform],
    arch: target.arch,
    generatedAt: '2026-10-01T12:00:00.000Z',
    sourceRevision: sha,
    sourceDirty: false,
    sourceRevisionBasis: 'Repository HEAD at verification; artifact build provenance not verified.',
    signing: 'not verified',
    notarization: 'not verified',
    validation: 'Expected filenames, nonempty files, container signatures and SHA-256; installation and contained payloads not verified.',
    artifacts: target.filenames.map((filename, index) => ({
      filename,
      format: filename.endsWith('.tar.gz') ? 'tar.gz' : filename.split('.').at(-1),
      size: 1024 + index,
      sha256: String(index + 1).repeat(64),
    })),
    ...overrides,
  };
}

function manifestOptions(target = expectedTargets[0]) {
  return { version, platform: target.platform, arch: target.arch, sha, expectedFilenames: target.filenames };
}

function files() {
  return expectedAssetNames.map((filename, index) => ({ filename, size: index + 100, sha256: 'c'.repeat(64) }));
}

function assets(localFiles = files()) {
  return localFiles.map(({ filename, size, sha256 }, index) => ({
    id: index + 1, name: filename, size, digest: `sha256:${sha256}`, state: 'uploaded',
  }));
}

function apiError(status) {
  return Object.assign(new Error(`GitHub returned HTTP ${status}`), { status });
}

function mockApi(handler) {
  const calls = [];
  return {
    calls,
    async request(method, endpoint, body) {
      calls.push({ method, endpoint, body });
      return handler({ method, endpoint, body }, calls.length);
    },
  };
}

const tagRef = (targetSha = sha, type = 'commit') => ({ ref: `refs/tags/${tag}`, object: { type, sha: targetSha } });

test('release plan contains exactly ten installers, four target manifests and one checksum file', () => {
  const normalize = targets => targets.map(target => ({ ...target, filenames: [...target.filenames].sort() }))
    .sort((a, b) => a.key.localeCompare(b.key));
  assert.deepEqual(normalize(releaseTargets(version)), normalize(expectedTargets));
  const plan = buildAssetPlan(version);
  assert.equal(plan.length, 15);
  assert.deepEqual([...plan].sort(), [...expectedAssetNames].sort());
  assert.equal(new Set(plan).size, 15);
});

test('release CLI accepts only one explicit numeric run ID', () => {
  assert.deepEqual(parseArguments(['--run-id=5678']), { runId: '5678' });
  for (const args of [
    [], ['5678'], ['--run-id', '5678'], ['--run-id='], ['--run-id=0'], ['--run-id=-1'], ['--run-id=1.2'],
    ['--run-id=9007199254740992'],
    ['--run-id=1e3'], ['--run-id=123\n'], ['--run-id=5678', '--run-id=9012'],
    ['--run-id=5678', '--publish'], ['--run-id=5678', '--sha=untrusted'],
  ]) assert.throws(() => parseArguments(args), `Must reject ${JSON.stringify(args)}`);
});

test('installer provenance requires the expected successful main-branch workflow and repository', () => {
  assert.equal(validateRun(run(), provenance), true);
  for (const overrides of [
    { path: '.github/workflows/test.yml' }, { path: 'installers.yml' },
    { event: 'pull_request' }, { event: 'push' }, { head_branch: 'release' },
    { head_sha: otherSha }, { head_sha: null }, { status: 'in_progress' },
    { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: null },
    { repository: null }, { repository: { id: repositoryId + 1, full_name: repository } },
    { repository: { id: repositoryId, full_name: 'attacker/connectcoin-connect-wallet' } },
    { head_repository: null }, { head_repository: { id: repositoryId + 1, full_name: repository } },
    { head_repository: { id: repositoryId, full_name: 'attacker/connectcoin-connect-wallet' } },
  ]) assert.throws(() => validateRun(run(overrides), provenance), `Must reject ${JSON.stringify(overrides)}`);
  for (const invalid of [null, undefined, {}, []]) assert.throws(() => validateRun(invalid, provenance));
});

test('matrix validation requires each completed successful installer job exactly once', () => {
  assert.equal(validateJobs(jobs()), true);
  assert.equal(validateJobs(jobs().reverse()), true);
  for (const overrides of [
    { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' },
    { conclusion: null }, { status: 'queued' }, { name: 'win32 / arm64' },
  ]) {
    const invalid = jobs();
    invalid[0] = { ...invalid[0], ...overrides };
    assert.throws(() => validateJobs(invalid), `Must reject ${JSON.stringify(overrides)}`);
  }
  for (const invalid of [null, [], jobs().slice(1), [...jobs(), jobs()[0]], [...jobs(), { name: 'extra', status: 'completed', conclusion: 'success' }]]) {
    assert.throws(() => validateJobs(invalid));
  }
});

test('test gate requires at least one successful push run from test.yml at the exact source SHA', () => {
  assert.equal(validateTestRuns([testRun()], provenance), true);
  assert.equal(validateTestRuns([testRun({ conclusion: 'failure' }), testRun()], provenance), true);
  for (const overrides of [
    { path: '.github/workflows/installers.yml' }, { event: 'pull_request' }, { event: 'workflow_dispatch' },
    { head_branch: 'release' }, { head_sha: otherSha }, { status: 'in_progress' },
    { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' },
    { repository: { id: repositoryId + 1, full_name: repository } },
    { repository: { id: repositoryId, full_name: 'attacker/wallet' } },
    { head_repository: { id: repositoryId + 1, full_name: repository } },
    { head_repository: null },
  ]) assert.throws(() => validateTestRuns([testRun(overrides)], provenance), `Must reject ${JSON.stringify(overrides)}`);
  for (const invalid of [null, [], [null], [{}]]) assert.throws(() => validateTestRuns(invalid, provenance));
});

test('archive contents must match the flat payload and report allowlist exactly', () => {
  const expected = expectedTargets[0].filenames;
  const valid = [...expected, 'manifest.json', 'SHA256SUMS'];
  assert.equal(validateArchiveListing(valid, expected), true);
  assert.equal(validateArchiveListing([...valid].reverse(), expected), true);
  for (const invalid of [[], valid.slice(1), [...valid, valid[0]], [...valid, 'README.md'], [...valid, 'old.exe']]) {
    assert.throws(() => validateArchiveListing(invalid, expected));
  }
  for (const escaped of [
    '../manifest.json', '..\\manifest.json', '/manifest.json', 'C:\\manifest.json',
    './manifest.json', 'nested/manifest.json', 'nested\\manifest.json', 'manifest.json:stream',
    'manifest.json\0', '.', '..', '', null,
  ]) assert.throws(() => validateArchiveListing([...expected, 'SHA256SUMS', escaped], expected), `Must reject ${JSON.stringify(escaped)}`);
});

test('every target manifest must identify the version, platform, architecture and clean source', () => {
  for (const target of expectedTargets) assert.equal(validateManifest(manifest(target), manifestOptions(target)), true);
  for (const overrides of [
    { schemaVersion: 2 }, { productName: 'OtherWallet' }, { version: '0.1.0' },
    { platform: 'linux' }, { arch: 'arm64' }, { sourceRevision: otherSha }, { sourceRevision: null },
    { sourceDirty: true }, { sourceDirty: null }, { sourceDirty: 'false' },
    { signing: 'verified' }, { signing: null }, { notarization: 'verified' }, { notarization: null },
  ]) assert.throws(() => validateManifest(manifest(expectedTargets[0], overrides), manifestOptions()), `Must reject ${JSON.stringify(overrides)}`);
  for (const invalid of [null, {}, []]) assert.throws(() => validateManifest(invalid, manifestOptions()));
});

test('manifest payload records reject missing, extra, duplicate and malformed hashes or sizes', () => {
  const valid = manifest();
  for (const artifacts of [
    [], valid.artifacts.slice(1), [...valid.artifacts, valid.artifacts[0]],
    [...valid.artifacts, { ...valid.artifacts[0], filename: 'unexpected.exe' }],
    ...[
      { filename: '../outside.exe' }, { size: 0 }, { size: -1 }, { size: 1.5 },
      { size: '1024' }, { size: Number.MAX_SAFE_INTEGER + 1 },
      { sha256: 'bad' }, { sha256: 'g'.repeat(64) }, { sha256: null },
    ].map(overrides => [{ ...valid.artifacts[0], ...overrides }, valid.artifacts[1]]),
  ]) assert.throws(() => validateManifest({ ...valid, artifacts }, manifestOptions()));
});

test('release asset verification compares all fifteen names, sizes, upload states and SHA-256 digests', () => {
  assert.equal(validateAssets(assets(), files()), true);
  assert.equal(validateAssets(assets().reverse(), files()), true);
  for (const invalid of [[], assets().slice(1), [...assets(), assets()[0]], [...assets(), { ...assets()[0], name: 'unexpected.exe' }]]) {
    assert.throws(() => validateAssets(invalid, files()));
  }
  for (const overrides of [
    { name: 'unexpected.exe' }, { size: 0 }, { size: 101 }, { size: '100' },
    { state: 'starter' }, { digest: `sha256:${'d'.repeat(64)}` },
    { digest: 'c'.repeat(64) }, { digest: null },
  ]) {
    const invalid = assets();
    invalid[0] = { ...invalid[0], ...overrides };
    assert.throws(() => validateAssets(invalid, files()), `Must reject ${JSON.stringify(overrides)}`);
  }
});

test('an empty starter asset is replaced only after rechecking the draft and handling HTTP 204', async t => {
  const release = { id: 77, tag_name: tag, target_commitish: sha, draft: true };
  const file = files()[0];
  const starter = { id: 88, name: file.filename, size: 0, state: 'starter' };
  const uploaded = assets([file])[0];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(options.method);
    assert.equal(options.redirect, 'error');
    if (options.method === 'GET') {
      assert.equal(String(url), `https://api.github.com/repos/${repository}/releases/77`);
      return Response.json(release);
    }
    assert.equal(options.method, 'DELETE');
    assert.equal(String(url), `https://api.github.com/repos/${repository}/releases/assets/88`);
    return new Response(null, { status: 204 });
  });
  const api = new GitHubApi('mock-token');
  t.mock.method(api, 'upload', async (releaseId, selectedFile) => {
    calls.push('UPLOAD');
    assert.equal(releaseId, release.id);
    assert.equal(selectedFile, file);
    return uploaded;
  });
  assert.equal(await ensureDraftAsset(api, release, file, starter), uploaded);
  assert.deepEqual(calls, ['GET', 'DELETE', 'UPLOAD']);
});

test('starter recovery refuses deletion when the release was published or changed', async () => {
  const release = { id: 77, tag_name: tag, target_commitish: sha, draft: true };
  const file = files()[0];
  const starter = { id: 88, name: file.filename, size: 0, state: 'starter' };
  for (const overrides of [{ draft: false }, { tag_name: 'v9.9.9' }, { target_commitish: otherSha }]) {
    const api = mockApi(({ method, endpoint }) => {
      assert.equal(method, 'GET', 'Changed releases must not have their assets deleted');
      assert.equal(endpoint, '/releases/77');
      return { ...release, ...overrides };
    });
    api.upload = async () => assert.fail('Changed releases must not receive an upload');
    await assert.rejects(ensureDraftAsset(api, release, file, starter));
    assert.deepEqual(api.calls.map(call => call.method), ['GET']);
  }
});

test('draft recovery preserves nonempty starters and completed assets with mismatched bytes', async () => {
  const release = { id: 77, tag_name: tag, target_commitish: sha, draft: true };
  const file = files()[0];
  const starter = { id: 88, name: file.filename, size: 0, state: 'starter' };
  const uploaded = assets([file])[0];
  const api = {
    request: async () => assert.fail('Existing payloads must not be deleted'),
    upload: async () => assert.fail('Existing payloads must not be overwritten'),
  };
  assert.equal(await ensureDraftAsset(api, release, file, uploaded), uploaded);
  for (const invalid of [
    { ...starter, size: 1 }, { ...starter, id: 0 }, { ...starter, name: 'unrelated.exe' },
    { ...uploaded, digest: `sha256:${'d'.repeat(64)}` }, { ...uploaded, size: file.size + 1 },
  ]) await assert.rejects(ensureDraftAsset(api, release, file, invalid));
});

test('existing lightweight tags must point at the verified source commit without writes', async () => {
  const api = mockApi(({ method, endpoint }) => {
    assert.equal(method, 'GET');
    assert.ok(endpoint.endsWith(`/git/ref/tags/${tag}`));
    return tagRef();
  });
  await verifyTagTarget(api, tag, sha, { createIfMissing: false });
  assert.equal(api.calls.length, 1);
  const mismatched = mockApi(() => tagRef(otherSha));
  await assert.rejects(verifyTagTarget(mismatched, tag, sha, { createIfMissing: false }));
  assert.ok(mismatched.calls.every(call => call.method === 'GET'));
});

test('annotated tags are peeled until their commit and mismatches are rejected', async () => {
  const firstTag = '1'.repeat(40);
  const secondTag = '2'.repeat(40);
  for (const targetSha of [sha, otherSha]) {
    const api = mockApi(({ method, endpoint }) => {
      assert.equal(method, 'GET');
      if (endpoint.endsWith(`/git/ref/tags/${tag}`)) return tagRef(firstTag, 'tag');
      if (endpoint.endsWith(`/git/tags/${firstTag}`)) return { object: { type: 'tag', sha: secondTag } };
      if (endpoint.endsWith(`/git/tags/${secondTag}`)) return { object: { type: 'commit', sha: targetSha } };
      assert.fail(`Unexpected API endpoint: ${endpoint}`);
    });
    if (targetSha === sha) await verifyTagTarget(api, tag, sha, { createIfMissing: false });
    else await assert.rejects(verifyTagTarget(api, tag, sha, { createIfMissing: false }));
    assert.equal(api.calls.length, 3);
  }
});

test('tag verification rejects non-commit targets and terminates annotated tag cycles', async () => {
  for (const type of ['tree', 'blob', null]) {
    await assert.rejects(verifyTagTarget(mockApi(() => tagRef(sha, type)), tag, sha, { createIfMissing: false }));
  }
  const cyclic = mockApi((_, index) => {
    assert.ok(index <= 20, 'Tag peeling must be bounded.');
    return tagRef(otherSha, 'tag');
  });
  await assert.rejects(verifyTagTarget(cyclic, tag, sha, { createIfMissing: false }));
  assert.ok(cyclic.calls.length <= 20);
});

test('a missing tag is read-only when creation is disabled and only 404 means absent', async () => {
  const missing = mockApi(() => { throw apiError(404); });
  await verifyTagTarget(missing, tag, sha, { createIfMissing: false });
  assert.ok(missing.calls.every(call => call.method === 'GET'));
  for (const status of [401, 403, 422, 500]) {
    const api = mockApi(() => { throw apiError(status); });
    await assert.rejects(verifyTagTarget(api, tag, sha, { createIfMissing: true }));
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].method, 'GET');
  }
});

test('prepublication creation sends the verified SHA and checks the resulting tag again', async () => {
  const api = mockApi(({ method, endpoint, body }, index) => {
    if (index === 1) { assert.equal(method, 'GET'); throw apiError(404); }
    if (method === 'POST') {
      assert.ok(endpoint.endsWith('/git/refs'));
      assert.deepEqual(body, { ref: `refs/tags/${tag}`, sha });
      return tagRef();
    }
    assert.equal(method, 'GET');
    return tagRef();
  });
  await verifyTagTarget(api, tag, sha, { createIfMissing: true });
  assert.deepEqual(api.calls.map(call => call.method), ['GET', 'POST', 'GET']);
});

test('tag creation conflicts are reread and only the intended target is accepted', async () => {
  for (const targetSha of [sha, otherSha]) {
    const api = mockApi(({ method, body }, index) => {
      if (index === 1) { assert.equal(method, 'GET'); throw apiError(404); }
      if (method === 'POST') {
        assert.deepEqual(body, { ref: `refs/tags/${tag}`, sha });
        throw apiError(422);
      }
      assert.equal(method, 'GET');
      return tagRef(targetSha);
    });
    if (targetSha === sha) await verifyTagTarget(api, tag, sha, { createIfMissing: true });
    else await assert.rejects(verifyTagTarget(api, tag, sha, { createIfMissing: true }));
    assert.deepEqual(api.calls.map(call => call.method), ['GET', 'POST', 'GET']);
  }
});

test('a tag changed immediately after successful creation fails the final target check', async () => {
  const api = mockApi(({ method }, index) => {
    if (index === 1) throw apiError(404);
    if (method === 'POST') return tagRef();
    return tagRef(otherSha);
  });
  await assert.rejects(verifyTagTarget(api, tag, sha, { createIfMissing: true }));
  assert.deepEqual(api.calls.map(call => call.method), ['GET', 'POST', 'GET']);
});

async function downloadFixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'connectwallet-release-download-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 0xfe, 0xff]);
  return {
    destination: join(directory, 'artifact.zip'),
    payload,
    digest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
  };
}

test('artifact downloads stream the expected bytes and do not forward credentials to storage', async t => {
  const fixture = await downloadFixture(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.redirect, 'manual');
    if (calls.length === 1) {
      assert.equal(String(url), `https://api.github.com/repos/${repository}/actions/artifacts/42/zip`);
      assert.equal(options.headers.Authorization, 'Bearer mock-token');
      return new Response(null, { status: 302, headers: { location: 'https://storage.invalid/archive.zip?signature=example' } });
    }
    assert.equal(calls.length, 2, 'Unexpected additional HTTP request');
    assert.equal(String(url), 'https://storage.invalid/archive.zip?signature=example');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(fixture.payload.subarray(0, 4));
        controller.enqueue(fixture.payload.subarray(4));
        controller.close();
      },
    }));
  });
  await new GitHubApi('mock-token').download(42, fixture.destination, fixture.digest);
  assert.deepEqual(await readFile(fixture.destination), fixture.payload);
  assert.equal(calls.length, 2);
});

test('artifact downloads reject bytes whose digest differs from GitHub metadata', async t => {
  const fixture = await downloadFixture(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(fixture.payload)));
  await assert.rejects(
    new GitHubApi('mock-token').download(42, fixture.destination, `sha256:${'0'.repeat(64)}`),
    /digest mismatch/i,
  );
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('artifact downloads reject plaintext redirects before making the next request', async t => {
  const fixture = await downloadFixture(t);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 302, headers: { location: 'http://storage.invalid/archive.zip' },
  }));
  await assert.rejects(new GitHubApi('mock-token').download(42, fixture.destination, fixture.digest), /redirect URL/i);
  assert.equal(fetchMock.mock.callCount(), 1);
  await assert.rejects(readFile(fixture.destination), { code: 'ENOENT' });
});
