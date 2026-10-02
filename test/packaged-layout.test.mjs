import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, relative } from 'node:path';
import { assertNativeTarget, bundledLicensePath, packagedLayout, parsePackagedOptions, validateExecutableHeader } from '../scripts/test-packaged.mjs';

test('packaged smoke requires one explicit output root, platform and architecture', () => {
  const args = ['--directory=dist/installers/win32-x64', '--platform=win32', '--arch=x64'];
  assert.deepEqual(parsePackagedOptions(args), { directory: resolve('dist/installers/win32-x64'), platform: 'win32', arch: 'x64' });
  for (const invalid of [[], args.slice(1), args.slice(0, 2), [...args, '--directory=dist'], [...args, '--skip-native'],
    ['--directory=', '--platform=win32', '--arch=x64'], ['--directory= ', '--platform=win32', '--arch=x64'],
    ['--directory=dist', '--platform=../linux', '--arch=x64'], ['--directory=dist', '--platform=linux', '--arch=ia32']]) {
    assert.throws(() => parsePackagedOptions(invalid), /Usage:/);
  }
});

test('native smoke refuses cross-platform or cross-architecture execution', () => {
  assert.doesNotThrow(() => assertNativeTarget({ platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'arm64' }));
  assert.throws(() => assertNativeTarget({ platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }), /native darwin\/arm64/);
  assert.throws(() => assertNativeTarget({ platform: 'linux', arch: 'x64' }, { platform: 'win32', arch: 'x64' }), /native linux\/x64/);
});

test('builder layouts stay in the explicitly selected root for every target', () => {
  const directory = resolve('output with spaces');
  for (const [platform, arch, app, executable, resources] of [
    ['win32', 'x64', 'win-unpacked', 'ConnectWallet.exe', 'resources'],
    ['win32', 'arm64', 'win-arm64-unpacked', 'ConnectWallet.exe', 'resources'],
    ['linux', 'x64', 'linux-unpacked', 'connectwallet', 'resources'],
    ['linux', 'arm64', 'linux-arm64-unpacked', 'connectwallet', 'resources'],
    ['darwin', 'x64', 'mac/ConnectWallet.app', 'Contents/MacOS/ConnectWallet', 'Contents/Resources'],
    ['darwin', 'arm64', 'mac-arm64/ConnectWallet.app', 'Contents/MacOS/ConnectWallet', 'Contents/Resources'],
  ]) {
    const layout = packagedLayout({ directory, platform, arch });
    assert.equal(layout.app, resolve(directory, app));
    assert.equal(layout.executable, resolve(directory, app, executable));
    assert.equal(layout.archive, resolve(directory, app, resources, 'app.asar'));
    assert.equal(layout.helper, resolve(directory, app, resources, 'claims-helper', platform === 'win32' ? 'connectwallet-claims.exe' : 'connectwallet-claims'));
    assert.equal(layout.internal, resolve(directory, app, resources, 'claims-helper/_internal'));
    for (const path of Object.values(layout)) assert.ok(!relative(directory, path).startsWith('..'));
  }
  assert.throws(() => packagedLayout({ directory, platform: 'win32', arch: '../../old-output' }), /Usage:/);
});

test('license manifest paths cannot read outside the packaged license tree', () => {
  const root = resolve('package/licenses');
  assert.equal(bundledLicensePath(root, 'cryptography-50.0.1/00-LICENSE'), resolve(root, 'cryptography-50.0.1/00-LICENSE'));
  for (const path of ['', null, '../LICENSE', '/LICENSE', 'C:/LICENSE', 'C:\\LICENSE', 'dir\\LICENSE', 'dir/../LICENSE',
    'dir/./LICENSE', 'dir//LICENSE', 'file:stream', 'file\0']) {
    assert.throws(() => bundledLicensePath(root, path), /license/);
  }
});

function nativeHeader(platform, arch) {
  const buffer = Buffer.alloc(256);
  if (platform === 'win32') {
    buffer.write('MZ'); buffer.writeUInt32LE(128, 0x3c); buffer.writeUInt32LE(0x4550, 128);
    buffer.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 132); buffer.writeUInt16LE(0x20b, 152);
  } else if (platform === 'linux') {
    buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); buffer.writeUInt16LE(3, 16);
    buffer.writeUInt16LE(arch === 'x64' ? 62 : 183, 18);
  } else {
    buffer.writeUInt32LE(0xfeedfacf, 0); buffer.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4);
    buffer.writeUInt32LE(2, 12);
  }
  return buffer;
}

test('native executable headers reject wrong architecture, platform and truncated files', () => {
  for (const platform of ['win32', 'linux', 'darwin']) for (const arch of ['x64', 'arm64']) {
    const target = { platform, arch }, header = nativeHeader(platform, arch);
    assert.doesNotThrow(() => validateExecutableHeader(header, target));
    assert.throws(() => validateExecutableHeader(header, { platform, arch: arch === 'x64' ? 'arm64' : 'x64' }), /native executable/);
    assert.throws(() => validateExecutableHeader(header, { platform: platform === 'win32' ? 'linux' : 'win32', arch }), /native executable/);
    for (const truncated of [Buffer.alloc(0), header.subarray(0, 12), Buffer.alloc(256)]) {
      assert.throws(() => validateExecutableHeader(truncated, target), /native executable/);
    }
  }
  const malformedPe = nativeHeader('win32', 'x64'); malformedPe.writeUInt32LE(0xffffffff, 0x3c);
  assert.throws(() => validateExecutableHeader(malformedPe, { platform: 'win32', arch: 'x64' }), /native executable/);
});
