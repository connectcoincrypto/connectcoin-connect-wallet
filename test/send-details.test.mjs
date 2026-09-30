import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WalletService } from '../src/core/wallet-service.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';
import { createVault, unlockVault } from '../src/core/vault.mjs';
import { COIN, serializeTransaction, transactionId, parseTransaction } from '../src/core/transaction.mjs';

const mnemonic = 'abandon '.repeat(11) + 'about';
const password = 'local-payment-details-test-only';
const account = deriveAccount(mnemonic); account.privateKey.fill(0);
const funding = { version: 2, inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff, scriptSig: '0101', sequence: 0xffffffff, witness: [] }],
  outputs: [{ type: 1, amount: (10n * COIN).toString(), publicKey: account.publicKey }], locktime: 0 };
const raw = serializeTransaction(funding).toString('hex');
const details = { label: 'Café order', message: 'Private local note\nReference 123' };
const payment = { address: account.address, amount: '1', ...details };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tip = { chain: 'testnet4', height: 5, hash: 'ab'.repeat(32), mediantime: 1800000000, genesis_hash: GENESIS.testnet4 };

async function fixture(t, { durable = false, uncertain = false } = {}) {
  const directory = durable ? await mkdtemp(join(tmpdir(), 'connectwallet-send-details-')) : process.cwd();
  const broadcasts = [], saves = [];
  const service = new WalletService({ directory });
  service.config = structuredClone(DEFAULT_CONFIG);
  service.session = { data: { mnemonic, name: 'Public test wallet', network: 'testnet4', receiveIndex: 0, changeIndex: 0, lastUsedReceive: -1, lastUsedChange: -1 }, password };
  service.walletExists = true;
  service.connectClient = () => {};
  service.liveUpdates = { start() {}, close() {}, updateAddresses() {} };
  service.engine = { enabled: false, async stop() {}, clear() {} };
  service.rpc = { close() {}, async request(method, params) {
    assert.equal(method, 'sendrawtransaction');
    broadcasts.push(params.transaction_hex);
    if (uncertain) throw new Error('untrusted backend canary');
    return { txid: transactionId(parseTransaction(params.transaction_hex)) };
  } };
  await service.buildAccounts();
  service.utxos = [{ txid: transactionId(funding), vout: 0, amount: funding.outputs[0].amount, status: 'confirmed', mature: true, account: { index: 0, change: 0 } }];
  service.refresh = async () => {};
  service.ensureNetwork = async () => { service.tip = tip; return tip; };
  service.funding = async () => raw;
  if (durable) await createVault(service.vaultFile, service.session.data, password);
  else service.persist = async () => { saves.push(structuredClone(service.session.data)); };
  t.after(async () => {
    await service.close();
    if (durable) {
      assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}\\connectwallet-send-details-`) || resolve(directory).startsWith(`${resolve(tmpdir())}/connectwallet-send-details-`));
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { service, broadcasts, saves };
}

test('preview validates and freezes payment details without putting them in transaction bytes', async t => {
  const { service, broadcasts, saves } = await fixture(t);
  const review = await service.previewSend(payment);
  assert.equal(review.label, details.label); assert.equal(review.message, details.message);
  assert.ok(Object.isFrozen(service.preview));
  assert.throws(() => { service.preview.label = 'changed'; }, TypeError);
  const expectedHex = service.preview.hex;
  review.label = 'renderer replacement';
  await service.confirmSend({ previewId: review.previewId, label: 'ignored', message: 'ignored' });
  assert.deepEqual(saves[0].paymentDetails[review.txid], details);
  assert.deepEqual(broadcasts, [expectedHex]);
  assert.ok(!Buffer.from(expectedHex, 'hex').includes(Buffer.from(details.label)));
  assert.ok(!Buffer.from(expectedHex, 'hex').includes(Buffer.from(details.message)));
});

test('invalid payment metadata fails before reading funding or publishing a preview', async t => {
  const { service, broadcasts } = await fixture(t);
  service.refresh = async () => { assert.fail('Invalid details must fail before RPC'); };
  for (const fields of [{ label: 'a'.repeat(101) }, { message: 'a'.repeat(201) }, { label: '\ud800' }, { message: 'a\u0000b' }, { label: null }, { message: {} }, { label: 'a\u202eb' }]) {
    await assert.rejects(service.previewSend({ ...payment, ...fields }), /Label|Message/);
    assert.equal(service.preview, null);
  }
  assert.deepEqual(broadcasts, []);
});

test('a failed encrypted save prevents broadcast and restores the unsaved local fields', async t => {
  const { service, broadcasts } = await fixture(t);
  const review = await service.previewSend(payment);
  service.persist = async () => { throw new Error('Storage failed'); };
  await assert.rejects(service.confirmSend({ previewId: review.previewId }), /Storage failed/);
  assert.deepEqual(broadcasts, []);
  assert.equal(service.session.data.paymentDetails, undefined);
  assert.equal(service.session.data.changeIndex, 0);
});

test('storage capacity never drops old annotations and still allows an unannotated send', async t => {
  const { service, broadcasts } = await fixture(t);
  service.session.data.changeIndex = 9;
  service.session.data.lastUsedChange = 8;
  const persist = service.persist.bind(service);
  service.persist = async () => {
    assert.ok(Buffer.byteLength(JSON.stringify(service.session.data)) <= 65536, 'The real vault byte limit still applies to an unannotated send');
    await persist();
  };
  const prior = {};
  for (let index = 0; Buffer.byteLength(JSON.stringify({ ...service.session.data, paymentDetails: prior })) < 65100; index++) {
    prior[index.toString(16).padStart(64, '0')] = { label: 'a'.repeat(100), message: 'b'.repeat(200) };
  }
  service.session.data.paymentDetails = prior;
  assert.ok(Buffer.byteLength(JSON.stringify(service.session.data)) < 65536, 'Existing notes must fit the actual encrypted vault budget');
  const review = await service.previewSend(payment);
  await assert.rejects(service.confirmSend({ previewId: review.previewId }), /storage is full.*Clear Label and Message.*No transaction was sent/);
  assert.equal(service.session.data.paymentDetails, prior);
  assert.deepEqual(broadcasts, []);
  const plain = await service.previewSend({ address: account.address, amount: '1' });
  await service.confirmSend({ previewId: plain.previewId });
  assert.equal(service.session.data.paymentDetails, prior);
  assert.equal(service.session.data.changeIndex, 10, 'Derivation indexes can still grow across a digit boundary');
  assert.equal(broadcasts.length, 1);
});

for (const uncertain of [false, true]) test(`${uncertain ? 'uncertain' : 'successful'} sends retain encrypted notes after lock, unlock and history refresh`, async t => {
  const { service, broadcasts } = await fixture(t, { durable: true, uncertain });
  const review = await service.previewSend(payment);
  const sending = service.confirmSend({ previewId: review.previewId });
  if (uncertain) await assert.rejects(sending, error => { assert.match(error.message, /Broadcast was not confirmed/); assert.ok(!error.message.includes('canary')); return true; });
  else assert.deepEqual(await sending, { txid: review.txid, status: 'submitted' });
  assert.equal(broadcasts.length, 1);
  const ciphertext = await readFile(service.vaultFile, 'utf8');
  for (const value of [details.label, details.message, mnemonic]) assert.ok(!ciphertext.includes(value));
  assert.deepEqual((await unlockVault(service.vaultFile, password)).paymentDetails[review.txid], details);
  service.history = [{ txid: review.txid, direction: 'sent', amount: '1', status: 'mempool' }];
  assert.equal(service.getState().history[0].label, details.label);
  await service.lock();
  assert.deepEqual(service.getState().history, []);
  assert.ok(!JSON.stringify(service.getState()).includes(details.label));
  await service.unlock({ password });
  assert.deepEqual(service.session.data.paymentDetails[review.txid], details);
  service.rpc.request = async (method, params) => {
    if (method === 'getaddressbalance') return { tip, address: params.address, unit: 'connects', confirmed: '0', available_confirmed: '0', immature: '0', pending_delta: '0' };
    if (method === 'getaddressutxos') return { tip, address: params.address, unit: 'connects', items: [], next_cursor: null };
    if (method === 'getaddresshistory') return { tip, address: params.address, unit: 'connects', items: params.address === account.address ? [{ txid: review.txid, balance_delta: '-10000000000', status: 'confirmed', confirmations: 1, block_height: 5 }] : [], next_cursor: null };
    assert.fail(`Unexpected mock RPC ${method}`);
  };
  await service.refreshInternal(service.epoch);
  assert.equal(service.getState().history[0].status, 'confirmed');
  assert.equal(service.getState().history[0].label, details.label);
  assert.equal(service.getState().history[0].message, details.message);
});

test('locking during the encrypted pre-broadcast save cancels sending and unlock waits for those notes', async t => {
  const { service, broadcasts } = await fixture(t, { durable: true });
  const gate = deferred(), entered = deferred();
  const persist = service.persist.bind(service);
  service.persisting = gate.promise;
  service.persist = () => { const pending = persist(); entered.resolve(); return pending; };
  const review = await service.previewSend(payment);
  const rejected = assert.rejects(service.confirmSend({ previewId: review.previewId }), /locked or changed/);
  await entered.promise;
  await service.lock();
  let unlocked = false;
  const unlocking = service.unlock({ password }).then(() => { unlocked = true; });
  await new Promise(done => setImmediate(done));
  assert.equal(unlocked, false);
  gate.resolve();
  await rejected; await unlocking;
  assert.deepEqual(broadcasts, []);
  assert.deepEqual(service.session.data.paymentDetails[review.txid], details);
});

test('invalid persisted metadata is rejected before opening a session', async t => {
  const { service } = await fixture(t);
  const data = structuredClone(service.session.data);
  await service.lock();
  for (const paymentDetails of [[], null, { invalid: details }, { ['01'.repeat(32)]: { label: 'a'.repeat(101) } }, { ['01'.repeat(32)]: { message: '\ud800' } }]) {
    await assert.rejects(service.openSession({ ...data, paymentDetails }, password), /saved payment details are invalid/);
    assert.equal(service.session, null);
  }
});
