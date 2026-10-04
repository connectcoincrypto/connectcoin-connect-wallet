// Native consensus parity test. Starts an isolated, offline regtest daemon;
// never touches existing wallets, live node data, or public network peers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { deriveAccount } from '../src/core/crypto.mjs';
import { buildPayment, COIN, parseTransaction, prepareClaim, serializeTransaction, transactionId } from '../src/core/transaction.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.resolve(process.env.CONNECTCOIND ?? path.join(project, '..', 'connectcoin', 'build', 'bin', ...(process.platform === 'win32' ? ['Release', 'connectcoind.exe'] : ['connectcoind'])));
await access(binary);
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const directory = await mkdtemp(path.join(tmpdir(), 'connectwallet-crypto-regtest-'));
const cookieFile = path.join(directory, 'regtest', '.cookie');
const stdout = createWriteStream(path.join(directory, 'daemon.log'));
const child = spawn(binary, [`-datadir=${directory}`, '-regtest', '-server=1', '-listen=0', '-networkactive=0', '-dnsseed=0', '-fixedseeds=0', '-discover=0', '-listenonion=0', '-natpmp=0', '-disablewallet=1', '-test=randomx_mock_pow', '-printtoconsole=1', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1', `-rpcport=${port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(stdout, { end: false }); child.stderr.pipe(stdout, { end: false });
let closed = false;
const exit = once(child, 'exit').then(() => { closed = true; });
let id = 0;
async function rpc(method, params = []) {
  const credentials = (await readFile(cookieFile, 'utf8')).trim();
  const result = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(credentials).toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(30000),
  });
  const body = await result.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const mnemonic = `${'abandon '.repeat(11)}about`;
const owner = deriveAccount(mnemonic, { network: 'regtest' });
const receiver = deriveAccount(mnemonic, { network: 'regtest', index: 1 });
let success = false;
try {
  const until = Date.now() + 30000;
  for (;;) {
    try { if ((await rpc('getblockchaininfo')).chain === 'regtest') break; }
    catch (error) { if (closed || Date.now() >= until) throw error; await delay(100); }
  }
  console.log('Isolated regtest ready; generating mock-PoW blocks to ConnectWallet native address.');
  const blocks = await rpc('generatetoaddress', [103, owner.address]);
  const coins = [];
  for (const hash of blocks.slice(0, 3)) {
    const block = await rpc('getblock', [hash, 1]);
    const rawTransaction = await rpc('getrawtransaction', [block.tx[0], false, hash]);
    const funding = parseTransaction(rawTransaction);
    assert.equal(transactionId(funding), block.tx[0]);
    assert.equal(funding.outputs[0].publicKey, owner.publicKey);
    coins.push({ txid: block.tx[0], vout: 0, amount: funding.outputs[0].amount, rawTransaction, privateKey: owner.privateKey });
  }
  const payAmount = BigInt(coins[0].amount) + BigInt(coins[1].amount) / 2n;
  const payment = buildPayment({ utxos: coins, outputs: [{ address: receiver.address, amount: payAmount.toString() }], changeAddress: owner.address, network: 'regtest' });
  assert.equal(payment.selected.length, 2);
  const decoded = await rpc('decoderawtransaction', [payment.hex]);
  assert.equal(decoded.txid, payment.txid);
  assert.equal(decoded.vsize, payment.vsize);
  assert.equal(decoded.vout[0].scriptPubKey.address, receiver.address);
  const accepted = await rpc('testmempoolaccept', [[payment.hex]]);
  assert.equal(accepted[0].allowed, true, JSON.stringify(accepted));
  console.log('PASS: Core accepted a two-input native Schnorr transaction signed by ConnectWallet.');
  assert.equal(await rpc('sendrawtransaction', [payment.hex]), payment.txid);
  await rpc('generatetoaddress', [1, owner.address]);

  const receiveUTXO = { txid: payment.txid, vout: 0, amount: payAmount.toString(), rawTransaction: payment.hex, privateKey: receiver.privateKey };
  const bountyTX = buildPayment({ utxos: [receiveUTXO], outputs: [{ domain: 'example.com', amount: COIN.toString(), expectedConnections: '1024', mask: 6 }], changeAddress: receiver.address, network: 'regtest' });
  const bountyAcceptance = await rpc('testmempoolaccept', [[bountyTX.hex]]);
  assert.equal(bountyAcceptance[0].allowed, true, JSON.stringify(bountyAcceptance));
  assert.equal(await rpc('sendrawtransaction', [bountyTX.hex]), bountyTX.txid);
  await rpc('generatetoaddress', [1, owner.address]);
  const bounty = { txid: bountyTX.txid, vout: 0, amount: COIN.toString(), domain: 'example.com' };
  const prepared = prepareClaim({ bounty, rawTransaction: bountyTX.hex, rewardAddress: owner.address, network: 'regtest' });
  const expected = await rpc('getp2cchallenge', [prepared.hex, 0]);
  assert.equal(expected.txid, prepared.txid);
  assert.equal(expected.clienthello_random, prepared.challenge);
  assert.equal((await rpc('decoderawtransaction', [prepared.hex])).txid, prepared.txid);
  console.log('PASS: Core accepted P2C funding; its exact ClientHello challenge matches ConnectWallet.');

  // Tampering after signing must fail at real consensus, not only our verifier.
  const tampered = parseTransaction(bountyTX.hex);
  tampered.outputs[0].amount = (COIN + 1n).toString();
  const rejected = await rpc('testmempoolaccept', [[serializeTransaction(tampered).toString('hex')]]);
  assert.equal(rejected[0].allowed, false);
  const forgedAmount = { ...coins[2], amount: '999999999999' };
  assert.throws(() => buildPayment({ utxos: [forgedAmount], outputs: [{ address: receiver.address, amount: COIN.toString() }], changeAddress: owner.address, network: 'regtest' }), /amount/);
  console.log('PASS: altered recipient amount and dishonest RPC funding amount are rejected.');

  // Exercise deduction against the real node, including an exact sweep and
  // dust-sized change. testmempoolaccept validates without broadcasting.
  const available = BigInt(coins[2].amount);
  for (const [name, output] of [
    ['exact all-balance payment', { address: receiver.address, amount: available.toString() }],
    ['deducted fee with change', { address: receiver.address, amount: (available / 2n).toString() }],
    ['deducted fee with dust-change top-up', { address: receiver.address, amount: (available - 1n).toString() }],
    ['exact all-balance P2C bounty', { domain: 'example.com', amount: available.toString(), expectedConnections: '1024', mask: 6 }],
  ]) {
    const deducted = buildPayment({ utxos: [coins[2]], outputs: [output], changeAddress: owner.address, network: 'regtest', subtractFeeFromAmount: true });
    assert.equal(BigInt(deducted.total) + BigInt(deducted.fee) + BigInt(deducted.change), available);
    const decoded = await rpc('decoderawtransaction', [deducted.hex]);
    assert.equal(decoded.vsize, deducted.vsize);
    assert.equal(decoded.txid, deducted.txid);
    const acceptance = await rpc('testmempoolaccept', [[deducted.hex]]);
    assert.equal(acceptance[0].allowed, true, `${name}: ${JSON.stringify(acceptance)}`);
    console.log(`PASS: Core accepted ${name}.`);
  }
  success = true;
} finally {
  owner.privateKey.fill(0); receiver.privateKey.fill(0);
  if (!closed) {
    try { await rpc('stop'); } catch { child.kill(); }
    await Promise.race([exit, delay(10000)]);
    if (!closed) { child.kill('SIGKILL'); await exit; }
  }
  await new Promise(resolve => stdout.end(resolve));
  if (success) {
    assert.ok(path.dirname(directory) === path.resolve(tmpdir()) && path.basename(directory).startsWith('connectwallet-crypto-regtest-'));
    await rm(directory, { recursive: true, force: true });
  } else console.error(`Failure logs preserved in ${directory}`);
}
