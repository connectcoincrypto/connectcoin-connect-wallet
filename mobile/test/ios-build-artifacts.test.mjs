import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const mobile = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/ios-build-tools.sh', import.meta.url));
const windowsBash = join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe');
// Exercise Apple's bundled shell even if Homebrew adds a newer Bash to PATH.
const bash = process.platform === 'darwin' ? '/bin/bash'
  : process.platform === 'win32' && existsSync(windowsBash) ? windowsBash : 'bash';

test('iOS build invocations preserve old results and isolate modes, checksums and failures', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-ios-build-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'mobile');
  const script = join(root, 'scripts/build-ios.sh');
  await mkdir(dirname(script), { recursive: true });
  await copyFile(resolve(mobile, 'scripts/build-ios.sh'), script);
  for (const file of ['LICENSE', 'mobile/native/vendor/core/COPYING', 'mobile/native/vendor/MBEDTLS-LICENSE', 'mobile/native/vendor/NOTICE']) {
    const path = join(directory, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'Public build-test license fixture.\n');
  }
  const artifacts = join(root, '.tools/ios-artifacts');
  let invocation = 0;
  const simulator = '11111111-2222-3333-4444-555555555555';
  const invoke = async (mode, exit = 0, overrides = {}, expectedCleanup = mode !== 'device') => {
    const log = join(directory, `simulator-calls-${++invocation}.log`);
    const result = spawnSync(bash, [fixture, script, mode], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true,
      env: { ...process.env, IOS_BUILD_TEST_EXIT: String(exit), IOS_BUILD_TEST_LOG: log,
        IOS_BUILD_TEST_DROP_SIMULATOR: '1', IOS_BUILD_TEST_BOOT_EXIT: '0', IOS_BUILD_TEST_CLEANUP_EXIT: '0',
        IOS_BUILD_TEST_SIMULATOR: simulator, ...overrides },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, exit, result.stdout + result.stderr);
    const calls = existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n') : [];
    assert.deepEqual(calls.filter(call => /^(shutdown|delete) /.test(call)),
      expectedCleanup ? [`shutdown ${simulator}`, `delete ${simulator}`] : [],
      'Clean up only the created Simulator, exactly once, even after failure or lost local scope.');
    return result;
  };

  await invoke('simulator');
  const [first] = await readdir(artifacts);
  const oldResult = join(artifacts, first, 'WalletUISmoke.xcresult/fixture.txt');
  await writeFile(oldResult, 'Preserved first invocation.\n');
  await invoke('simulator');
  assert.equal((await readdir(artifacts)).length, 2, 'A rerun must not reuse its existing result bundle.');
  assert.equal(await readFile(oldResult, 'utf8'), 'Preserved first invocation.\n');

  await invoke('device');
  await invoke('all');
  const runs = await readdir(artifacts);
  assert.equal(runs.length, 4);
  for (const run of runs) {
    const contents = await readdir(join(artifacts, run));
    const expected = run.startsWith('all-')
      ? ['ConnectWallet-simulator.app.zip', 'ConnectWallet-unsigned-device.app.zip']
      : [run.startsWith('device-') ? 'ConnectWallet-unsigned-device.app.zip' : 'ConnectWallet-simulator.app.zip'];
    assert.deepEqual(contents.filter(name => name.endsWith('.app.zip')), expected);
    assert.equal(await readFile(join(artifacts, run, 'SHA256SUMS'), 'utf8'), expected.map(name => `mock-sha256  ${name}\n`).join(''));
  }

  const failed = await invoke('simulator', 65);
  assert.match(failed.stderr, /Simulator UI test failed with exit status 65/);
  const [failedRun] = (await readdir(artifacts)).filter(name => !runs.includes(name));
  assert.ok(failedRun);
  assert.ok(existsSync(join(artifacts, failedRun, 'WalletUISmoke.xcresult/fixture.txt')));
  assert.ok(existsSync(join(artifacts, failedRun, 'ui-diagnostics/test-summary.json')));
  assert.ok(!existsSync(join(artifacts, failedRun, 'SHA256SUMS')), 'A failed invocation must not inherit a successful checksum manifest.');
  assert.equal(await readFile(oldResult, 'utf8'), 'Preserved first invocation.\n');

  await invoke('simulator', 65, { IOS_BUILD_TEST_CLEANUP_EXIT: '74' });
  await invoke('simulator', 0, { IOS_BUILD_TEST_CLEANUP_EXIT: '74' });
  await invoke('simulator', 23, { IOS_BUILD_TEST_EXIT: '0', IOS_BUILD_TEST_BOOT_EXIT: '23' });
  await invoke('simulator', 1, { IOS_BUILD_TEST_EXIT: '0', IOS_BUILD_TEST_SIMULATOR: 'invalid-simulator' }, false);
});

test('iOS workflow uploads per-invocation review outputs', async () => {
  const workflow = await readFile(resolve(mobile, '../.github/workflows/ios-wallet.yml'), 'utf8');
  assert.ok(workflow.includes('mobile/.tools/ios-artifacts/\n'));
  for (const relative of ['ui-screenshots/', 'ui-diagnostics/*.json', 'ui-diagnostics/*.png', 'ui-diagnostics/*.log', 'ui-diagnostics/crashes/']) {
    assert.ok(workflow.includes(`mobile/.tools/ios-artifacts/*/${relative}`), relative);
  }
});

test('Apple native workflow includes hidden build directories only for scoped test logs', async () => {
  const workflow = await readFile(resolve(mobile, '../.github/workflows/mobile-wallet.yml'), 'utf8');
  const upload = workflow.slice(workflow.indexOf('      - name: Upload native test logs only'));
  assert.match(upload, /include-hidden-files: true/);
  const paths = upload.match(/          path: \|\n((?:            [^\n]+\n)+)/);
  assert.ok(paths, 'Native logs upload must keep an explicit file allowlist.');
  assert.deepEqual(paths[1].trim().split('\n').map(line => line.trim()), [
    'mobile/.tools/native-host/Testing/Temporary/LastTest.log',
    'mobile/.tools/native-*/CMakeFiles/CMakeConfigureLog.yaml',
  ]);
});
