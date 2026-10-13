import test from 'node:test';
import assert from 'node:assert/strict';
import { hdRecoveryStatus } from '../src/hd-recovery-status.mjs';

const vault = (hd = {}, locked = false) => ({ locked, accounts: [{}, {}], hd: { complete: false, recovering: true, scanned: 17, ...hd } });

test('incomplete, active, failed and completed HD discovery have distinct messages', () => {
  assert.match(hdRecoveryStatus(vault()).status, /^Discovering.*17 checked/);
  assert.match(hdRecoveryStatus(vault({ recovering: false })).status, /^Address discovery incomplete/);
  const failure = hdRecoveryStatus(vault({ recovering: false, recoveryState: 'failed', error: 'Server did not respond.', errorCode: 'RPC_TIMEOUT' }));
  assert.match(failure.status, /^Address discovery stopped/);
  assert.equal(failure.error, 'Server did not respond. Last error: RPC_TIMEOUT.');
  assert.equal(failure.retryLabel, 'Retry recovery');
  const complete = hdRecoveryStatus(vault({ complete: true, recovering: false, error: 'Old error', errorCode: 'RPC_TIMEOUT' }));
  assert.match(complete.status, /^2 owned addresses/);
  assert.equal(complete.error, '');
  assert.equal(complete.retryLabel, 'Rescan addresses');
});

test('temporary errors show waiting state and native delay rather than red terminal errors', () => {
  const retry = hdRecoveryStatus(vault({ recoveryState: 'retrying', retryAfterMs: 7100, errorCode: '-32029', error: 'Old error' }));
  assert.match(retry.status, /in 8 s · 17 checked.*-32029/);
  assert.equal(retry.error, '');
  assert.equal(retry.retryLabel, 'Retrying automatically');
  assert.match(hdRecoveryStatus(vault({ recoveryState: 'retrying', retryAfterMs: 0 })).status, /discovery now/);
  const waiting = hdRecoveryStatus(vault({ recoveryState: 'waiting-network', errorCode: 'RPC_INACTIVE' }));
  assert.match(waiting.status, /Waiting for a usable network.*resume automatically/);
  assert.equal(waiting.error, '');
  assert.equal(waiting.retryLabel, 'Waiting for network');
});

test('lock or background overrides retry countdown and never promises automatic unlock', () => {
  const value = vault({ recoveryState: 'retrying', retryAfterMs: 9000 }, true);
  assert.match(hdRecoveryStatus(value).status, /^Address discovery paused.*Unlock the wallet/);
  assert.doesNotMatch(hdRecoveryStatus(value).status, /Retrying/);
  value.locked = false;
  assert.match(hdRecoveryStatus(value, { active: false }).status, /Return to the app and unlock/);
  assert.match(hdRecoveryStatus(vault(), { connected: false }).status, /^Waiting for a usable network/);
});

test('untrusted or malformed diagnostics cannot produce arbitrary codes or invalid countdowns', () => {
  for (const delay of [-1, Infinity, '2000', 120001]) {
    assert.match(hdRecoveryStatus(vault({ recoveryState: 'retrying', retryAfterMs: delay })).status, /discovery automatically/);
  }
  const result = hdRecoveryStatus(vault({ recovering: false, recoveryState: 'failed', scanned: -8,
    error: 'x'.repeat(513), errorCode: 'private details/password' }));
  assert.match(result.status, /0 checked/);
  assert.equal(result.error, 'Address recovery could not complete. Retry recovery.');
});
