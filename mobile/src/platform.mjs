// Native signing/RPC exist on both packaged platforms. Only Android has the
// explicitly enabled foreground-service background claims implementation.
export function nativeCapabilities(platform) {
  const wallet = platform === 'android' || platform === 'ios';
  return Object.freeze({ wallet, claims: wallet, backgroundClaims: platform === 'android' });
}
