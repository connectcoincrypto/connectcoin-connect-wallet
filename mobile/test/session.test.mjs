import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import { MAINNET_GENESIS } from '../src/model.mjs';
import { WatchSession, publicError } from '../src/session.mjs';

// Public curve points and local promises only; no native bridge or network.
const addressFor = point => bech32m.encode('cc', [1, ...bech32m.toWords(point.toBytes(true).slice(1))]);
const ADDRESS = addressFor(secp256k1.Point.BASE);
const OTHER = addressFor(secp256k1.Point.BASE.double());
const hash = n => n.toString(16).padStart(64, '0');
const tip = (height = 200) => ({ chain: 'main', genesis_hash: MAINNET_GENESIS, height,
  hash: hash(height), mediantime: 1700000000 + height });
const pending = (id = 1) => ({ txid: hash(id), status: 'pending', block_height: null, block_hash: null,
  confirmations: 0, received: '10000000000', spent: '0', balance_delta: '10000000000' });
const confirmed = (id = 1, height = 200) => ({ ...pending(id), status: 'confirmed',
  block_height: height, block_hash: hash(height), confirmations: 1 });
function reply(method, params, { block = tip(), items = [pending()], cursor = null } = {}) {
  if (method === 'getchaintip') return structuredClone(block);
  if (method === 'getaddressbalance') return { address: params.address, tip: structuredClone(block), unit: 'connects',
    confirmed: '10000000000', immature: '0', available_confirmed: '10000000000', pending_received: '10000000000',
    pending_spent: '0', pending_delta: '10000000000', total: '20000000000' };
  if (method === 'getaddresshistory') return { address: params.address, tip: structuredClone(block), unit: 'connects',
    live: true, items: structuredClone(items), next_cursor: cursor };
  throw new Error(`Unexpected fixture method: ${method}`);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('The expected fixture state was not reached');
}
function fixture({ query = reply, cancelAll } = {}) {
  const calls = [], snapshots = [];
  let cancellations = 0;
  const session = new WatchSession({
    query: async (method, params) => {
      calls.push({ method, params: structuredClone(params) });
      return query(method, params);
    },
    cancelAll: () => { cancellations++; return cancelAll ? cancelAll() : Promise.resolve(); },
    onChange: state => snapshots.push(structuredClone(state)),
  });
  return { session, calls, snapshots, get cancellations() { return cancellations; } };
}

test('watch verifies the chain first and publishes a complete validated snapshot', async () => {
  const f = fixture();
  assert.equal(await f.session.watch(ADDRESS.toUpperCase()), true);
  assert.deepEqual(f.calls.map(call => call.method), ['getchaintip', 'getaddressbalance', 'getaddresshistory']);
  assert.deepEqual(f.calls.map(call => call.params), [{}, { address: ADDRESS }, { address: ADDRESS }]);
  assert.equal(f.cancellations, 1);
  assert.equal(f.session.state.address, ADDRESS);
  assert.deepEqual(f.session.state.tip, tip());
  assert.equal(f.session.state.balance.total, '20000000000');
  assert.deepEqual(f.session.state.history, [pending()]);
  assert.equal(f.session.state.busy, false);
  assert.equal(f.session.state.stale, false);
  assert.equal(f.session.state.error, '');
  assert.ok(Number.isSafeInteger(f.session.state.updatedAt));
  assert.ok(f.snapshots.some(state => state.busy && state.balance === null));
  assert.equal(f.snapshots.filter(state => state.balance !== null).length, 1);
});

test('full refresh replaces the list, so an evicted pending transaction disappears', async () => {
  let items = [pending(1), pending(2)];
  const f = fixture({ query: (method, params) => reply(method, params, { items }) });
  await f.session.watch(ADDRESS);
  items = [confirmed(2)];
  assert.equal(await f.session.refresh(), true);
  assert.deepEqual(f.session.state.history, [confirmed(2)]);
  assert.equal(f.session.state.error, '');
});

test('same-tip pagination passes the cursor and replaces duplicate txids with incoming state', async () => {
  const f = fixture({ query: (method, params) => reply(method, params, params.cursor
    ? { items: [confirmed(1), pending(3)] }
    : { items: [pending(1), pending(2)], cursor: 'first.signature' }) });
  await f.session.watch(ADDRESS);
  assert.equal(await f.session.refresh({ more: true }), true);
  assert.equal(f.calls.at(-1).params.cursor, 'first.signature');
  assert.deepEqual(f.session.state.history, [pending(2), pending(3), confirmed(1)]);
  assert.equal(f.session.state.cursor, null);
  const count = f.calls.length;
  assert.equal(await f.session.refresh({ more: true }), false);
  assert.equal(f.calls.length, count);
});

test('a tip change before pagination invalidates its cursor without requesting page data', async () => {
  let block = tip();
  const f = fixture({ query: (method, params) => reply(method, params, { block, cursor: 'first.signature' }) });
  await f.session.watch(ADDRESS);
  const previous = structuredClone(f.session.state);
  block = tip(201);
  assert.equal(await f.session.refresh({ more: true }), false);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls.at(-1).method, 'getchaintip');
  assert.equal(f.session.state.cursor, null);
  assert.equal(f.session.state.stale, true);
  assert.equal(f.session.state.busy, false);
  assert.deepEqual(f.session.state.history, previous.history);
  assert.deepEqual(f.session.state.balance, previous.balance);
  assert.match(f.session.state.error, /History changed/);
});

test('a tip changing between concurrent balance/history requests preserves the previous snapshot', async () => {
  let drift = false;
  const f = fixture({ query: (method, params) => reply(method, params,
    { block: drift && method === 'getaddressbalance' ? tip(201) : tip(), cursor: 'first.signature' }) });
  await f.session.watch(ADDRESS);
  const previous = structuredClone(f.session.state);
  drift = true;
  assert.equal(await f.session.refresh(), false);
  assert.deepEqual(f.session.state.balance, previous.balance);
  assert.deepEqual(f.session.state.history, previous.history);
  assert.deepEqual(f.session.state.tip, previous.tip);
  assert.equal(f.session.state.updatedAt, previous.updatedAt);
  assert.equal(f.session.state.stale, true);
  assert.equal(f.session.state.cursor, null);
  assert.match(f.session.state.error, /History changed/);
});

test('same hash with contradictory height or median time invalidates pagination before page queries', async () => {
  for (const metadata of [{ height: 201 }, { mediantime: tip().mediantime + 1 }]) {
    let block = tip();
    const f = fixture({ query: (method, params) => reply(method, params, { block, cursor: 'first.signature' }) });
    await f.session.watch(ADDRESS);
    const previous = structuredClone(f.session.state);
    block = { ...tip(), ...metadata };
    assert.equal(await f.session.refresh({ more: true }), false);
    assert.equal(f.calls.length, 4);
    assert.equal(f.calls.at(-1).method, 'getchaintip');
    assert.equal(f.session.state.cursor, null);
    assert.equal(f.session.state.stale, true);
    assert.deepEqual(f.session.state.tip, previous.tip);
    assert.deepEqual(f.session.state.balance, previous.balance);
    assert.deepEqual(f.session.state.history, previous.history);
    assert.match(f.session.state.error, /History changed/);
  }
});

test('same hash with contradictory snapshot height or median time cannot publish balance or history', async () => {
  for (const methodWithDrift of ['getaddressbalance', 'getaddresshistory']) {
    for (const metadata of [{ height: 201 }, { mediantime: tip().mediantime + 1 }]) {
      let drift = false;
      const f = fixture({ query: (method, params) => reply(method, params, {
        block: drift && method === methodWithDrift ? { ...tip(), ...metadata } : tip(), cursor: 'first.signature',
      }) });
      await f.session.watch(ADDRESS);
      const previous = structuredClone(f.session.state);
      drift = true;
      assert.equal(await f.session.refresh(), false);
      assert.deepEqual(f.session.state.tip, previous.tip);
      assert.deepEqual(f.session.state.balance, previous.balance);
      assert.deepEqual(f.session.state.history, previous.history);
      assert.equal(f.session.state.updatedAt, previous.updatedAt);
      assert.equal(f.session.state.cursor, null);
      assert.equal(f.session.state.stale, true);
      assert.equal(f.session.state.busy, false);
      assert.match(f.session.state.error, /History changed/);
    }
  }
});

test('malformed or forged address, amount, history and network results never publish', async () => {
  const attacks = [
    (method, result) => method === 'getchaintip' ? { ...result, chain: 'testnet4' } : result,
    (method, result) => method === 'getaddressbalance' ? { ...result, address: OTHER } : result,
    (method, result) => method === 'getaddressbalance' ? { ...result, total: '999999999999999999999' } : result,
    (method, result) => method === 'getaddressbalance' ? { ...result, total: '0' } : result,
    (method, result) => method === 'getaddresshistory' ? { ...result, items: [{ ...pending(), received: '<script>' }] } : result,
    (method, result) => method === 'getaddresshistory' ? { ...result, items: [pending(), pending()] } : result,
  ];
  for (const attack of attacks) {
    const f = fixture({ query: (method, params) => attack(method, reply(method, params)) });
    assert.equal(await f.session.watch(ADDRESS), false);
    assert.equal(f.session.state.balance, null);
    assert.equal(f.session.state.tip, null);
    assert.deepEqual(f.session.state.history, []);
    assert.equal(f.session.state.busy, false);
    assert.doesNotMatch(f.session.state.error, /<script>|999999/);
    assert.ok(f.session.state.error);
  }
});

test('a failed refresh never partly publishes a valid balance beside invalid history', async () => {
  let fail = false;
  const f = fixture({ query: (method, params) => {
    const result = reply(method, params);
    if (fail && method === 'getaddresshistory') result.items[0].txid = 'invalid';
    return result;
  } });
  await f.session.watch(ADDRESS);
  const previous = structuredClone(f.session.state);
  fail = true;
  assert.equal(await f.session.refresh(), false);
  assert.deepEqual(f.session.state.balance, previous.balance);
  assert.deepEqual(f.session.state.history, previous.history);
  assert.equal(f.session.state.updatedAt, previous.updatedAt);
  assert.equal(f.session.state.stale, true);
});

test('a late response or rejection from an old address cannot replace the new address', async () => {
  for (const rejectOld of [false, true]) {
    const gate = deferred();
    const f = fixture({ query: (method, params) => method === 'getaddressbalance' && params.address === ADDRESS
      ? gate.promise : reply(method, params) });
    const old = f.session.watch(ADDRESS);
    await until(() => f.calls.length === 3);
    assert.equal(await f.session.watch(OTHER), true);
    const published = structuredClone(f.session.state);
    if (rejectOld) gate.reject(new Error('<script>old address failed</script>'));
    else gate.resolve(reply('getaddressbalance', { address: ADDRESS }));
    assert.equal(await old, false);
    assert.deepEqual(f.session.state, published);
    assert.equal(f.session.state.address, OTHER);
    assert.equal(f.session.state.error, '');
  }
});

test('forget cancels in-flight work and late data cannot restore a removed address', async () => {
  const gate = deferred();
  const f = fixture({ query: (method, params) => method === 'getaddresshistory' ? gate.promise : reply(method, params) });
  const work = f.session.watch(ADDRESS);
  await until(() => f.calls.length === 3);
  f.session.forget();
  gate.resolve(reply('getaddresshistory', { address: ADDRESS }));
  assert.equal(await work, false);
  assert.equal(f.cancellations, 2);
  assert.deepEqual(f.session.state, { address: '', balance: null, tip: null, history: [], cursor: null,
    busy: false, error: '', updatedAt: null, stale: false });
  assert.equal(await f.session.refresh(), false);
});

test('pause or offline invalidates pending responses; resume performs no automatic request', async () => {
  for (const changed of [{ active: false }, { connected: false }]) {
    const gate = deferred();
    let hold = false;
    const f = fixture({ query: (method, params) => hold && method === 'getaddressbalance' ? gate.promise : reply(method, params) });
    await f.session.watch(ADDRESS);
    const before = structuredClone(f.session.state);
    hold = true;
    const work = f.session.refresh();
    await until(() => f.calls.length === 6);
    f.session.setEnvironment(changed);
    assert.equal(f.session.state.busy, false);
    assert.equal(f.session.state.stale, true);
    assert.equal(await f.session.refresh(), false);
    gate.resolve(reply('getaddressbalance', { address: ADDRESS }));
    assert.equal(await work, false);
    assert.deepEqual(f.session.state.balance, before.balance);
    assert.equal(f.session.state.updatedAt, before.updatedAt);
    const count = f.calls.length;
    f.session.setEnvironment({ active: true, connected: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, count);
    hold = false;
    assert.equal(await f.session.refresh(), true);
    assert.equal(f.session.state.stale, false);
  }
});

test('concurrent refresh clicks cannot schedule another pass while tip or page work is pending', async () => {
  const tipGate = deferred(), historyGate = deferred();
  const f = fixture({ query: (method, params) => method === 'getchaintip' ? tipGate.promise
    : method === 'getaddresshistory' ? historyGate.promise : reply(method, params) });
  const work = f.session.watch(ADDRESS);
  await until(() => f.calls.length === 1);
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => f.session.refresh())), new Array(20).fill(false));
  assert.equal(f.calls.length, 1);
  tipGate.resolve(tip());
  await until(() => f.calls.length === 3);
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => f.session.refresh())), new Array(20).fill(false));
  assert.equal(f.calls.length, 3);
  assert.equal(f.session.state.balance, null);
  historyGate.resolve(reply('getaddresshistory', { address: ADDRESS }));
  assert.equal(await work, true);
  assert.equal(f.session.state.busy, false);
});

test('quota failures surface a safe message and are not retried automatically', async () => {
  for (const code of ['RATE_LIMIT', -32029, '-32029']) {
    const f = fixture({ query: async () => { throw Object.assign(new Error('<script>RPC attacker message</script>'), { code }); } });
    assert.equal(await f.session.watch(ADDRESS), false);
    assert.match(f.session.state.error, /Too many requests/);
    assert.equal(f.session.state.busy, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 1);
    assert.equal(f.session.state.balance, null);
  }
  assert.doesNotMatch(publicError(new Error('<script>hostile</script>')), /script|hostile/);
  assert.match(publicError({ code: '-32001' }), /node is not ready/);
  assert.match(publicError({ code: 'UNAVAILABLE' }), /Android app/);
});

test('two initial watch calls with delayed cancellation query only the final address', async () => {
  const cancellation = deferred();
  let first = true;
  const f = fixture({ cancelAll: () => {
    if (first) { first = false; return cancellation.promise; }
    return Promise.resolve();
  } });
  const old = f.session.watch(ADDRESS);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.session.watch(OTHER), true);
  cancellation.resolve();
  assert.equal(await old, false);
  assert.equal(f.session.state.address, OTHER);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => !call.params.address || call.params.address === OTHER));
});

test('forget or pause before initial cancellation finishes prevents any startup query', async () => {
  for (const action of ['forget', 'pause']) {
    const cancellation = deferred();
    const f = fixture({ cancelAll: () => cancellation.promise });
    const work = f.session.watch(ADDRESS);
    if (action === 'forget') f.session.forget();
    else f.session.setEnvironment({ active: false });
    cancellation.resolve();
    assert.equal(await work, false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.session.state.balance, null);
    assert.equal(f.session.state.busy, false);
  }
});

test('an invalid address cannot replace the current public profile or trigger RPC', async () => {
  const f = fixture();
  await f.session.watch(ADDRESS);
  const before = structuredClone(f.session.state);
  const count = f.calls.length;
  await assert.rejects(f.session.watch('not a valid address'), /valid ConnectCoin mainnet/);
  assert.deepEqual(f.session.state, before);
  assert.equal(f.calls.length, count);
});

test('a repeated pagination cursor is discarded and requires a full refresh without merging its page', async () => {
  const f = fixture({ query: (method, params) => reply(method, params, {
    cursor: 'same.signature', items: params.cursor ? [pending(3)] : [pending(1)],
  }) });
  await f.session.watch(ADDRESS);
  const before = structuredClone(f.session.state.history);
  assert.equal(await f.session.refresh({ more: true }), false);
  assert.deepEqual(f.session.state.history, before);
  assert.equal(f.session.state.stale, true);
  assert.equal(f.session.state.cursor, null);
  assert.match(f.session.state.error, /History changed/);
  const count = f.calls.length;
  assert.equal(await f.session.refresh({ more: true }), false);
  assert.equal(f.calls.length, count);
  assert.equal(await f.session.refresh(), true);
  assert.equal(f.calls.at(-1).params.cursor, undefined);
  assert.equal(f.session.state.stale, false);
  assert.equal(f.session.state.error, '');
});

test('pagination stops at the 2000-row display limit without issuing a fifth page', async () => {
  let page = 0;
  const f = fixture({ query: (method, params) => {
    if (method !== 'getaddresshistory') return reply(method, params);
    const start = page++ * 500;
    return reply(method, params, { items: Array.from({ length: 500 }, (_, i) => pending(start + i)), cursor: `page${page}.signature` });
  } });
  assert.equal(await f.session.watch(ADDRESS), true);
  for (let i = 0; i < 3; i++) assert.equal(await f.session.refresh({ more: true }), true);
  assert.equal(f.session.state.history.length, 2000);
  assert.equal(f.session.state.cursor, null);
  const count = f.calls.length;
  assert.equal(await f.session.refresh({ more: true }), false);
  assert.equal(f.calls.length, count);
  assert.equal(page, 4);
});
