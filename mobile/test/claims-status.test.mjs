import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { claimsStatusText } from '../src/claims-status.mjs';

const held = (extra = {}) => ({ enabled: true, allowed: true, policyStatus: 'allowed',
  status: 'submitting', ...extra });

test('preserved proofs use normal native submission status without an artificial availability gate', () => {
  assert.equal(claimsStatusText(held()), 'Allowed · Submitting');
  assert.equal(claimsStatusText(held({ status: 'retrying' })), 'Allowed · Retrying');
  assert.equal(claimsStatusText(held({ status: 'synchronizing' })), 'Allowed · Synchronizing');
});

test('obsolete availability fields never create a renderer-side waiting state', () => {
  for (const count of [undefined, null, '2', true, -1, 0, 1.5, 201, Infinity, NaN]) {
    assert.equal(claimsStatusText(held({ awaitingAvailability: count, targetHits: 2, activeConnections: 2 })), 'Allowed · Submitting');
  }
  assert.equal(claimsStatusText(held({ status: 'awaiting-availability' })), 'Allowed · Status unavailable');
});

test('lifecycle and unknown broadcast statuses never imply an automatic submission retry', () => {
  assert.equal(claimsStatusText(held({ status: 'stopped' })), 'Allowed · Stopped');
  assert.equal(claimsStatusText(held({ status: 'paused' })), 'Allowed · Paused');
  assert.equal(claimsStatusText(held({ status: 'error' })), 'Allowed · Error');
  assert.equal(claimsStatusText(held({ status: 'unknown-outcome' })), 'Allowed · Submission outcome unknown');
});

test('presentation accepts only known status labels without mutating native counters', () => {
  const state = Object.freeze(held({ attempts: 18, valid: 14, invalid: 4, targetHits: 3, submitted: 2, unknown: 0 }));
  const before = structuredClone(state);
  claimsStatusText(state);
  assert.deepEqual(state, before);
  for (const status of ['<script>private</script>', '__proto__', 'constructor', 'x'.repeat(1000)]) {
    assert.equal(claimsStatusText(held({ status, policyStatus: status })), 'Claims · Status unavailable');
  }
  assert.equal(claimsStatusText(null), 'Claims status unavailable');
  assert.equal(claimsStatusText([]), 'Claims status unavailable');
  assert.equal(claimsStatusText({ status: 'waiting' }), 'Claims · Waiting');
});

test('economic waiting reason is explicit and never changes real counters or lifecycle states', () => {
  const state = Object.freeze(held({ status: 'waiting', waitingReason: 'economic-floor', available: 200,
    eligible: 0, economicFiltered: 200, attempts: 0, valid: 0 }));
  assert.equal(claimsStatusText(state), 'Allowed · Waiting · Below the economic floor; only bounded calibration/recovery probes');
  assert.equal(state.attempts, 0); assert.equal(state.valid, 0); assert.equal(state.eligible, 0);
  for (const status of ['stopped', 'paused', 'unknown-outcome', 'submitting']) {
    assert.doesNotMatch(claimsStatusText({ ...state, status }), /economic floor/);
  }
  for (const waitingReason of ['<script>', '__proto__', 1, null]) {
    assert.equal(claimsStatusText({ ...state, waitingReason }), 'Allowed · Waiting');
  }
});

test('retained-proof capacity explains waiting without changing counters or promising automatic recovery', () => {
  const state = Object.freeze(held({ status: 'waiting', waitingReason: 'retained-capacity', retainedSubmissions: 200,
    attempts: 1500, valid: 1499, submitted: 197, unknown: 0 }));
  const before = structuredClone(state);
  assert.equal(claimsStatusText(state), 'Allowed · Waiting · Awaiting claim confirmations or submission review; retained-proof capacity reached');
  assert.deepEqual(state, before);
  for (const status of ['stopped', 'paused', 'unknown-outcome', 'submitting', 'error']) {
    assert.doesNotMatch(claimsStatusText({ ...state, status }), /capacity reached/);
  }
  for (const waitingReason of ['__proto__', 'constructor', '<script>', null, 200]) {
    assert.equal(claimsStatusText({ ...state, waitingReason }), 'Allowed · Waiting');
  }
});

test('mobile presents available, economic eligibility and filtering as distinct native diagnostics', async () => {
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  for (const key of ['available', 'eligible', 'economicFiltered']) {
    assert.match(page, new RegExp(`id="claims-${key}"`)); assert.ok(app.includes(`'${key}'`));
  }
});

test('both mobile claims surfaces show native status without a stale retained-proof message', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /claimsAvailabilityText|awaitingAvailability|awaiting-availability/);
  assert.match(app, /\$\('claims-status'\)\.textContent = .*claimsStatusText\(claims\)/);
  assert.match(app, /\$\('background-claims-status'\)\.textContent = .*claimsStatusText\(claims\)/);
});
