import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNativeHelperSecurity } from '../scripts/helper-security.mjs';
import { NATIVE_LICENSE_FILES, NATIVE_ROOT_SHA256, validateNativeLicenseManifest } from '../scripts/native-helper-manifest.mjs';
import { releaseNotes } from '../scripts/publish-release.mjs';

const report = () => ({ type: 'ready', protocol: 4, roots: 1, security: {
  provider: 'mbedtls', mbedtlsVersion: '3.6.7', rsaPublicExponentMaxBits: 64, rootsSha256: NATIVE_ROOT_SHA256,
} });
test('native runtime disclosure does not rewrite previously published Python releases', () => {
  for (const version of ['1.0.0', '1.0.9', '1.1.0']) assert.match(releaseNotes(version, '1', 'a'.repeat(40)), /helper and Python runtime are bundled/);
  for (const version of ['1.1.1', '1.2.0', '2.0.0']) assert.match(releaseNotes(version, '1', 'a'.repeat(40)), /no Python runtime is required/);
});
test('desktop packaging accepts only the pinned native provider and actual embedded root bytes', () => {
  const valid = report();
  assert.deepEqual(validateNativeHelperSecurity(JSON.stringify(valid)), valid.security);
  for (const [key, value] of [['provider', 'python'], ['mbedtlsVersion', '3.6.6'], ['rsaPublicExponentMaxBits', 65], ['rootsSha256', '0'.repeat(64)]]) {
    const bad = report(); bad.security[key] = value;
    assert.throws(() => validateNativeHelperSecurity(JSON.stringify(bad)), /pinned C\+\+/);
  }
  for (const output of ['{}', JSON.stringify({ ...report(), protocol: 3 }), JSON.stringify(report()) + '\n{}']) {
    assert.throws(() => validateNativeHelperSecurity(output), /pinned C\+\+/);
  }
});
const manifest = () => ({ provider: 'mbedtls', version: '3.6.7', rootsSha256: NATIVE_ROOT_SHA256,
  files: NATIVE_LICENSE_FILES.map(file => ({ file, sha256: file === 'p2c_roots_v1.pem' ? NATIVE_ROOT_SHA256 : 'a'.repeat(64) })),
});
test('native package license manifest requires every license once with bounded safe paths', () => {
  const valid = manifest();
  assert.equal(validateNativeLicenseManifest(valid), valid.files);
  const bads = [null, {}, { ...valid, version: '3.6.6' }, { ...valid, rootsSha256: '0'.repeat(64) },
    { ...valid, files: valid.files.slice(1) }];
  for (const entry of [{ file: '../LICENSE', sha256: 'a'.repeat(64) }, { ...valid.files[1] }, { ...valid.files[0], sha256: 'not-a-hash' }]) {
    bads.push({ ...valid, files: [entry, ...valid.files.slice(1)] });
  }
  for (const bad of bads) assert.throws(() => validateNativeLicenseManifest(bad), /manifest/);
});
