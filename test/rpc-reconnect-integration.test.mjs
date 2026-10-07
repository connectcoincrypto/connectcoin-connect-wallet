import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient } from '../src/core/rpc.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';

const tip = { chain: 'testnet4', genesis_hash: GENESIS.testnet4, hash: GENESIS.testnet4, height: 0, mediantime: 1800000000 };
const cancelled = error => error.name === 'AbortError' && error.code === 'ABORT_ERR' && error.notSent === true && !error.unknownOutcome;
async function until(predicate) {
  for (let pass = 0; pass < 600; pass++) { if (predicate()) return; await delay(5); }
  assert.fail('The isolated reconnect did not settle.');
}
async function fixture(t) {
  const sockets = new Set(), requests = [];
  let connections = 0, failNextTip = false;
  const server = net.createServer(socket => {
    const connection = ++connections;
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        requests.push({ ...request, connection });
        if (request.method === 'getchaintip' && failNextTip) { failNextTip = false; socket.write('invalid-json\n'); continue; }
        let result;
        if (request.method === 'getchaintip') result = tip;
        else if (['subscribetip', 'subscribebounties', 'subscribeaddress'].includes(request.method)) {
          result = { subscription_id: `${connection}-${request.method}-${request.params.address ?? ''}`, tip, cursor: 'isolated-cursor' };
          if (request.method === 'subscribeaddress') {
            assert.equal(request.params.changes_only, true);
            result.changes_only = true;
          }
        } else assert.fail(`Unexpected request in the read-only fixture: ${request.method}`);
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      }
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = { host: '127.0.0.1', port: server.address().port };
  const client = new RpcClient({ ...endpoint, timeoutMs: 1000 });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { client, endpoint, requests, failTip: () => { failNextTip = true; }, get connections() { return connections; } };
}

test('synchronous disconnect cancellation settles an immediate retry and leaves the new connection usable', async t => {
  const f = await fixture(t);
  f.failTip();
  await assert.rejects(f.client.request('getchaintip'), /invalid or oversized/);
  const controller = new AbortController();
  let disconnected = 0;
  f.client.on('disconnected', () => { disconnected++; controller.abort(); });
  // Models wallet/claim lifecycle cancellation invoked synchronously while
  // connect() announces the destroyed old socket, before socket.close fires.
  await assert.rejects(f.client.request('getblockbounties', { block_hash: GENESIS.testnet4 }, {
    signal: controller.signal, onChunk: () => assert.fail('Cancelled discovery must not receive records.'),
  }), cancelled);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(await f.client.request('getchaintip'), tip);
  await delay(0);
  assert.equal(disconnected, 1);
  assert.equal(f.connections, 2);
  assert.equal(f.client.queuedRequests, 0);
  assert.equal(f.client.pending.size, 0);
  assert.equal(f.client.streams.size, 0);
  assert.deepEqual(f.requests.map(request => request.method), ['getchaintip', 'getchaintip']);
});

test('immediate retry invalidates real wallet watches, settles cancelled work and resumes claim catch-up', async t => {
  const f = await fixture(t);
  // No initialization, vault, keys, proof helper, transaction or remote node.
  // Keep the actual wallet disconnect listeners and LiveUpdates worker; stub
  // only the expensive state refresh and claim work triggered by catch-up.
  const service = new WalletService({ directory: process.cwd(), network: 'testnet4', clientFactory: () => f.client });
  service.config = { ...structuredClone(DEFAULT_CONFIG), network: 'testnet4', rpc: f.endpoint };
  service.config.claims.enabled = true;
  service.session = { data: { receiveIndex: 0, changeIndex: 0 } };
  service.accounts = [{ address: 'syntheticaddress1', index: 0, change: 0 }];
  let stops = 0, resumes = 0, refreshes = 0;
  service.engine = { enabled: true, async stop() { stops++; this.enabled = false; } };
  service.emitState = () => {};
  service.refresh = async () => { refreshes++; service.walletReadRevision = service.walletUpdateRevision; };
  service.syncBounties = async () => {};
  service.resumeClaims = async () => { resumes++; service.claimsResumePending = false; service.engine.enabled = true; };
  service.connectClient();
  t.after(() => { service.session = null; service.closed = true; service.stopLiveUpdates(); service.statePublisher.close(); });
  service.liveUpdates.retryMinMs = 5; service.liveUpdates.retryDelay = 5;
  service.liveUpdates.start();
  await until(() => service.liveUpdates.registrations.size === 3 && refreshes > 0 &&
    !service.liveUpdates.running && !service.walletUpdates.running && !service.walletUpdates.timer &&
    !service.bountyUpdates.running && !service.bountyUpdates.timer);
  const oldTipSubscription = service.liveUpdates.registrations.get('tip').id;
  const priorRefreshes = refreshes;
  f.failTip();
  await assert.rejects(f.client.request('getchaintip'), /invalid or oversized/);
  const preparation = new AbortController();
  service.sendPreparation = preparation;
  await assert.rejects(f.client.request('getchaintip', {}, { signal: preparation.signal }), cancelled);
  assert.equal(preparation.signal.aborted, true);
  assert.equal(service.sendPreparation, null);
  assert.equal(stops, 1);
  await until(() => resumes === 1 && service.engine.enabled && refreshes > priorRefreshes &&
    service.liveUpdates.registrations.size === 3 && !service.liveUpdates.running &&
    !service.walletUpdates.running && !service.walletUpdates.timer && !service.bountyUpdates.running && !service.bountyUpdates.timer);
  assert.notEqual(service.liveUpdates.registrations.get('tip').id, oldTipSubscription);
  assert.equal(service.liveUpdates.retryTimer, null);
  assert.equal(service.claimsResumePending, false);
  assert.equal(f.connections, 2);
  assert.equal(f.client.queuedRequests, 0);
  assert.equal(f.client.pending.size, 0);
  assert.equal(f.client.streams.size, 0);
});
