import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimsErrorText } from '../src/claims-diagnostics.mjs';

const fixture = () => ({ lastError: 'RPC_TIMEOUT', lastRpcError: { code: 'RPC_TIMEOUT',
  method: 'getblockbounties', phase: 'read', elapsedMs: 120001, queuedMs: 5, bytesReceived: 8192 } });

test('claims diagnostics identify query, phase, elapsed time and received bytes', () => {
  assert.equal(claimsErrorText(fixture()), 'RPC_TIMEOUT · getblockbounties\nReceiving the response · 120.0 s elapsed (0.0 s in queue)\nReceived: 8,192 bytes.');
  for (const [phase, label] of [['quota', 'local RPC allowance'], ['queue', 'local queue'], ['dns', 'Resolving'], ['connect', 'Connecting'], ['write', 'Sending'], ['parse', 'Checking'], ['consumer', 'Processing']]) {
    const value = fixture(); value.lastRpcError.phase = phase;
    assert.ok(claimsErrorText(value).includes(label));
  }
});

test('broadcast errors retain method diagnostics without turning ordinary quota waiting into an error', () => {
  const value = fixture(); value.lastError = '-32029'; value.lastRpcError.code = '-32029';
  value.lastRpcError.method = 'sendrawtransaction'; value.lastRpcError.phase = 'parse';
  assert.ok(claimsErrorText(value).startsWith('-32029 · sendrawtransaction\nChecking the response'));
  value.lastError = '';
  assert.equal(claimsErrorText(value), '');
  value.lastError = 'CLAIMS_UNKNOWN_OUTCOME';
  assert.equal(claimsErrorText(value), 'CLAIMS_UNKNOWN_OUTCOME');
});

test('old states and unrelated diagnostics preserve the original error only', () => {
  assert.equal(claimsErrorText(null), ''); assert.equal(claimsErrorText({ lastError: '' }), '');
  assert.equal(claimsErrorText({ lastError: 'CLAIMS_UNKNOWN_OUTCOME' }), 'CLAIMS_UNKNOWN_OUTCOME');
  const value = fixture(); value.lastRpcError.code = 'RPC_UNAVAILABLE';
  assert.equal(claimsErrorText(value), 'RPC_TIMEOUT');
  value.lastError = ''; assert.equal(claimsErrorText(value), '');
});

test('untrusted diagnostic fields cannot inject text or misleading quantities', () => {
  for (const [field, bad] of [['method', 'gettransaction secret'], ['phase', '__proto__'], ['phase', 'server response'],
    ['elapsedMs', -1], ['elapsedMs', Infinity], ['elapsedMs', 86400001], ['queuedMs', 120002],
    ['bytesReceived', 1073741825], ['bytesReceived', '12'], ['bytesReceived', -1]]) {
    const value = fixture(); value.lastRpcError[field] = bad;
    assert.equal(claimsErrorText(value), 'RPC_TIMEOUT');
  }
  const value = fixture(); Object.assign(value.lastRpcError, { params: 'not-for-display', message: 'server-secret', transaction_hex: 'not-for-display' });
  assert.ok(!claimsErrorText(value).includes('not-for-display'));
  assert.ok(!claimsErrorText(value).includes('server-secret'));
  assert.equal(claimsErrorText({ lastError: '<script>bad</script>' }), 'CLAIMS_FAILED');
});
