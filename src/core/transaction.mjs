// Native ConnectCoin transactions: typed outputs, 10 decimal places, Schnorr.
// This is deliberately NOT Bitcoin transaction serialization or BIP86 signing.
import { domainToASCII } from 'node:url';
import { decodeAddress, hash256, publicKeyFromPrivate, sha256, signSchnorr, taggedHash, validatePublicKey } from './crypto.mjs';

export const COIN = 10_000_000_000n;
export const MAX_MONEY = 100_000_000n * COIN;
export const DEFAULT_FEE_RATE = 1500; // integer connects/vbyte, NOT CONN or sat/vbyte
export const MAX_PROOF_SIZE = 65536;
// 1,738 native P2PK inputs plus one P2PK output fit Core's 400,000-weight
// standard transaction limit. Larger output sets are checked exactly below.
export const MAX_PAYMENT_INPUTS = 1738;
// Bound text sent to the signing worker before structured cloning. Count hex
// characters (ASCII bytes), including repeated legacy per-input parents.
export const MAX_PAYMENT_PARENT_HEX_BYTES = 64 * 1024 * 1024;
const MAX_PAYMENT_WEIGHT = 400_000;
const MAX_TX_BYTES = 4_000_000;
const MAX_INPUTS = 10000;
const MAX_OUTPUTS = 10000;

export function amountInConnects(value) {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value))) throw new Error('Amounts must be exact integer strings in connects');
  const amount = BigInt(value);
  if (amount < 0n || amount > MAX_MONEY) throw new Error('Amount is outside the ConnectCoin money range');
  return amount;
}
export function parseCoinAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,10})?$/.test(value)) throw new Error('Enter a CONN amount with at most 10 decimal places');
  const [whole, decimal = ''] = value.split('.');
  return amountInConnects(BigInt(whole) * COIN + BigInt(decimal.padEnd(10, '0')));
}
export function formatCoinAmount(value) {
  const amount = amountInConnects(value);
  const decimal = (amount % COIN).toString().padStart(10, '0').replace(/0+$/, '');
  return `${amount / COIN}${decimal ? `.${decimal}` : ''}`;
}
function hexBytes(value, size, label = 'hexadecimal data') {
  if (typeof value !== 'string' || value.length % 2 || !/^[0-9a-f]*$/i.test(value) || (size !== undefined && value.length !== size * 2)) throw new Error(`Invalid ${label}`);
  return Buffer.from(value, 'hex');
}
function u32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Invalid unsigned 32-bit integer');
  const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes;
}
function i64(value) { const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(amountInConnects(value)); return bytes; }
export function compactSize(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TX_BYTES) throw new Error('CompactSize is outside local safety bounds');
  if (value < 253) return Buffer.from([value]);
  if (value <= 65535) { const bytes = Buffer.alloc(3); bytes[0] = 253; bytes.writeUInt16LE(value, 1); return bytes; }
  return Buffer.concat([Buffer.from([254]), u32(value)]);
}
function variable(bytes) { return Buffer.concat([compactSize(bytes.length), bytes]); }
export function normalizeDomain(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\s/:@?#\\]/.test(value)) throw new Error('Use a domain name, not a URL');
  const domain = domainToASCII(value.trim().toLowerCase());
  if (!isCanonicalDomain(domain)) throw new Error('Invalid domain name');
  return domain;
}
function isCanonicalDomain(domain) {
  return typeof domain === 'string' && domain.length >= 1 && domain.length <= 253 && /^[a-z0-9.-]+$/.test(domain) && domain.split('.').every(label => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}
export function workTargetForExpectedConnections(expected) {
  if ((typeof expected !== 'string' || !/^[1-9][0-9]{0,76}$/.test(expected)) && typeof expected !== 'bigint') throw new Error('Expected connections must be a positive integer string');
  const count = BigInt(expected);
  if (count < 1n || count > (1n << 256n)) throw new Error('Expected connections is out of range');
  return (((1n << 256n) / count) - 1n).toString(16).padStart(64, '0');
}
function transactionPublicKey(value, publicKeys) {
  // A successful curve lift is immutable for these exact 32 bytes. Reuse it
  // only within this bounded transaction operation; malformed or changed keys
  // still pass through the complete validator before they can be cached.
  const key = typeof value === 'string' && value.length === 64 ? value.toLowerCase()
    : value instanceof Uint8Array && value.length === 32 ? Buffer.from(value).toString('hex') : null;
  if (key !== null && publicKeys?.has(key)) return publicKeys.get(key);
  const validated = validatePublicKey(value);
  if (publicKeys && publicKeys.size < MAX_OUTPUTS) publicKeys.set(validated.toString('hex'), validated);
  return validated;
}
function outputPayloadWithKeys(output, publicKeys) {
  if (output.type === 1) return Buffer.concat([Buffer.from([1]), transactionPublicKey(output.publicKey, publicKeys)]);
  if (output.type === 2) {
    if (!isCanonicalDomain(output.domain)) throw new Error('Noncanonical P2C domain');
    if (!Number.isInteger(output.rootVersion) || output.rootVersion < 1 || output.rootVersion > 0xffffffff) throw new Error('Invalid P2C root bundle version');
    if (!Number.isInteger(output.mask) || output.mask < 1 || output.mask > 7) throw new Error('Invalid P2C signature mask');
    return Buffer.concat([Buffer.from([2, output.domain.length]), Buffer.from(output.domain, 'ascii'), hexBytes(output.target, 32, 'P2C work target').reverse(), u32(output.rootVersion), Buffer.from([output.mask])]);
  }
  throw new Error('Unknown or invalid ConnectCoin output type');
}
export function outputPayload(output) { return outputPayloadWithKeys(output); }
function serializeOutputWithKeys(output, publicKeys) { return Buffer.concat([i64(output.amount), outputPayloadWithKeys(output, publicKeys)]); }
export function serializeOutput(output) { return serializeOutputWithKeys(output); }
function outpoint(input) { return Buffer.concat([hexBytes(input.txid, 32, 'transaction ID').reverse(), u32(input.vout)]); }
function validateShape(tx) {
  u32(tx.version); u32(tx.locktime);
  if (!Array.isArray(tx.inputs) || tx.inputs.length < 1 || tx.inputs.length > MAX_INPUTS || !Array.isArray(tx.outputs) || tx.outputs.length < 1 || tx.outputs.length > MAX_OUTPUTS) throw new Error('Invalid transaction input/output count');
  let total = 0n;
  for (const output of tx.outputs) { total += amountInConnects(output.amount); if (total > MAX_MONEY) throw new Error('Total transaction outputs exceed money range'); }
  const seen = new Set();
  for (const input of tx.inputs) {
    const key = outpoint(input).toString('hex');
    if (seen.has(key)) throw new Error('Duplicate transaction input');
    seen.add(key);
    if (hexBytes(input.scriptSig ?? '').length > 10000 || !Array.isArray(input.witness ?? []) || (input.witness ?? []).length > 100) throw new Error('Oversized input script or witness stack');
  }
}
function serializeTransactionWithKeys(tx, { witness = true } = {}, publicKeys) {
  validateShape(tx);
  const hasWitness = witness && tx.inputs.some(input => (input.witness ?? []).length > 0);
  const parts = [u32(tx.version), ...(hasWitness ? [Buffer.from([0, 1])] : []), compactSize(tx.inputs.length)];
  for (const input of tx.inputs) parts.push(outpoint(input), variable(hexBytes(input.scriptSig ?? '')), u32(input.sequence));
  parts.push(compactSize(tx.outputs.length), ...tx.outputs.map(output => serializeOutputWithKeys(output, publicKeys)));
  if (hasWitness) for (const input of tx.inputs) {
    parts.push(compactSize((input.witness ?? []).length));
    for (const item of input.witness ?? []) {
      const data = hexBytes(item);
      if (data.length > MAX_PROOF_SIZE) throw new Error('Oversized witness element');
      parts.push(variable(data));
    }
  }
  parts.push(u32(tx.locktime));
  const result = Buffer.concat(parts);
  if (result.length > MAX_TX_BYTES) throw new Error('Transaction exceeds local size limit');
  return result;
}
export function serializeTransaction(tx, options) { return serializeTransactionWithKeys(tx, options, new Map()); }
export function transactionId(tx) { return hash256(serializeTransaction(tx, { witness: false })).reverse().toString('hex'); }
export function transactionVsize(tx) {
  const base = serializeTransaction(tx, { witness: false }).length;
  return Math.ceil((base * 3 + serializeTransaction(tx).length) / 4);
}
class Reader {
  constructor(data) { this.data = data; this.offset = 0; }
  take(size) { if (!Number.isSafeInteger(size) || size < 0 || size > this.data.length - this.offset) throw new Error('Truncated transaction'); const result = this.data.subarray(this.offset, this.offset + size); this.offset += size; return result; }
  byte() { return this.take(1)[0]; }
  uint() { return this.take(4).readUInt32LE(); }
  count(max = MAX_TX_BYTES) {
    const marker = this.byte();
    const result = marker < 253 ? marker : marker === 253 ? this.take(2).readUInt16LE() : marker === 254 ? this.uint() : this.take(8).readBigUInt64LE();
    if ((marker === 253 && result < 253) || (marker === 254 && result <= 65535) || marker === 255 || result > max) throw new Error('Noncanonical or oversized CompactSize');
    return result;
  }
  blob(max) { return this.take(this.count(max)); }
}
/**
 * Check bounded, canonical wire framing and hash the witness-stripped bytes.
 * This is an identity check for cached funding, NOT a semantic/ownership check:
 * unlike parseTransaction(), it deliberately does not lift public keys onto the
 * curve. Signing must still use verifyFunding() on the full original bytes.
 */
export function transactionIdFromRaw(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_TX_BYTES * 2) throw new Error('Transaction exceeds local size limit');
  const reader = new Reader(hexBytes(raw));
  const version = reader.take(4);
  let inputStart = reader.offset;
  let count = reader.count(MAX_INPUTS), witnessed = false;
  if (count === 0) {
    if (reader.byte() !== 1) throw new Error('Unknown transaction witness flag');
    witnessed = true; inputStart = reader.offset; count = reader.count(MAX_INPUTS);
  }
  if (count < 1 || count > (reader.data.length - reader.offset) / 41) throw new Error('Invalid transaction input count');
  const seen = new Set();
  for (let index = 0; index < count; index++) {
    const outpoint = reader.take(36).toString('hex');
    if (seen.has(outpoint)) throw new Error('Duplicate transaction input');
    seen.add(outpoint);
    reader.blob(10000); reader.take(4);
  }
  const outputCount = reader.count(MAX_OUTPUTS);
  if (outputCount < 1 || outputCount > (reader.data.length - reader.offset) / 9) throw new Error('Invalid transaction output count');
  let total = 0n;
  for (let index = 0; index < outputCount; index++) {
    total += amountInConnects(reader.take(8).readBigInt64LE());
    if (total > MAX_MONEY) throw new Error('Total transaction outputs exceed money range');
    const type = reader.byte();
    if (type === 1) reader.take(32);
    else if (type === 2) {
      const domain = reader.take(reader.byte());
      if (domain.some(byte => byte > 127)) throw new Error('Non-ASCII P2C domain');
      if (!isCanonicalDomain(domain.toString('ascii'))) throw new Error('Noncanonical P2C domain');
      reader.take(32);
      if (reader.uint() < 1) throw new Error('Invalid P2C root bundle version');
      const mask = reader.byte();
      if (mask < 1 || mask > 7) throw new Error('Invalid P2C signature mask');
    } else throw new Error('Unknown or invalid ConnectCoin output type');
  }
  const outputsEnd = reader.offset;
  let hasWitness = false;
  if (witnessed) for (let index = 0; index < count; index++) {
    const items = reader.count(100);
    hasWitness ||= items > 0;
    for (let item = 0; item < items; item++) reader.blob(MAX_PROOF_SIZE);
  }
  if (witnessed && !hasWitness) throw new Error('Superfluous witness record');
  const locktime = reader.take(4);
  if (reader.offset !== reader.data.length) throw new Error('Trailing transaction data');
  const stripped = witnessed ? Buffer.concat([version, reader.data.subarray(inputStart, outputsEnd), locktime]) : reader.data;
  return hash256(stripped).reverse().toString('hex');
}
function parseTransactionWithKeys(raw, publicKeys) {
  if (typeof raw !== 'string' || raw.length > MAX_TX_BYTES * 2) throw new Error('Transaction exceeds local size limit');
  const reader = new Reader(hexBytes(raw));
  const version = reader.uint();
  let count = reader.count(MAX_INPUTS);
  let witnessed = false;
  if (count === 0) { if (reader.byte() !== 1) throw new Error('Unknown transaction witness flag'); witnessed = true; count = reader.count(MAX_INPUTS); }
  if (count < 1 || count > (reader.data.length - reader.offset) / 41) throw new Error('Invalid transaction input count');
  const inputs = [];
  for (let index = 0; index < count; index++) inputs.push({ txid: Buffer.from(reader.take(32)).reverse().toString('hex'), vout: reader.uint(), scriptSig: reader.blob(10000).toString('hex'), sequence: reader.uint(), witness: [] });
  const outputCount = reader.count(MAX_OUTPUTS);
  if (outputCount < 1 || outputCount > (reader.data.length - reader.offset) / 9) throw new Error('Invalid transaction output count');
  const outputs = [];
  for (let index = 0; index < outputCount; index++) {
    const amount = amountInConnects(reader.take(8).readBigInt64LE()).toString();
    const type = reader.byte();
    if (type === 1) outputs.push({ type, amount, publicKey: transactionPublicKey(reader.take(32), publicKeys).toString('hex') });
    else if (type === 2) {
      const domainBytes = reader.take(reader.byte());
      if (domainBytes.some(byte => byte > 127)) throw new Error('Non-ASCII P2C domain');
      const domain = domainBytes.toString('ascii');
      const target = Buffer.from(reader.take(32)).reverse().toString('hex');
      const output = { type, amount, domain, target, rootVersion: reader.uint(), mask: reader.byte() };
      outputPayload(output); outputs.push(output);
    } else throw new Error('Unknown or invalid ConnectCoin output type');
  }
  if (witnessed) for (const input of inputs) {
    const items = reader.count(100);
    for (let index = 0; index < items; index++) input.witness.push(reader.blob(MAX_PROOF_SIZE).toString('hex'));
  }
  if (witnessed && !inputs.some(input => input.witness.length)) throw new Error('Superfluous witness record');
  const tx = { version, inputs, outputs, locktime: reader.uint() };
  if (reader.offset !== reader.data.length) throw new Error('Trailing transaction data');
  if (!serializeTransactionWithKeys(tx, undefined, publicKeys).equals(reader.data)) throw new Error('Noncanonical transaction encoding');
  return tx;
}
export function parseTransaction(raw) { return parseTransactionWithKeys(raw, new Map()); }
function checkFundingOutput(utxo, expectedPublicKey, funding, fundingId) {
  if (!utxo || typeof utxo !== 'object') throw new Error('Missing funding output');
  hexBytes(utxo.txid, 32, 'funding transaction ID');
  if (fundingId !== utxo.txid.toLowerCase()) throw new Error('Funding transaction ID does not match its bytes');
  if (!Number.isInteger(utxo.vout) || utxo.vout < 0 || utxo.vout >= funding.outputs.length) throw new Error('Funding output does not exist');
  const output = funding.outputs[utxo.vout];
  if (amountInConnects(output.amount) !== amountInConnects(utxo.amount)) throw new Error('RPC funding amount does not match the original transaction');
  if (expectedPublicKey !== undefined && (output.type !== 1 || output.publicKey !== validatePublicKey(expectedPublicKey).toString('hex'))) throw new Error('Funding output is not owned by this wallet key');
  return output;
}
export function verifyFunding(utxo, expectedPublicKey) {
  if (!utxo || typeof utxo !== 'object') throw new Error('Missing funding output');
  hexBytes(utxo.txid, 32, 'funding transaction ID');
  const funding = parseTransaction(utxo.rawTransaction);
  return checkFundingOutput(utxo, expectedPublicKey, funding, transactionId(funding));
}
/** Cheap pre-clone limits; full raw framing, identity and ownership stay local. */
export function validatePaymentFundingPayload(input) {
  if (!Array.isArray(input?.utxos) || input.utxos.length < 1 || input.utxos.length > MAX_PAYMENT_INPUTS) throw new Error('Invalid payment input count');
  let hexBytes = 0;
  const countRaw = raw => {
    if (typeof raw !== 'string' || raw.length < 2 || raw.length > MAX_TX_BYTES * 2 || raw.length % 2) throw new Error('Invalid funding transaction bytes');
    hexBytes += raw.length;
    if (hexBytes > MAX_PAYMENT_PARENT_HEX_BYTES) throw new Error('Payment funding data exceeds the local memory limit; use fewer inputs');
  };
  const validId = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
  const parents = new Map();
  if (input.parents !== undefined) {
    if (!Array.isArray(input.parents) || input.parents.length < 1 || input.parents.length > MAX_PAYMENT_INPUTS) throw new Error('Invalid funding parent count');
    for (const parent of input.parents) {
      if (!validId(parent?.txid)) throw new Error('Invalid funding transaction ID');
      const id = parent.txid.toLowerCase();
      if (parents.has(id)) throw new Error('Duplicate funding parent');
      countRaw(parent.hex); parents.set(id, parent.hex);
    }
  }
  for (const utxo of input.utxos) {
    if (!validId(utxo?.txid)) throw new Error('Invalid funding transaction ID');
    const parent = parents.get(utxo.txid.toLowerCase());
    if (utxo.rawTransaction !== undefined) {
      countRaw(utxo.rawTransaction);
      if (parent !== undefined && parent !== utxo.rawTransaction) throw new Error('Conflicting funding transaction bytes');
    } else if (parent === undefined) throw new Error('Missing funding parent');
  }
  return parents;
}
function paymentSignatureHashes(tx, spentOutputs) {
  validateShape(tx);
  if (!Array.isArray(spentOutputs) || spentOutputs.length !== tx.inputs.length) throw new Error('All spent outputs are required for signing');
  // BIP341-style SIGHASH_DEFAULT with native typed locks (not Script encodings).
  // Snapshot the common digest once. This cache is private to one synchronous
  // signing operation, never retained across a transaction/output mutation.
  const prefix = Buffer.concat([
    Buffer.from([0, 0]), u32(tx.version), u32(tx.locktime),
    sha256(Buffer.concat(tx.inputs.map(outpoint))),
    sha256(Buffer.concat(spentOutputs.map(output => i64(output.amount)))),
    sha256(Buffer.concat(spentOutputs.map(outputPayload))),
    sha256(Buffer.concat(tx.inputs.map(input => u32(input.sequence)))),
    sha256(Buffer.concat(tx.outputs.map(serializeOutput))),
    Buffer.from([0]),
  ]);
  const inputCount = tx.inputs.length;
  return index => {
    if (!Number.isInteger(index) || index < 0 || index >= inputCount) throw new Error('All spent outputs are required for signing');
    return taggedHash('TapSighash', Buffer.concat([prefix, u32(index)]));
  };
}
export function signatureHash(tx, spentOutputs, index) { return paymentSignatureHashes(tx, spentOutputs)(index); }
export function dustThreshold(output) {
  const spend = output.type === 2 ? 41 + Math.ceil((1 + 5 + MAX_PROOF_SIZE) / 4) : 58;
  return BigInt((serializeOutput(output).length + spend) * 3);
}
function recipientOutput(output, network) {
  const amount = amountInConnects(output.amount).toString();
  const result = output.address ? { type: 1, amount, publicKey: decodeAddress(output.address, network).toString('hex') } : {
    type: 2, amount, domain: normalizeDomain(output.domain), target: output.target ?? workTargetForExpectedConnections(output.expectedConnections ?? '1'), rootVersion: output.rootVersion ?? 1, mask: output.mask ?? 7,
  };
  if (result.type === 2 && result.rootVersion !== 1) throw new Error('This wallet supports immutable root bundle version 1 only');
  if (BigInt(amount) < dustThreshold(result)) throw new Error('Recipient amount is below the relay dust threshold');
  return result;
}
function checkedFeeRate(value) {
  if (!Number.isSafeInteger(value) || value < 1201 || value > 1_000_000) throw new Error('Fee rate must be 1,201–1,000,000 connects per vbyte');
  return BigInt(value);
}
function paymentPlan({ utxos, outputs, changeAddress, network = 'testnet4', feeRate = DEFAULT_FEE_RATE, maxFee = COIN.toString(), subtractFeeFromAmount = false }) {
  const rate = checkedFeeRate(feeRate);
  const maximumFee = amountInConnects(maxFee);
  if (typeof subtractFeeFromAmount !== 'boolean') throw new Error('Deduct fees from payment must be a boolean');
  if (!Array.isArray(utxos) || utxos.length < 1 || utxos.length > MAX_PAYMENT_INPUTS || !Array.isArray(outputs) || outputs.length < 1 || outputs.length > 100) throw new Error('Invalid payment input/output count');
  if (subtractFeeFromAmount && outputs.length !== 1) throw new Error('Deduct fees from payment requires exactly one recipient');
  const recipients = outputs.map(output => recipientOutput(output, network));
  const requestedTotal = recipients.reduce((sum, output) => sum + BigInt(output.amount), 0n);
  amountInConnects(requestedTotal);
  let total = requestedTotal;
  const changeKey = decodeAddress(changeAddress, network).toString('hex');
  const changeOutput = { type: 1, amount: '0', publicKey: changeKey };
  const sorted = utxos.map(utxo => ({ utxo, amount: amountInConnects(utxo.amount) }))
    .sort((a, b) => {
      // Fee-deducted payments can spend an exact coin without a change output.
      // Choosing a larger coin first can make its extra fee consume a small
      // recipient even though the exact coin funds a valid payment.
      if (subtractFeeFromAmount && (a.amount === requestedTotal) !== (b.amount === requestedTotal)) return a.amount === requestedTotal ? -1 : 1;
      return a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0;
    });
  const selected = [];
  const seen = new Set();
  const tx = { version: 2, inputs: [], outputs: recipients, locktime: 0 };
  const recipientBytes = recipients.reduce((sum, output) => sum + serializeOutput(output).length, 0);
  const changeBytes = serializeOutput(changeOutput).length;
  const changeDust = dustThreshold(changeOutput);
  // Every payment input is native P2PK: 41 base bytes and a 66-byte Schnorr
  // witness. Account for both CompactSize boundaries and marker/flag exactly,
  // without serializing all preceding inputs for every selection candidate.
  const estimateWeight = withChange => {
    const count = tx.inputs.length;
    const base = 8 + compactSize(count).length + 41 * count +
      compactSize(recipients.length + Number(withChange)).length + recipientBytes + (withChange ? changeBytes : 0);
    return base * 4 + 2 + 66 * count;
  };
  const estimateVsize = withChange => Math.ceil(estimateWeight(withChange) / 4);
  let inputTotal = 0n;
  let fee;
  let change = 0n;
  for (const { utxo, amount } of sorted) {
    const fundingKey = outpoint(utxo).toString('hex');
    if (seen.has(fundingKey)) throw new Error('Duplicate funding output');
    seen.add(fundingKey); selected.push(utxo);
    inputTotal += amount; amountInConnects(inputTotal);
    tx.inputs.push({ txid: utxo.txid, vout: utxo.vout, scriptSig: '', sequence: 0xfffffffd, witness: ['00'.repeat(64)] });
    // Reject an oversized plan before reading parents or creating signatures.
    if (estimateWeight(false) > MAX_PAYMENT_WEIGHT) throw new Error('Payment exceeds the standard transaction weight limit; use fewer inputs');
    if (subtractFeeFromAmount) {
      if (inputTotal < requestedTotal) continue;
      const remainder = inputTotal - requestedTotal;
      change = remainder === 0n ? 0n : remainder < changeDust ? changeDust : remainder;
      if (estimateWeight(change > 0n) > MAX_PAYMENT_WEIGHT) throw new Error('Payment exceeds the standard transaction weight limit; use fewer inputs');
      fee = rate * BigInt(estimateVsize(change > 0n));
      // Do not turn tiny change into a surprise additional miner fee. Keep it
      // spendable by subtracting its dust shortfall from the sole recipient.
      total = requestedTotal - fee - (change - remainder);
      if (total <= 0n || total < dustThreshold(recipients[0])) throw new Error('Recipient amount after deducting the fee is below the relay dust threshold');
      tx.outputs = [{ ...recipients[0], amount: total.toString() },
        ...(change > 0n ? [{ ...changeOutput, amount: change.toString() }] : [])];
      break;
    }
    tx.outputs = [...recipients, changeOutput];
    const withChangeFee = rate * BigInt(estimateVsize(true));
    const candidateChange = inputTotal - total - withChangeFee;
    if (candidateChange >= changeDust) {
      if (estimateWeight(true) > MAX_PAYMENT_WEIGHT) throw new Error('Payment exceeds the standard transaction weight limit; use fewer inputs');
      change = candidateChange; tx.outputs[tx.outputs.length - 1] = { ...changeOutput, amount: change.toString() }; fee = withChangeFee; break;
    }
    tx.outputs = recipients;
    const noChangeFee = rate * BigInt(estimateVsize(false));
    if (inputTotal >= total + noChangeFee) { fee = inputTotal - total; break; }
  }
  if (fee === undefined) throw new Error('Insufficient verified funds for this payment and its fee');
  if (fee > maximumFee) throw new Error('Transaction fee exceeds the wallet safety limit');
  return { selected, tx, fee: fee.toString(), total: total.toString(), requestedTotal: requestedTotal.toString(), subtractFeeFromAmount,
    inputTotal: inputTotal.toString(), change: change.toString(), vsize: estimateVsize(change > 0n) };
}
/** Select candidates using public metadata only; this does NOT verify funding. */
export function selectPaymentFunding(options) {
  const { tx, ...selection } = paymentPlan(options);
  return selection;
}
export function buildPayment(options) {
  const { selected, tx, ...payment } = paymentPlan(options);
  // Metadata is untrusted until the amount and ownership match the raw parent.
  // Verify every selected output before creating any payment signature.
  // Many outputs can share one large parent. Parse each distinct byte string
  // only once, but repeat txid, vout, amount and ownership checks per input.
  const parents = new Map(), publicKeys = new Map();
  let parentHexBytes = 0;
  const spentOutputs = selected.map(utxo => {
    const raw = utxo.rawTransaction;
    let parent = parents.get(raw);
    if (!parent) {
      if (typeof raw !== 'string') throw new Error('Invalid funding transaction bytes');
      parentHexBytes += raw.length;
      if (parentHexBytes > MAX_PAYMENT_PARENT_HEX_BYTES) throw new Error('Payment funding data exceeds the local memory limit; use fewer inputs');
      const funding = parseTransactionWithKeys(raw, publicKeys);
      const txid = hash256(serializeTransactionWithKeys(funding, { witness: false }, publicKeys)).reverse().toString('hex');
      parent = { funding, txid }; parents.set(raw, parent);
    }
    return checkFundingOutput(utxo, publicKeyFromPrivate(utxo.privateKey), parent.funding, parent.txid);
  });
  const signatureForInput = paymentSignatureHashes(tx, spentOutputs);
  for (let index = 0; index < selected.length; index++) tx.inputs[index].witness = [signSchnorr(signatureForInput(index), selected[index].privateKey).toString('hex')];
  const hex = serializeTransaction(tx).toString('hex');
  if (hex.length > 800_000) throw new Error('Payment exceeds relay size limit');
  if (serializeTransaction(tx, { witness: false }).length * 3 + hex.length / 2 > MAX_PAYMENT_WEIGHT) throw new Error('Payment exceeds the standard transaction weight limit');
  if (transactionVsize(tx) !== payment.vsize) throw new Error('Payment size differs from its fee estimate');
  return { hex, txid: transactionId(tx), ...payment, selected: selected.map(({ txid, vout }) => ({ txid, vout })), transaction: tx };
}
export function claimChallenge(tx, index = 0) {
  if (!Number.isInteger(index) || index < 0 || index >= tx.inputs.length) throw new Error('Claim input index is out of range');
  return taggedHash('ConnectCoin/P2C/claim/v1', Buffer.concat([hexBytes(transactionId(tx), 32).reverse(), u32(index)])).toString('hex');
}
export function estimateClaimFee(feeRate = DEFAULT_FEE_RATE, proofSize = MAX_PROOF_SIZE) {
  checkedFeeRate(feeRate);
  if (!Number.isInteger(proofSize) || proofSize < 1 || proofSize > MAX_PROOF_SIZE) throw new Error('Invalid claim proof size');
  // Fixed one-input/one-output P2PK claim: 92 stripped bytes.
  return (BigInt(Math.ceil((92 * 4 + 2 + 1 + compactSize(proofSize).length + proofSize) / 4)) * BigInt(feeRate)).toString();
}
export function prepareClaim({ bounty, rawTransaction, rewardAddress, fee = estimateClaimFee(), network = 'testnet4', maxFee = COIN.toString() }) {
  const output = verifyFunding({ ...bounty, rawTransaction });
  if (output.type !== 2 || output.rootVersion !== 1) throw new Error('Not a supported P2C bounty');
  for (const [remote, local] of [['domain', 'domain'], ['connection_work_target', 'target'], ['root_certificates_version', 'rootVersion'], ['signature_algorithms_mask', 'mask']]) {
    if (bounty[remote] !== undefined && bounty[remote] !== output[local]) throw new Error(`Bounty ${remote} differs from the funding transaction`);
  }
  const feeAmount = amountInConnects(fee);
  if (feeAmount > amountInConnects(maxFee) || feeAmount >= BigInt(output.amount)) throw new Error('Claim fee exceeds the wallet limit or bounty value');
  const reward = { type: 1, amount: (BigInt(output.amount) - feeAmount).toString(), publicKey: decodeAddress(rewardAddress, network).toString('hex') };
  if (BigInt(reward.amount) < dustThreshold(reward)) throw new Error('Claim reward is below the dust threshold');
  const transaction = { version: 2, inputs: [{ txid: bounty.txid, vout: bounty.vout, scriptSig: '', sequence: 0xffffffff, witness: [] }], outputs: [reward], locktime: 0 };
  const challenge = claimChallenge(transaction);
  return { transaction, hex: serializeTransaction(transaction).toString('hex'), txid: transactionId(transaction), challenge, clienthello_random: challenge, bounty: { ...bounty, ...output }, fee: feeAmount.toString(), payout: reward.amount };
}
export function attachClaimProof(prepared, proofHex) {
  const proof = hexBytes(proofHex);
  if (proof.length < 1 || proof.length > MAX_PROOF_SIZE || proof[0] !== 2) throw new Error('Invalid P2C version-2 proof');
  // Framing and work checks are defense-in-depth, NOT certificate validation.
  // The local TLS helper verifies the chain, signature, domain and profile;
  // consensus validation is still performed by ConnectCoin nodes.
  let offset = 1;
  const messages = [];
  for (const [type, maximum] of [[1, 4096], [2, 2048], [8, 4096], [11, 49152], [15, 8192]]) {
    if (offset + 4 > proof.length || proof[offset] !== type) throw new Error('Invalid P2C handshake sequence');
    const size = proof.readUIntBE(offset + 1, 3) + 4;
    if (size > maximum || offset + size > proof.length) throw new Error('Invalid P2C handshake length');
    messages.push(proof.subarray(offset, offset + size)); offset += size;
  }
  if (offset !== proof.length || messages[0].length < 38 || messages[0].subarray(6, 38).toString('hex') !== prepared.challenge) throw new Error('Proof is not bound to this claim');
  const tx = parseTransaction(prepared.hex);
  if (transactionId(tx) !== prepared.txid || claimChallenge(tx) !== prepared.challenge || tx.inputs.length !== 1 || tx.outputs.length !== 1 || tx.inputs[0].witness.length) throw new Error('Claim proposal was changed after preparing its challenge');
  const work = taggedHash('ConnectCoin/P2C/work/v2', Buffer.concat(messages.slice(0, 4)));
  if (BigInt(`0x${Buffer.from(work).reverse().toString('hex')}`) > BigInt(`0x${prepared.bounty.target}`)) throw new Error('P2C proof does not meet the bounty work target');
  tx.inputs[0].witness = [proofHex];
  return { hex: serializeTransaction(tx).toString('hex'), txid: transactionId(tx), fee: prepared.fee, payout: prepared.payout, transaction: tx };
}
