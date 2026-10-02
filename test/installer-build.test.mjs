import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateConfiguration } from 'app-builder-lib/out/util/config/config.js';
import { buildPlan, prepareOutput } from '../scripts/build-installers.mjs';

const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
test('installer configuration satisfies the pinned electron-builder schema', async () => {
  await validateConfiguration(metadata.build, { isEnabled: false });
});
test('Windows installers are English-only, stable, branded and never auto-launch or delete wallet data', () => {
  const { build } = metadata;
  assert.equal(build.appId, 'com.connectcoincrypto.connectwallet');
  assert.deepEqual(build.win.target, ['nsis', 'msi']);
  assert.deepEqual(build.nsis.installerLanguages, ['en_US']);
  assert.equal(build.nsis.language, '1033');
  assert.equal(build.nsis.multiLanguageInstaller, false);
  assert.equal(build.nsis.displayLanguageSelector, false);
  assert.equal(build.nsis.guid, 'd88d5a21-77b9-537e-98d1-01560f964433');
  assert.equal(build.msi.upgradeCode, '67F96C30-665A-4AF6-9A87-B741403A11A5');
  assert.deepEqual(build.msi.additionalLightArgs, ['-cultures:en-us']);
  assert.equal(build.msiProjectCreated, 'scripts/msi-project.mjs');
  for (const kind of ['nsis', 'msi']) {
    assert.equal(build[kind].runAfterFinish, false);
    assert.equal(build[kind].shortcutName, 'ConnectWallet');
  }
  assert.equal(build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(build.win.icon, 'assets/icon.ico');
});
test('Linux and macOS targets preserve platform identity and native helper resources', () => {
  const { build } = metadata;
  assert.deepEqual(build.linux.target, ['AppImage', 'deb', 'rpm', 'tar.gz']);
  assert.deepEqual(build.mac.target, ['dmg', 'zip']);
  // DMG inherits the converted app ICNS, not raw PNG bytes renamed to .icns.
  assert.equal(build.dmg.icon, undefined);
  assert.equal(metadata.desktopName, `${build.appId}.desktop`);
  assert.equal(build.linux.syncDesktopName, true);
  // Builder expands ${arch} differently for DEB, RPM and AppImage. This x64-only
  // matrix uses an explicit filename arch so all four formats have the same stem.
  assert.equal(build.linux.artifactName, 'ConnectWallet-${version}-Linux-x64.${ext}');
  assert.equal(build.linux.desktop.entry.StartupWMClass, build.appId);
  assert.deepEqual(build.extraResources, [{ from: 'helpers/bin/connectwallet-claims', to: 'claims-helper' }]);
  assert.equal(build.publish, null);
});
test('native plans forbid cross-compilation of Python helpers and reject injected/duplicate flags', () => {
  for (const [platform, arch] of [['win32','x64'], ['linux','x64'], ['darwin','x64'], ['darwin','arm64']]) {
    const plan = buildPlan([], { platform, arch });
    assert.equal(plan.platform, platform); assert.equal(plan.arch, arch);
    assert.deepEqual(plan.builderArgs.slice(2, 4), ['--publish', 'never']);
  }
  assert.throws(() => buildPlan(['--platform=darwin'], { platform: 'win32', arch: 'x64' }), /Native builds only/);
  assert.throws(() => buildPlan(['--arch=x64'], { platform: 'darwin', arch: 'arm64' }), /Native builds only/);
  for (const args of [['--publish=always'], ['--platform=win32', '--platform=win32'], ['--arch=../x64'], ['--arch=ia32']]) {
    assert.throws(() => buildPlan(args, { platform: 'win32', arch: 'x64' }));
  }
});
test('installer builds never erase or mix old artifacts and reject output outside their build directory', async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'connectwallet-installer-build-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const output = path.join(base, 'dist', 'installers', 'win32-x64');
  await prepareOutput(output, base);
  await writeFile(path.join(output, 'previous.msi'), 'preserve');
  await assert.rejects(prepareOutput(output, base), /not empty/);
  assert.equal(await readFile(path.join(output, 'previous.msi'), 'utf8'), 'preserve');
  await assert.rejects(prepareOutput(path.join(base, 'other'), base), /Unexpected/);
  const other = path.join(base, 'nested'); await mkdir(other);
  await writeFile(path.join(other, 'dist'), 'not a directory');
  await assert.rejects(prepareOutput(path.join(other, 'dist', 'installers', 'win32-x64'), other), /Unsafe/);
});
