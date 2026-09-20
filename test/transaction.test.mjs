import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAccount, verifySchnorr } from '../src/core/crypto.mjs';
import { COIN, amountInConnects, attachClaimProof, buildPayment, claimChallenge, estimateClaimFee, formatCoinAmount, normalizeDomain, parseCoinAmount, parseTransaction, prepareClaim, serializeTransaction, signatureHash, transactionId, verifyFunding, workTargetForExpectedConnections } from '../src/core/transaction.mjs';

const account = deriveAccount(`${'abandon '.repeat(11)}about`);
const destination = deriveAccount(`${'abandon '.repeat(11)}about`, { index: 1 });
const funding = { version: 2, inputs: [{ txid: '00'.repeat(32), vout: 0xffffffff, scriptSig: '0101', sequence: 0xffffffff, witness: [] }], outputs: [{ type: 1, amount: (10n * COIN).toString(), publicKey: account.publicKey }], locktime: 0 };
const rawTransaction = serializeTransaction(funding).toString('hex');
const utxo = { txid: transactionId(funding), vout: 0, amount: funding.outputs[0].amount, rawTransaction, privateKey: account.privateKey };

test('money keeps exact 10-decimal precision and rejects floats/negative/overflow', () => {
  assert.equal(COIN, 10000000000n);
  assert.equal(parseCoinAmount('0.0000000001'), 1n);
  assert.equal(formatCoinAmount('1'), '0.0000000001');
  assert.equal(parseCoinAmount('1.0000000001'), 10000000001n);
  assert.equal(formatCoinAmount('10000000001'), '1.0000000001');
  assert.equal(formatCoinAmount('10000000000'), '1');
  for (const value of ['-1', '1e3', '0.00000000001', '100000001', '01', 'Infinity', 'NaN', '.1', '1.']) assert.throws(() => parseCoinAmount(value));
  assert.throws(() => amountInConnects(100));
  assert.throws(() => amountInConnects('01'));
});

test('invalid coin amounts identify CONN and its existing decimal precision', () => {
  for (const value of ['1.00000000001', '1 CONN', '1 CC', 1]) {
    assert.throws(() => parseCoinAmount(value), {
      name: 'Error', message: 'Enter a CONN amount with at most 10 decimal places',
    });
  }
});
test('typed outputs roundtrip canonically without Bitcoin Script wire encoding', () => {
  assert.deepEqual(parseTransaction(rawTransaction), funding);
  const byteArray = Buffer.from(rawTransaction, 'hex');
  assert.equal(byteArray[57], 1); // native output type, no script length
  assert.throws(() => parseTransaction(rawTransaction + '00'), /Trailing/);
  assert.throws(() => parseTransaction(rawTransaction.slice(0, -2)), /Truncated/);
  assert.throws(() => parseTransaction('02000000fd0100' + rawTransaction.slice(10)), /CompactSize/);
  assert.throws(() => parseTransaction('020000000002' + rawTransaction.slice(8)), /witness flag/);
});
test('untrusted RPC funding data is cross-checked against raw bytes and local keys', () => {
  assert.deepEqual(verifyFunding(utxo, account.publicKey), funding.outputs[0]);
  assert.throws(() => verifyFunding({ ...utxo, amount: '1' }, account.publicKey), /amount/);
  assert.throws(() => verifyFunding({ ...utxo, txid: 'aa'.repeat(32) }, account.publicKey), /ID/);
  assert.throws(() => verifyFunding(utxo, destination.publicKey), /owned/);
  assert.throws(() => verifyFunding({ ...utxo, vout: 2 }, account.publicKey), /exist/);
});
test('native Schnorr payment spends owned output, commits recipient/change/fee, and has stable txid', () => {
  const args = { utxos: [utxo], outputs: [{ address: destination.address, amount: COIN.toString() }], changeAddress: account.address };
  const result = buildPayment(args);
  const tx = parseTransaction(result.hex);
  assert.equal(tx.outputs[0].amount, COIN.toString());
  assert.equal(tx.outputs[0].publicKey, destination.publicKey);
  assert.equal(tx.inputs[0].witness[0].length, 128);
  assert.equal(BigInt(result.fee) + BigInt(result.total) + BigInt(result.change), 10n * COIN);
  assert.equal(BigInt(result.fee), BigInt(result.vsize * 1500));
  assert.equal(transactionId(tx), result.txid);
  assert.equal(verifySchnorr(Buffer.from(tx.inputs[0].witness[0], 'hex'), signatureHash(tx, [funding.outputs[0]], 0), account.publicKey), true);
  tx.outputs[0].amount = (COIN + 1n).toString();
  assert.equal(verifySchnorr(Buffer.from(tx.inputs[0].witness[0], 'hex'), signatureHash(tx, [funding.outputs[0]], 0), account.publicKey), false);
  assert.throws(() => buildPayment({ ...args, feeRate: 10 }), /Fee rate/);
  assert.throws(() => buildPayment({ ...args, maxFee: '1' }), /fee exceeds/);
  assert.throws(() => buildPayment({ ...args, outputs: [{ address: destination.address, amount: (11n * COIN).toString() }] }), /Insufficient/);
});
test('P2C uses exact target, IDN canonicalization, immutable roots, bound unsigned claim', () => {
  assert.equal(workTargetForExpectedConnections('1'), 'ff'.repeat(32));
  assert.equal(workTargetForExpectedConnections('1024'), '003f' + 'ff'.repeat(30));
  assert.equal(normalizeDomain('EXAMPLE.com'), 'example.com');
  assert.equal(normalizeDomain('bücher.example'), 'xn--bcher-kva.example');
  for (const value of ['https://example.com', 'a..b', 'a.com.', '-a.com']) assert.throws(() => normalizeDomain(value));
  const result = buildPayment({ utxos: [utxo], outputs: [{ domain: 'example.com', amount: COIN.toString(), expectedConnections: '1024' }], changeAddress: account.address });
  const tx = parseTransaction(result.hex);
  const output = tx.outputs[0];
  assert.equal(output.type, 2);
  assert.equal(output.target, workTargetForExpectedConnections('1024'));
  const bounty = { txid: result.txid, vout: 0, amount: output.amount, domain: output.domain };
  const claim = prepareClaim({ bounty, rawTransaction: result.hex, rewardAddress: destination.address });
  assert.equal(claim.transaction.inputs[0].sequence, 0xffffffff);
  assert.equal(claim.challenge, claimChallenge(claim.transaction));
  assert.equal(BigInt(claim.payout) + BigInt(claim.fee), COIN);
  assert.equal(claim.fee, estimateClaimFee());
  const modified = structuredClone(claim.transaction); modified.outputs[0].amount = '1';
  assert.notEqual(claimChallenge(modified), claim.challenge);
  assert.throws(() => prepareClaim({ bounty: { ...bounty, domain: 'evil.com' }, rawTransaction: result.hex, rewardAddress: destination.address }), /differs/);
  assert.throws(() => attachClaimProof(claim, '00'), /version-2/);
  assert.throws(() => attachClaimProof(claim, '02'), /handshake/);
});

test('duplicate inputs, noncanonical domains, fake ownership and excessive fees fail closed', () => {
  const copied = structuredClone(funding);
  copied.inputs.push({ ...copied.inputs[0] });
  assert.throws(() => serializeTransaction(copied), /Duplicate/);
  const args = { utxos: [{ ...utxo, privateKey: destination.privateKey }], outputs: [{ address: destination.address, amount: COIN.toString() }], changeAddress: account.address };
  assert.throws(() => buildPayment(args), /owned/);
  assert.throws(() => buildPayment({ ...args, utxos: [utxo], outputs: [{ domain: 'example.com', amount: COIN.toString(), rootVersion: 2 }] }), /bundle/);
  const p2c = { ...funding, outputs: [{ type: 2, amount: COIN.toString(), domain: 'example.com', target: 'ff'.repeat(32), rootVersion: 1, mask: 7 }] };
  const bytes = serializeTransaction(p2c);
  const at = bytes.indexOf(Buffer.from('example.com'));
  bytes[at] |= 0x80;
  assert.throws(() => parseTransaction(bytes.toString('hex')), /Non-ASCII/);
  assert.throws(() => workTargetForExpectedConnections('0'));
  assert.throws(() => workTargetForExpectedConnections('1.5'));
  assert.throws(() => estimateClaimFee(1500, 65537));
});

test('claim framing/work binding rejects mismatched challenge and immutable proposal mutations', () => {
  const p2c = { ...funding, outputs: [{ type: 2, amount: COIN.toString(), domain: 'example.com', target: 'ff'.repeat(32), rootVersion: 1, mask: 7 }] };
  const proposal = prepareClaim({ bounty: { txid: transactionId(p2c), vout: 0, amount: COIN.toString() }, rawTransaction: serializeTransaction(p2c).toString('hex'), rewardAddress: account.address });
  const record = (type, body) => { const header = Buffer.alloc(4); header[0] = type; header.writeUIntBE(body.length, 1, 3); return Buffer.concat([header, body]); };
  // Minimal framing fixture is NOT a valid certificate/TLS proof. These unit
  // tests cover only attachClaimProof's framing guard; helper tests verify TLS.
  const hello = Buffer.concat([Buffer.from([3, 3]), Buffer.from(proposal.challenge, 'hex')]);
  const fixture = Buffer.concat([Buffer.from([2]), record(1, hello), record(2, Buffer.alloc(0)), record(8, Buffer.alloc(0)), record(11, Buffer.alloc(0)), record(15, Buffer.alloc(0))]);
  const completed = attachClaimProof(proposal, fixture.toString('hex'));
  assert.equal(completed.txid, proposal.txid);
  assert.equal(parseTransaction(completed.hex).inputs[0].witness.length, 1);
  const changedProof = Buffer.from(fixture); changedProof[8] ^= 1;
  assert.throws(() => attachClaimProof(proposal, changedProof.toString('hex')), /bound/);
  assert.throws(() => attachClaimProof({ ...proposal, txid: '11'.repeat(32) }, fixture.toString('hex')), /changed/);
  assert.throws(() => attachClaimProof({ ...proposal, bounty: { ...proposal.bounty, target: '00'.repeat(32) } }, fixture.toString('hex')), /work target/);
});

test.after(() => { account.privateKey.fill(0); destination.privateKey.fill(0); });
