// Real Electron and optional packaged ASAR worker, using only a public test vector.
// No wallet is created or opened, and the isolated profile cannot reach a node.
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/core/config.mjs';
import { deriveAccount, verifySchnorr } from '../src/core/crypto.mjs';
import { COIN, parseTransaction, serializeTransaction, signatureHash, transactionId } from '../src/core/transaction.mjs';
import { closeElectronTest } from './ui-close.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] ?? root);
const profile = await mkdtemp(path.join(tmpdir(), 'connectwallet-ui-payment-worker-'));
await writeFile(path.join(profile, 'config.json'), JSON.stringify({ ...DEFAULT_CONFIG,
  rpc: { host: '127.0.0.1', port: 1 }, claims: { ...DEFAULT_CONFIG.claims, enabled: false } }));
const env = { ...process.env, CONNECTWALLET_TEST_PROFILE: profile, CONNECTWALLET_NETWORK: 'main' };
delete env.ELECTRON_RUN_AS_NODE;
const mnemonic = `${'abandon '.repeat(11)}about`;
const owner = deriveAccount(mnemonic, { network: 'main' });
const value = COIN / 50n;
const utxos = Array.from({ length: 151 }, (_, index) => {
  const parent = { version: 2, locktime: index,
    inputs: [{ txid: '12'.repeat(32), vout: 0, sequence: 0xffffffff, scriptSig: '', witness: ['02' + 'aa'.repeat(8191)] }],
    outputs: [{ type: 1, amount: value.toString(), publicKey: owner.publicKey }] };
  return { txid: transactionId(parent), vout: 0, amount: value.toString(), account: { index: 0, change: 0 },
    rawTransaction: serializeTransaction(parent).toString('hex') };
});
const input = { mnemonic, network: 'main', utxos, changeAddress: owner.address,
  outputs: [{ address: owner.address, amount: (3n * COIN).toString() }] };
let application;
try {
  application = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [target], env, timeout: 30000 });
  const runtime = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData'), appPath: app.getAppPath() }));
  assert.equal(runtime.packaged, false, 'Probe must use the development Electron executable so the isolated profile override is honored');
  assert.equal(path.resolve(runtime.profile), profile, 'Refuse to operate outside the isolated profile');
  assert.equal(path.resolve(runtime.appPath), target);
  await application.firstWindow();
  const result = await application.evaluate(async ({ app }, input) => {
    const path = process.getBuiltinModule('path');
    const require = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'));
    const { buildPaymentInWorker } = require(path.join(app.getAppPath(), 'src/core/payment-builder.mjs'));
    let heartbeats = 0;
    const timer = setInterval(() => heartbeats++, 10);
    const started = performance.now();
    try {
      const payment = await buildPaymentInWorker(input);
      const elapsedMs = Math.round(performance.now() - started);
      const sweep = { ...input, subtractFeeFromAmount: true,
        outputs: [{ ...input.outputs[0], amount: input.utxos.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString() }],
        parents: [...new Map(input.utxos.map(row => [row.txid, row.rawTransaction]))].map(([txid, hex]) => ({ txid, hex })),
        utxos: input.utxos.map(({ rawTransaction, ...row }) => row) };
      const sweepPayment = await buildPaymentInWorker(sweep);
      const controller = new AbortController();
      const pending = buildPaymentInWorker(input, { signal: controller.signal });
      const cancellation = pending.then(() => 'unexpected-success', error => error.name);
      controller.abort();
      return { payment, sweepPayment, heartbeats, elapsedMs, cancellation: await cancellation };
    } finally { clearInterval(timer); }
  }, input);
  assert.equal(result.cancellation, 'AbortError');
  assert.equal(result.payment.selected.length, 151);
  assert.ok(result.heartbeats >= 2, 'Electron main remains responsive during actual worker signing');
  const tx = parseTransaction(result.payment.hex);
  const spent = tx.inputs.map(() => ({ type: 1, amount: value.toString(), publicKey: owner.publicKey }));
  for (const index of [0, 75, 150]) assert.ok(verifySchnorr(Buffer.from(tx.inputs[index].witness[0], 'hex'), signatureHash(tx, spent, index), owner.publicKey));
  assert.equal(BigInt(result.payment.inputTotal), 3n * COIN + BigInt(result.payment.fee) + BigInt(result.payment.change));
  assert.equal(JSON.stringify(result.payment).includes(mnemonic), false);
  assert.equal(JSON.stringify(result.payment).includes(owner.privateKey.toString('hex')), false);
  const sweep = result.sweepPayment, sweepTx = parseTransaction(sweep.hex);
  assert.equal(sweep.selected.length, 151);
  assert.equal(sweep.subtractFeeFromAmount, true);
  assert.equal(sweep.change, '0');
  assert.equal(sweepTx.outputs.length, 1);
  assert.equal(BigInt(sweep.total) + BigInt(sweep.fee), 151n * value);
  for (const index of [0, 75, 150]) assert.ok(verifySchnorr(Buffer.from(sweepTx.inputs[index].witness[0], 'hex'), signatureHash(sweepTx, spent, index), owner.publicKey));
  assert.equal(JSON.stringify(sweep).includes(mnemonic), false);
  assert.equal(JSON.stringify(sweep).includes(owner.privateKey.toString('hex')), false);
  console.log(JSON.stringify({ success: true, source: target.endsWith('.asar') ? 'ASAR' : 'source',
    inputs: result.payment.selected.length, feeDeductedSweep: true, elapsedMs: result.elapsedMs, heartbeats: result.heartbeats, cancellation: result.cancellation }));
} finally {
  owner.privateKey.fill(0);
  await closeElectronTest(application);
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.ok(path.basename(profile).startsWith('connectwallet-ui-payment-worker-'));
  await rm(profile, { recursive: true, force: true });
}
