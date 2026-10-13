export { CLAIMS_ROOT_SHA256 as NATIVE_ROOT_SHA256 } from '../src/core/claims-helper-policy.mjs';
import { CLAIMS_ROOT_SHA256 as NATIVE_ROOT_SHA256 } from '../src/core/claims-helper-policy.mjs';
export const NATIVE_LICENSE_FILES = Object.freeze([
  'LICENSE', 'PROVENANCE.md', 'THIRD-PARTY-NOTICES.txt', 'CORE-LICENSE',
  'Bitcoin-Core-COPYING', 'MbedTLS-LICENSE', 'UniValue-COPYING',
  'p2c_roots_v1.pem',
]);

export function validateNativeLicenseManifest(manifest) {
  if (manifest?.provider !== 'mbedtls' || manifest.version !== '3.6.7' ||
      manifest.rootsSha256 !== NATIVE_ROOT_SHA256 || !Array.isArray(manifest.files) ||
      manifest.files.length !== NATIVE_LICENSE_FILES.length) throw new Error('Invalid native helper license manifest.');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (!NATIVE_LICENSE_FILES.includes(entry?.file) || seen.has(entry.file) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        (entry.file === 'p2c_roots_v1.pem' && entry.sha256 !== NATIVE_ROOT_SHA256)) throw new Error('Invalid native helper license manifest.');
    seen.add(entry.file);
  }
  return manifest.files;
}
