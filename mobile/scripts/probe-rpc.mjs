// Optional, explicit integration probe. Uses a well-known PUBLIC generator point,
// not a user profile/address/seed. Three read-only calls, no retries or broadcasts.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import tls from 'node:tls';
import { RPC_ENDPOINT, validateTip, validateBalance, validateHistory } from '../src/model.mjs';

const address = bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.toBytes(true).slice(1))]);
async function request(method, params) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: RPC_ENDPOINT.host, servername: RPC_ENDPOINT.host, port: RPC_ENDPOINT.port, rejectUnauthorized: true });
    let data = Buffer.alloc(0), settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('Authenticated TLS RPC timed out; no plaintext fallback.')), 40000);
    socket.once('secureConnect', () => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`));
    socket.on('error', error => finish(error)); socket.once('end', () => finish(new Error('Incomplete RPC response.')));
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]); if (data.length > 2 * 1024 * 1024) return finish(new Error('Oversized RPC response.'));
      const end = data.indexOf(10); if (end < 0) return;
      try {
        const response = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, end)));
        if (response.jsonrpc !== '2.0' || response.id !== 1 || response.error || !response.result) throw new Error('Invalid RPC result.');
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
}
try {
  const tip = validateTip(await request('getchaintip', {}));
  validateBalance(await request('getaddressbalance', { address }), address);
  const history = validateHistory(await request('getaddresshistory', { address }), address);
  console.log(`Verified mainnet response schemas at height ${tip.height}; ${history.items.length} public test-address history rows.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
