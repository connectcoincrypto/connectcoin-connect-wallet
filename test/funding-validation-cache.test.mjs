import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTransaction, serializeTransaction, transactionId, transactionIdFromRaw, FundingTransactionCache } from '../src/core/transaction.mjs';
// Public secp256k1 generator point. No secret keys are used in these fixtures.
const publicKey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const receivingAddress = 'cc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqr7enya';
// Golden public fixture generated independently by unchanged ConnectWallet v1.1.5.
const fundingHex = '02000000010000000000000000000000000000000000000000000000000000000000000000ffffffff020101ffffffff0100e40b5402000000020b6578616d706c652e636f6dffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff010000000700000000';
const bounty = {
  txid: 'b34ed54b791ccc26f559081380d0b8590335d1617930810ec72b3c5ac19f8c54',
  vout: 0, amount: '10000000000', domain: 'example.com',
  connection_work_target: 'ff'.repeat(32), root_certificates_version: 1, signature_algorithms_mask: 7,
};
const expectedClaimHex = '0200000001548c9fc15a3c2bc70e81307961d1350359b8d080130859f526cc1c794bd54eb30000000000ffffffff0138bd9252020000000179be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179800000000';

test('funding cache parses the exact parent once while repeating every claim-specific check', t => {
  const cache = new FundingTransactionCache();
  let parentDecodes = 0;
  const from = Buffer.from;
  t.mock.method(Buffer, 'from', function (value, ...args) {
    if (value === fundingHex && args[0] === 'hex') parentDecodes++;
    return from(value, ...args);
  });
  const prepare = overrides => cache.prepareClaim({ bounty, rawTransaction: fundingHex, network: 'main', rewardAddress: receivingAddress, ...overrides });
  assert.equal(cache.transactionId(fundingHex), bounty.txid);
  for (let index = 0; index < 20; index++) assert.equal(prepare().hex, expectedClaimHex);
  assert.equal(parentDecodes, 1, 'Canonical parsing, parent serialization and hashing are reused.');
  for (const override of [
    { txid: '11'.repeat(32) }, { vout: -1 }, { vout: 1 }, { vout: 0.5 }, { amount: '1' }, { domain: 'other.example' },
    { connection_work_target: '00'.repeat(32) }, { root_certificates_version: 2 }, { signature_algorithms_mask: 1 },
  ]) assert.throws(() => prepare({ bounty: { ...bounty, ...override } }));
  for (const fee of ['0.1', '01', '-1', 1500, '10000000000']) assert.throws(() => prepare({ fee }));
  assert.throws(() => prepare({ fee: '2', maxFee: '1' }), /limit/);
  assert.throws(() => prepare({ fee: '9999999999' }), /dust/);
  assert.throws(() => prepare({ network: 'testnet4' }), /network/);
  assert.throws(() => prepare({ network: 'main', rewardAddress: receivingAddress.slice(0, -1) + 'q' }));
  assert.throws(() => cache.verifyFunding({ ...bounty, rawTransaction: fundingHex }, publicKey), /owned/);
  assert.equal(parentDecodes, 1);

  const returned = cache.verifyFunding({ ...bounty, rawTransaction: fundingHex });
  returned.amount = '1'; returned.domain = 'forged.example';
  const prepared = prepare(); prepared.bounty.target = '00'.repeat(32);
  assert.equal(prepare().hex, expectedClaimHex);
  assert.equal(prepare().bounty.target, bounty.connection_work_target);
  assert.throws(() => prepare({ rawTransaction: '00', funding: { outputs: [returned] }, fundingId: bounty.txid }));
  cache.clear();
  assert.equal(cache.size, 0); assert.equal(cache.retainedBytes, 0);
  assert.equal(prepare().hex, expectedClaimHex);
  assert.equal(parentDecodes, 2, 'Epoch clearing requires full validation again.');
});

test('funding cache authenticates each selected output and rejects malformed siblings', () => {
  const cache = new FundingTransactionCache(), funding = parseTransaction(fundingHex);
  funding.outputs.push({ type: 1, amount: '100', publicKey }, { ...funding.outputs[0], amount: '20000000000', domain: 'other.example' });
  const raw = serializeTransaction(funding).toString('hex'), txid = transactionId(funding);
  const selected = { txid, vout: 2, amount: '20000000000', domain: 'other.example' };
  assert.equal(cache.prepareClaim({ bounty: selected, rawTransaction: raw, network: 'main', rewardAddress: receivingAddress }).bounty.domain, 'other.example');
  assert.throws(() => cache.prepareClaim({ bounty: { ...selected, vout: 0 }, rawTransaction: raw, network: 'main', rewardAddress: receivingAddress }), /amount/);
  assert.equal(cache.verifyFunding({ txid, vout: 1, amount: '100', rawTransaction: raw }, publicKey).publicKey, publicKey);
  assert.throws(() => cache.prepareClaim({ bounty: { txid, vout: 1, amount: '100' }, rawTransaction: raw, network: 'main', rewardAddress: receivingAddress }), /supported/);
  const malformed = raw.replace(publicKey, 'ff'.repeat(32));
  const malformedId = transactionIdFromRaw(malformed);
  assert.throws(() => cache.prepareClaim({ bounty: { ...selected, txid: malformedId }, rawTransaction: malformed, network: 'main', rewardAddress: receivingAddress }), /key|point|field/i);
  assert.equal(cache.size, 1, 'Rejected transactions never enter the trusted cache.');
});

test('funding validation cache keys exact witness bytes, not only the stripped txid', () => {
  const cache = new FundingTransactionCache(), funding = parseTransaction(fundingHex);
  funding.inputs[0].witness = ['02'];
  const first = serializeTransaction(funding).toString('hex');
  funding.inputs[0].witness = ['03'];
  const second = serializeTransaction(funding).toString('hex');
  assert.equal(cache.transactionId(first), bounty.txid);
  assert.equal(cache.transactionId(second), bounty.txid);
  assert.equal(cache.size, 2);
  const superfluousWitness = first.slice(0, -14) + '0000000000';
  assert.throws(() => cache.transactionId(superfluousWitness), /Superfluous/);
  for (const malformed of [first + '00', first.slice(0, -2), '02000000fd0100' + fundingHex.slice(10)]) assert.throws(() => cache.transactionId(malformed));
  assert.equal(cache.size, 2);
});

test('funding cache bounds entries and decoded bytes, evicts least recently used parents and declines oversized entries', t => {
  const funding = parseTransaction(fundingHex);
  const raws = [0, 1, 2].map(locktime => serializeTransaction({ ...funding, locktime }).toString('hex'));
  const decodes = new Map(), from = Buffer.from;
  t.mock.method(Buffer, 'from', function (value, ...args) {
    if (raws.includes(value) && args[0] === 'hex') decodes.set(value, (decodes.get(value) ?? 0) + 1);
    return from(value, ...args);
  });
  const bounded = new FundingTransactionCache({ maxEntries: 2 });
  bounded.transactionId(raws[0]); bounded.transactionId(raws[1]); bounded.transactionId(raws[0]); bounded.transactionId(raws[2]);
  assert.equal(bounded.size, 2);
  bounded.transactionId(raws[0]); assert.equal(decodes.get(raws[0]), 1);
  bounded.transactionId(raws[1]); assert.equal(decodes.get(raws[1]), 2);
  const one = new FundingTransactionCache(); one.transactionId(raws[0]);
  const byteBound = one.retainedBytes;
  const limited = new FundingTransactionCache({ maxBytes: byteBound });
  for (const raw of raws) { limited.transactionId(raw); assert.equal(limited.size, 1); assert.ok(limited.retainedBytes <= byteBound); }
  const tooSmall = new FundingTransactionCache({ maxBytes: byteBound - 1 });
  assert.equal(tooSmall.transactionId(raws[0]), bounty.txid);
  assert.equal(tooSmall.size, 0); assert.equal(tooSmall.retainedBytes, 0);
  for (const options of [{ maxEntries: 0 }, { maxEntries: 257 }, { maxBytes: 0 }, { maxBytes: Infinity }]) assert.throws(() => new FundingTransactionCache(options), /bounds/);
});
