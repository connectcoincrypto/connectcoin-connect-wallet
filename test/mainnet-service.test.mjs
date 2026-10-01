import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { WalletService } from '../src/core/wallet-service.mjs';
import { GENESIS } from '../src/core/config.mjs';
import { deriveAccount, verifySchnorr } from '../src/core/crypto.mjs';
import { createVault } from '../src/core/vault.mjs';
import { VAULT_NAME } from '../src/core/profile-paths.mjs';
import { COIN, parseTransaction, serializeTransaction, signatureHash, transactionId } from '../src/core/transaction.mjs';

const mnemonic = `${'abandon '.repeat(11)}about`; // Public BIP39 vector only.
const password = 'isolated-mainnet-test-password';
const tip = { chain: 'main', genesis_hash: GENESIS.main, height: 100, hash: 'ab'.repeat(32), mediantime: 1800000000 };

test('mainnet signs locally with coin-0 keys and rejects a wrong chain or genesis before mock broadcast', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'connectwallet-mainnet-test-'));
  const owner = deriveAccount(mnemonic, { network: 'main' });
  const recipient = deriveAccount(mnemonic, { network: 'main', index: 1 });
  const testnet = deriveAccount(mnemonic, { network: 'testnet4' });
  const funding = { version: 2, inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff, scriptSig: '0101', sequence: 0xffffffff, witness: [] }],
    outputs: [{ type: 1, amount: (10n * COIN).toString(), publicKey: owner.publicKey }], locktime: 0 };
  const raw = serializeTransaction(funding).toString('hex');
  const broadcasts = [];
  let currentTip = tip;
  class Backend extends EventEmitter {
    close() {}
    async request(method, params) {
      if (method === 'getchaintip') return currentTip;
      assert.equal(method, 'sendrawtransaction', 'Every RPC call stays inside this in-memory fixture');
      broadcasts.push(params.transaction_hex);
      return { txid: transactionId(parseTransaction(params.transaction_hex)) };
    }
  }
  const service = new WalletService({ directory, clientFactory: () => new Backend(),
    proofRunner: async () => { assert.fail('Mainnet mock tests must never run a TLS proof helper'); } });
  t.after(async () => {
    await service.close();
    for (const account of [owner, recipient, testnet]) account.privateKey.fill(0);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('connectwallet-mainnet-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  await createVault(join(directory, VAULT_NAME), { name: 'Isolated mainnet fixture', mnemonic, network: 'main', passphrase: '',
    receiveIndex: 0, changeIndex: 0, lastUsedReceive: -1, lastUsedChange: -1, needsRecovery: false }, password);
  await service.initialize();
  // Keep automatic reads inside the fixture; ensureNetwork below remains real.
  service.liveUpdates.start = () => {};
  service.refresh = async () => service.getState();
  service.funding = async () => raw;
  await service.unlock({ password });
  assert.equal(service.config.network, 'main');
  assert.equal(service.config.claims.enabled, false);
  assert.equal(service.engine.enabled, false);
  assert.equal(service.getState().wallet.address, owner.address);
  assert.match(owner.address, /^cc1/);
  assert.equal(owner.path, "m/44'/0'/0'/0/0");
  assert.equal(service.publicAccount(0, 1).address, derivePublicChange());
  const backup = await service.getRecoveryPhrase({ password });
  assert.equal(backup.path, "m/44'/0'/0'/change/index");
  assert.equal(backup.network, 'main');
  assert.throws(() => service.parsePaymentRequest({ uri: `connectcoin:${testnet.address}` }), /different network/);
  service.utxos = [{ txid: transactionId(funding), vout: 0, amount: funding.outputs[0].amount,
    status: 'confirmed', mature: true, account: { index: 0, change: 0 } }];
  for (const invalid of [{ ...tip, chain: 'testnet4' }, { ...tip, genesis_hash: GENESIS.testnet4 }]) {
    currentTip = invalid;
    const preview = await service.previewSend({ address: recipient.address, amount: '1' });
    await assert.rejects(service.confirmSend({ previewId: preview.previewId }), /unexpected network/);
    assert.deepEqual(broadcasts, []);
    assert.equal(service.session.data.changeIndex, 0);
  }
  currentTip = tip;
  const preview = await service.previewSend({ address: recipient.address, amount: '1' });
  const signed = parseTransaction(service.preview.hex);
  assert.equal(signed.outputs[0].publicKey, recipient.publicKey);
  assert.equal(verifySchnorr(Buffer.from(signed.inputs[0].witness[0], 'hex'), signatureHash(signed, funding.outputs, 0), owner.publicKey), true);
  assert.deepEqual(await service.confirmSend({ previewId: preview.previewId }), { txid: preview.txid, status: 'submitted' });
  assert.equal(broadcasts.length, 1);
  assert.equal(service.session.data.changeIndex, 1);
});

function derivePublicChange() {
  const account = deriveAccount(mnemonic, { network: 'main', change: 1 });
  try { assert.equal(account.path, "m/44'/0'/0'/1/0"); return account.address; }
  finally { account.privateKey.fill(0); }
}
