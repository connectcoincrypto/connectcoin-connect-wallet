import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIndexedClaimStatus } from '../src/core/claim-receipt.mjs';
import { GENESIS } from '../src/core/config.mjs';

const txid = 'a'.repeat(64), block = 'b'.repeat(64);
const tip = { height: 10, hash: 'c'.repeat(64), mediantime: 1800000000, chain: 'main', genesis_hash: GENESIS.main };
const pending = () => ({ tip: { ...tip }, txid, status: 'pending', confirmations: 0 });
const confirmed = () => ({ ...pending(), status: 'confirmed', confirmations: 3, block_height: 8, block_hash: block });
const window = { tip, blocks: [{ height: 10, hash: tip.hash }, { height: 8, hash: block }] };
const validate = value => validateIndexedClaimStatus(value, txid, 'main', window);

test('compact receipts validate identity and exact pending/confirmed location without remote witness', () => {
  assert.doesNotThrow(() => validate(pending()));
  assert.doesNotThrow(() => validate(confirmed()));
});

for (const [name, mutate] of [
  ['wrong txid', r => { r.txid = 'd'.repeat(64); }],
  ['missing txid', r => { delete r.txid; }],
  ['wrong network', r => { r.tip.genesis_hash = 'd'.repeat(64); }],
  ['unknown status', r => { r.status = 'missing'; }],
  ['missing count', r => { delete r.confirmations; }],
  ['negative count', r => { r.confirmations = -1; }],
  ['string count', r => { r.confirmations = '3'; }],
  ['wrong count', r => { r.confirmations = 4; }],
  ['wrong block', r => { r.block_hash = 'd'.repeat(64); }],
  ['future block', r => { r.block_height = 11; r.confirmations = 1; }],
  ['fractional block', r => { r.block_height = 8.5; }],
  ['wrong tip block', r => { r.block_height = 10; r.confirmations = 1; }],
  ['wrong genesis block', r => { r.block_height = 0; r.confirmations = 11; }],
]) test(`compact receipt rejects ${name}`, () => {
  const value = confirmed(); mutate(value); assert.throws(() => validate(value));
});

for (const extra of [{ confirmations: 1 }, { block_hash: block }, { block_height: 0 }, { block_hash: null }]) {
  test(`pending receipt rejects contradictory ${JSON.stringify(extra)}`, () => assert.throws(() => validate({ ...pending(), ...extra })));
}
