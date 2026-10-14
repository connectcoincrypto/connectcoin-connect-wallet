// Presentation only: native code owns proof retention, discovery and submission.
// A discovery-window exit is not a consensus expiry or a renderer-side gate.
const STATUS = Object.freeze({ stopped: 'Stopped', paused: 'Paused', synchronizing: 'Synchronizing',
  retrying: 'Retrying', claiming: 'Claiming', waiting: 'Waiting', submitting: 'Submitting', submitted: 'Submitted', error: 'Error',
  'unknown-outcome': 'Submission outcome unknown' });
const POLICY = Object.freeze({ allowed: 'Allowed', stopped: 'Stopped', paused: 'Paused',
  'background-paused': 'Paused in background', offline: 'Offline',
  'mobile-data-disabled': 'Mobile data disabled', foreground: 'Foreground', background: 'Background' });
const WAITING = Object.freeze({
  'economic-floor': 'Below the economic floor; only bounded calibration/recovery probes',
  'retained-capacity': 'Awaiting claim confirmations or submission review; retained-proof capacity reached',
});

export function claimsStatusText(claims) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return 'Claims status unavailable';
  const policy = Object.hasOwn(POLICY, claims.policyStatus) ? POLICY[claims.policyStatus] : 'Claims';
  const status = Object.hasOwn(STATUS, claims.status) ? STATUS[claims.status] : 'Status unavailable';
  const reason = claims.status === 'waiting' && Object.hasOwn(WAITING, claims.waitingReason)
    ? ` · ${WAITING[claims.waitingReason]}` : '';
  return `${policy} · ${status}${reason}`;
}
