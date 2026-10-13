// Presentation only. Native code owns retry timing, quotas, discovery and keys.
// Never infer active recovery merely from an incomplete HD range.
export function hdRecoveryStatus(vault, { active = true, connected = true } = {}) {
  const hd = vault?.hd ?? {};
  const scanned = Number.isSafeInteger(hd.scanned) && hd.scanned >= 0 && hd.scanned <= 10000 ? hd.scanned : 0;
  const checked = `${scanned} checked`;
  const code = typeof hd.errorCode === 'string' && /^(?:RPC_[A-Z_]{1,32}|HD_[A-Z_]{1,32}|-\d{1,8})$/.test(hd.errorCode)
    ? hd.errorCode : '';
  const detail = code ? ` Last error: ${code}.` : '';
  const failed = hd.recoveryState === 'failed' || hd.recovering !== true && Boolean(hd.error);
  const error = failed ? (typeof hd.error === 'string' && hd.error.length <= 512 && hd.error
    || 'Address recovery could not complete. Retry recovery.') + detail : '';
  if (hd.complete === true && hd.recovering !== true) {
    return { status: `${vault.accounts?.length ?? 0} owned addresses tracked · receiving and change branches recovered.`,
      error: '', retryLabel: 'Rescan addresses' };
  }
  if (vault?.locked === true) {
    return { status: `Address discovery paused · ${checked}. Unlock the wallet to resume.`, error, retryLabel: 'Retry recovery' };
  }
  if (!active || hd.recoveryState === 'paused') {
    return { status: `Address discovery paused · ${checked}. Return to the app and unlock to resume.`, error, retryLabel: 'Retry recovery' };
  }
  if (failed) {
    return { status: `Address discovery stopped · ${checked}. Retry after checking the error below.`, error, retryLabel: 'Retry recovery' };
  }
  if (hd.recovering === true && (hd.recoveryState === 'waiting-network' || !connected)) {
    return { status: `Waiting for a usable network · ${checked}. Address discovery will resume automatically.${detail}`,
      error: '', retryLabel: 'Waiting for network' };
  }
  if (hd.recovering === true && hd.recoveryState === 'retrying') {
    const delay = Number.isFinite(hd.retryAfterMs) && hd.retryAfterMs >= 0 && hd.retryAfterMs <= 120000 ? hd.retryAfterMs : null;
    const when = delay === null ? 'automatically' : delay > 0 ? `in ${Math.ceil(delay / 1000)} s` : 'now';
    return { status: `Retrying address discovery ${when} · ${checked}.${detail}`,
      error: '', retryLabel: 'Retrying automatically' };
  }
  if (hd.recovering === true) {
    return { status: `Discovering receiving and change addresses · ${checked}. Payments become available when recovery is complete.`,
      error: '', retryLabel: 'Discovering addresses' };
  }
  return { status: `Address discovery incomplete · ${checked}. Select Retry recovery to continue.`, error: '', retryLabel: 'Retry recovery' };
}
