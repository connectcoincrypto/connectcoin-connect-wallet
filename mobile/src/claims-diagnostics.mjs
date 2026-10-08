// Only bounded, native-generated operational metadata is displayed. Never show
// RPC parameters, server error text, raw transactions or wallet material here.
const METHODS = new Set(['getchaintip', 'getrecentblockhashes', 'getbountychanges', 'getblockbounties', 'gettransaction', 'gettransactions', 'sendrawtransaction']);
const PHASES = Object.freeze({ quota: 'Waiting for the local RPC allowance', queue: 'Waiting in the local queue', dns: 'Resolving the server',
  connect: 'Connecting to the server', write: 'Sending the request', read: 'Receiving the response',
  parse: 'Checking the response', consumer: 'Processing the response' });

export function claimsErrorText(claims) {
  const code = claims?.lastError;
  if (!code) return '';
  if (typeof code !== 'string' || !/^(?:[A-Z][A-Z0-9_]{0,79}|-[0-9]{1,8})$/.test(code)) return 'CLAIMS_FAILED';
  const detail = claims.lastRpcError;
  if (!detail || detail.code !== code || !METHODS.has(detail.method) || !Object.hasOwn(PHASES, detail.phase)) return code;
  if (![detail.elapsedMs, detail.queuedMs].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 86400000) ||
      detail.queuedMs > detail.elapsedMs || !Number.isSafeInteger(detail.bytesReceived) ||
      detail.bytesReceived < 0 || detail.bytesReceived > 1073741824) return code;
  return `${code} · ${detail.method}\n${PHASES[detail.phase]} · ${(detail.elapsedMs / 1000).toFixed(1)} s elapsed (${(detail.queuedMs / 1000).toFixed(1)} s in queue)\nReceived: ${detail.bytesReceived.toLocaleString('en-US')} bytes.`;
}
