// These preferences govern claims only. Read-only balance/history synchronization
// must not use this policy as a network permission check.
export const DEFAULT_CLAIMS_POLICY = Object.freeze({ allowMobileData: false, allowBackground: false });

export function evaluateClaimsPolicy(options = {}) {
  const denied = reason => ({ allowed: false, reason });
  if (!options || typeof options !== 'object' || Array.isArray(options)) return denied('disabled');
  const { enabled, allowMobileData = false, allowBackground = false, connected, connectionType,
    appActive, nativeClaimsAvailable, nativeBackgroundAvailable, platform } = options;
  if (enabled !== true) return denied('disabled');
  if (nativeClaimsAvailable !== true) return denied('native-claims-unavailable');
  if (platform !== 'android' && platform !== 'ios') return denied('unsupported-platform');
  if (connected !== true) return denied('offline');
  if (connectionType !== 'wifi' && connectionType !== 'cellular' && connectionType !== 'ethernet') return denied('connection-unknown');
  if (connectionType === 'cellular' && allowMobileData !== true) return denied('mobile-data-disabled');
  if (appActive !== true && appActive !== false) return denied('app-state-unknown');
  if (appActive === false) {
    if (allowBackground !== true) return denied('background-disabled');
    if (platform === 'ios') return denied('ios-background-unsupported');
    if (nativeBackgroundAvailable !== true) return denied('native-background-unavailable');
    return { allowed: true, reason: 'background' };
  }
  return { allowed: true, reason: 'foreground' };
}
