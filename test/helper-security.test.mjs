import test from 'node:test';
import assert from 'node:assert/strict';
import { pinnedCryptographyVersion, validateHelperSecurity } from '../scripts/helper-security.mjs';

const current = () => ({ type: 'ready', protocol: 3, roots: 1, security: {
  cryptographyVersion: '50.0.1', minimumCryptographyVersion: '50.0.1',
  opensslVersion: 'OpenSSL 4.0.2 11 Aug 2026',
} });

test('packaging reads one exact provider pin on Windows and Unix', () => {
  for (const newline of ['\n', '\r\n']) {
    assert.equal(pinnedCryptographyVersion(`cryptography==50.0.1${newline}cffi==2.1.1${newline}`), '50.0.1');
  }
  for (const value of ['', 'cryptography>=50.0.1', 'cryptography==50.0.1rc1',
    'cryptography==50.0.1\ncryptography==50.0.1\n']) {
    assert.throws(() => pinnedCryptographyVersion(value), /exact cryptography/);
  }
});

test('packaging accepts the provider bundled at the source pin', () => {
  const report = current();
  assert.deepEqual(validateHelperSecurity(JSON.stringify(report) + '\n', '50.0.1'), report.security);
});

test('packaging rejects stale, mismatched or unidentifiable native helpers', () => {
  const reports = [{ type: 'ready', protocol: 3, roots: 1 }, null, {},
    { ...current(), protocol: 2 }, { ...current(), roots: 2 }];
  for (const [field, value] of [['cryptographyVersion', '47.0.0'], ['cryptographyVersion', '50.0.0'],
    ['cryptographyVersion', '50.0.1rc1'], ['cryptographyVersion', '51.0.0'],
    ['minimumCryptographyVersion', '47.0.0'], ['opensslVersion', ''], ['opensslVersion', null]]) {
    const report = current(); report.security[field] = value; reports.push(report);
  }
  for (const output of [...reports.map(JSON.stringify), 'invalid', JSON.stringify(current()) + '\n{}']) {
    assert.throws(() => validateHelperSecurity(output, '50.0.1'), /build:claims/);
  }
});
