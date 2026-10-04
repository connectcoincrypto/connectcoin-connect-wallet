import assert from 'node:assert/strict';
import test from 'node:test';
import { hash256 } from '../src/core/crypto.mjs';
import { MAX_MONEY, parseTransaction, serializeTransaction, transactionId, transactionIdFromRaw } from '../src/core/transaction.mjs';

// Public secp256k1 generator, not a wallet key.
const publicKey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const input = { txid: '12'.repeat(32), vout: 3, scriptSig: '', sequence: 0xfffffffd, witness: [] };
const p2pk = { type: 1, amount: '100000000', publicKey };
const p2c = { type: 2, amount: '100000000', domain: 'example.com', target: 'ff'.repeat(32), rootVersion: 1, mask: 7 };
function transaction(outputs = [p2pk], inputs = [input]) { return { version: 2, inputs, outputs, locktime: 0 }; }
function raw(tx) { return serializeTransaction(tx).toString('hex'); }
function hashStripped(bytes) { return hash256(bytes).reverse().toString('hex'); }

test('raw funding identity matches canonical P2PK/P2C transactions with and without witness', () => {
  for (const outputs of [[p2pk], [p2c], [p2pk, p2c]]) for (const witnessed of [false, true]) {
    const tx = transaction(outputs, [{ ...input, witness: witnessed ? ['02' + '00'.repeat(65535)] : [] },
      { ...input, vout: 4, witness: witnessed ? ['11'.repeat(64), ''] : [] }]);
    const encoded = raw(tx);
    assert.equal(transactionIdFromRaw(encoded), transactionId(tx));
    assert.equal(transactionIdFromRaw(encoded), transactionId(parseTransaction(encoded)));
  }
});

test('identity strips only witness and retains every base byte', () => {
  const tx = transaction([p2pk, p2c], [{ ...input, scriptSig: 'abcd', witness: ['01'.repeat(64)] }]);
  const expected = transactionIdFromRaw(raw(tx));
  tx.inputs[0].witness = ['02'.repeat(64)];
  assert.equal(transactionIdFromRaw(raw(tx)), expected);
  for (const mutate of [value => value.version++, value => value.locktime++, value => value.inputs[0].sequence--,
    value => value.inputs[0].vout++, value => { value.inputs[0].scriptSig = 'ab'; },
    value => { value.outputs[0].amount = '100000001'; }, value => { value.outputs[1].mask = 6; }]) {
    const changed = structuredClone(tx); mutate(changed);
    assert.notEqual(transactionIdFromRaw(raw(changed)), expected);
  }
});

test('raw identity rejects truncated/trailing/oversized and noncanonical wire framing', () => {
  const encoded = raw(transaction());
  for (let size = 0; size < encoded.length; size += 2) assert.throws(() => transactionIdFromRaw(encoded.slice(0, size)));
  for (const malformed of [undefined, '', 'zz', encoded + '00', encoded.slice(0, -1), '00'.repeat(4_000_001),
    encoded.slice(0, 8) + 'fd0100' + encoded.slice(10), // overlong input count
    encoded.slice(0, 92) + 'fd0100' + encoded.slice(94), // overlong output count
    encoded.slice(0, 8) + '00' + encoded.slice(10),
    encoded.slice(0, 8) + 'fd1127' + encoded.slice(10), // 10,001 inputs
    encoded.slice(0, 92) + 'fd1127' + encoded.slice(94), // 10,001 outputs
    encoded.slice(0, 92) + '00' + encoded.slice(94),
  ]) assert.throws(() => transactionIdFromRaw(malformed));
  const duplicate = encoded.slice(0, 8) + '02' + encoded.slice(10, 92).repeat(2) + encoded.slice(92);
  assert.throws(() => transactionIdFromRaw(duplicate), /Duplicate/);
  const emptyWitness = encoded.slice(0, 8) + '0001' + encoded.slice(8, -8) + '00' + encoded.slice(-8);
  assert.throws(() => transactionIdFromRaw(emptyWitness), /Superfluous/);
  assert.throws(() => transactionIdFromRaw(emptyWitness.slice(0, 10) + '02' + emptyWitness.slice(12)), /witness flag/);
  const witnessPrefix = encoded.slice(0, 8) + '0001' + encoded.slice(8, -8);
  for (const witness of ['65', 'fd0100', '01fe01000100', '01fd010000', '0200']) {
    assert.throws(() => transactionIdFromRaw(witnessPrefix + witness + encoded.slice(-8)), /CompactSize|Truncated/);
  }
  for (const scriptLength of ['fd0000', 'fd1127']) {
    assert.throws(() => transactionIdFromRaw(encoded.slice(0, 82) + scriptLength + encoded.slice(84)), /CompactSize/);
  }
});

test('raw identity retains amount, native output, domain, root and mask bounds', () => {
  const base = Buffer.from(raw(transaction()), 'hex');
  const unknownOutput = Buffer.from(base); unknownOutput[55] = 3;
  assert.throws(() => transactionIdFromRaw(unknownOutput.toString('hex')), /output type/);
  for (const value of [-1n, MAX_MONEY + 1n]) {
    const invalid = Buffer.from(base); invalid.writeBigInt64LE(value, 47);
    assert.throws(() => transactionIdFromRaw(invalid.toString('hex')), /money range/);
  }
  const highOutput = Buffer.from(base.subarray(47, 88)); highOutput.writeBigInt64LE(MAX_MONEY);
  const totalOverflow = Buffer.concat([base.subarray(0, 46), Buffer.from([2]), highOutput, highOutput, base.subarray(-4)]);
  assert.throws(() => transactionIdFromRaw(totalOverflow.toString('hex')), /Total transaction outputs exceed/);
  const domainBase = Buffer.from(raw(transaction([p2c])), 'hex');
  const domainOffset = domainBase.indexOf(Buffer.from('example.com'));
  for (const edit of [buffer => { buffer[domainOffset] = 0xff; }, buffer => { buffer[domainOffset] = 0x2e; },
    buffer => buffer.writeUInt32LE(0, domainOffset + p2c.domain.length + 32),
    buffer => { buffer[domainOffset + p2c.domain.length + 36] = 8; }]) {
    const invalid = Buffer.from(domainBase); edit(invalid);
    assert.throws(() => transactionIdFromRaw(invalid.toString('hex')));
  }
});

test('raw identity is deliberately not a replacement for semantic public-key validation', () => {
  const invalidPoint = Buffer.from(raw(transaction()), 'hex'); invalidPoint.fill(0xff, 56, 88);
  assert.equal(transactionIdFromRaw(invalidPoint.toString('hex')), hashStripped(invalidPoint));
  assert.throws(() => parseTransaction(invalidPoint.toString('hex')));
});

test('large funding identity processes 10,000 native outputs without curve parsing', () => {
  const output = Buffer.from('010000000000000001' + publicKey, 'hex');
  const one = Buffer.from(raw(transaction()), 'hex');
  const bytes = Buffer.concat([one.subarray(0, 46), Buffer.from('fd1027', 'hex'), ...Array(10000).fill(output), one.subarray(-4)]);
  assert.equal(transactionIdFromRaw(bytes.toString('hex')), hashStripped(bytes));
});
