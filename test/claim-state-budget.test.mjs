import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaimsEngine } from '../src/core/claims-engine.mjs';
import { claimConnectionStopCount, isP2CClaimConnectionLimitExceeded, MAX_P2C_SUCCESSFUL_CONNECTIONS } from '../src/core/claim-priority.mjs';

const hex = value => value.toString(16).padStart(64, '0');
const engine = options => new ClaimsEngine({ prepare: async () => {}, submit: async () => {}, isUnlocked: () => true, ...options });
const bounty = target => ({ txid: '1'.repeat(64), vout: 0, amount: '1000000000', domain: 'example.com', status: 'available',
  connection_work_target: target, root_certificates_version: 1, signature_algorithms_mask: 7 });

test('precomputed budget matches the independent multiplication predicate at exact 257-bit and uint64 boundaries', () => {
  const max = MAX_P2C_SUCCESSFUL_CONNECTIONS, space = 1n << 257n;
  const targets = [0n, (1n << 256n) - 1n, space / max - 1n, space / max, space / (max - 1n)];
  for (let bit = 0n; bit <= 256n; bit++) targets.push((1n << bit) - 1n);
  let random = 0x781c3f26n;
  for (let index = 0; index < 512; index++) {
    random = (random * 6364136223846793005n + 1442695040888963407n) & ((1n << 256n) - 1n);
    targets.push(random);
  }
  for (const target of targets) {
    const encoded = hex(target), stop = claimConnectionStopCount(encoded);
    assert.ok(stop > 0n && stop <= max);
    const floor = space / (target + 1n);
    for (const count of [0n, 1n, 2n, stop - 1n, stop, stop + 1n, max - 1n, max, max + 1n, floor, floor + 1n]) {
      assert.equal(count >= stop, isP2CClaimConnectionLimitExceeded(encoded, count), `${encoded}:${count}`);
    }
  }
  assert.equal(claimConnectionStopCount('f'.repeat(64)), 3n, 'equality at two captures remains eligible');
  assert.equal(claimConnectionStopCount('0'.repeat(64)), max, 'tiny target stops only at uint64 saturation');
});

test('precomputed budget rejects noncanonical targets instead of accepting a cached invalid value', () => {
  for (const value of [null, 1, {}, 'f'.repeat(63), 'f'.repeat(65), 'F'.repeat(64), 'g'.repeat(64), ` ${'0'.repeat(63)}`]) {
    assert.throws(() => claimConnectionStopCount(value), /Invalid claim work target/);
  }
});

test('engine caches each work target and invalidates only when that target changes', () => {
  const value = engine(), job = { bounty: bounty('f'.repeat(64)) };
  let writes = 0, cached;
  Object.defineProperty(job, 'connectionStopCount', { get: () => cached, set: value => { writes++; cached = value; } });
  for (let count = 0n; count < 1000n; count++) assert.equal(value.connectionBudgetExceeded(job, count), count >= 3n);
  assert.equal(writes, 1);
  job.bounty.connection_work_target = '0'.repeat(64);
  assert.equal(value.connectionBudgetExceeded(job, MAX_P2C_SUCCESSFUL_CONNECTIONS - 1n), false);
  assert.equal(value.connectionBudgetExceeded(job, MAX_P2C_SUCCESSFUL_CONNECTIONS), true);
  assert.equal(writes, 2);
  assert.equal(value.connectionBudgetExceeded(job, 1), false, 'safe numeric counts keep reference-predicate compatibility');
  for (const count of [-1n, -1, 1.5, NaN, '1', null]) assert.throws(() => value.connectionBudgetExceeded(job, count), /Invalid successful connection count/);
  job.bounty.connection_work_target = 'bad';
  assert.throws(() => value.connectionBudgetExceeded(job, 0n), /Invalid claim work target/);
  assert.throws(() => value.connectionBudgetExceeded({ bounty: {} }, 0n), /Invalid claim work target/);
});

test('out-of-order raw captures never reopen a cached budget; validation and TCP failures do not reserve it', () => {
  const value = engine(), job = { bounty: bounty('f'.repeat(64)) }, key = `${job.bounty.txid}:0`;
  for (const [count, expected, blocked] of [[2n, 2n, false], [1n, 2n, false], [3n, 3n, true], [2n, 3n, true]]) {
    value.observe({ job }, { captured: true, successfulConnections: String(count), validationPassed: false });
    assert.equal(value.successCounts.get(key), expected);
    assert.equal(job.budgetExceeded, blocked);
  }
  value.observe({ job }, { captured: false, validationPassed: false });
  assert.equal(value.successCounts.get(key), 3n);
  const request = { job };
  value.observe(request, { captured: true, successfulConnections: String(MAX_P2C_SUCCESSFUL_CONNECTIONS) });
  value.observe({ job }, { captured: true });
  assert.equal(value.successCounts.get(key), MAX_P2C_SUCCESSFUL_CONNECTIONS);
  assert.throws(() => value.observe(request, { captured: true }), /Duplicate connection observation/);
});
