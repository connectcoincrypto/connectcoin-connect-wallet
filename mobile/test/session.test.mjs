import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import { MAINNET_GENESIS, mergeHistory } from '../src/model.mjs';
import { WalletSession, publicError } from '../src/session.mjs';
import { LiveBalance } from '../src/live-balance.mjs';

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
  const session = new WalletSession({
    query: async (method, params) => {
      calls.push({ method, params: structuredClone(params) });
      return query(method, params);
    },
    cancelAll: () => { cancellations++; return cancelAll ? cancelAll() : Promise.resolve(); },
    onChange: state => snapshots.push(structuredClone(state)),
  });
  return { session, calls, snapshots, get cancellations() { return cancellations; } };
}

test('account loading validates the embedded chain tips without a redundant preflight', async () => {
  const f = fixture();
  assert.equal(await f.session.loadAccount(ADDRESS.toUpperCase()), true);
  assert.deepEqual(f.calls.map(call => call.method), ['getaddressbalance', 'getaddresshistory']);
  assert.deepEqual(f.calls.map(call => call.params), [{ address: ADDRESS }, { address: ADDRESS }]);
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
  await f.session.loadAccount(ADDRESS);
  items = [confirmed(2)];
  assert.equal(await f.session.refresh(), true);
  assert.deepEqual(f.session.state.history, [confirmed(2)]);
  assert.equal(f.session.state.error, '');
});

test('same-tip pagination passes the cursor and replaces duplicate txids with incoming state', async () => {
  const f = fixture({ query: (method, params) => reply(method, params, params.cursor
    ? { items: [confirmed(1), pending(3)] }
    : { items: [pending(1), pending(2)], cursor: 'first.signature' }) });
  await f.session.loadAccount(ADDRESS);
  assert.equal(await f.session.refresh({ more: true }), true);
  assert.equal(f.calls.at(-1).params.cursor, 'first.signature');
  assert.deepEqual(f.session.state.history, [pending(2), pending(3), confirmed(1)]);
  assert.equal(f.session.state.cursor, null);
  const count = f.calls.length;
  assert.equal(await f.session.refresh({ more: true }), false);
  assert.equal(f.calls.length, count);
});

test('reloadLoaded validates each physical page and performs only one final accumulated merge', async t => {
  const rows = Array.from({ length: 2000 }, (_, index) => pending(index + 1));
  let pageIndex = 0;
  const f = fixture({ query: (method, params) => {
    if (method !== 'getaddresshistory') return reply(method, params);
    const index = pageIndex++;
    assert.equal(params.cursor, index ? `page${index}.cursor` : undefined);
    return reply(method, params, { items: rows.slice(index * 500, (index + 1) * 500),
      cursor: index < 3 ? `page${index + 1}.cursor` : null });
  } });
  // Model an already paginated view; refreshing must reread all 2000 rows.
  f.session.state = { ...f.session.state, address: ADDRESS, tip: tip(), history: rows };
  const descriptor = Object.getOwnPropertyDescriptor;
  let rowValidations = 0;
  t.mock.method(Object, 'getOwnPropertyDescriptor', (value, key) => {
    const result = descriptor(value, key);
    if (key === 'txid' && typeof result?.value === 'string') rowValidations++;
    return result;
  });
  assert.equal(await f.session.refresh({ reloadLoaded: true }), true);
  assert.equal(rowValidations, 4500); // 2000 physical + 500 initial + 2000 final (formerly 7000).
  assert.deepEqual(f.session.state.history, rows); assert.equal(f.session.state.cursor, null);
  assert.deepEqual(f.calls.map(call => call.method), ['getaddressbalance', ...Array(4).fill('getaddresshistory')]);
});

test('reloadLoaded accumulation matches sequential merge for overlaps, ordering, replacements and final-page overflow', async () => {
  const scenarios = [];
  for (let variant = 0; variant < 24; variant++) {
    const width = variant % 3 === 0 ? 500 : 80;
    const step = variant % 4 === 0 ? 0 : variant % 4 === 1 ? Math.floor(width / 2) : width;
    const pages = Array.from({ length: variant % 3 === 0 ? 6 : 8 }, (_, pageIndex) =>
      Array.from({ length: width }, (_, index) => {
        const id = 1 + pageIndex * step + index;
        const amount = String(1 + pageIndex + index);
        const row = { ...pending(id), received: amount, balance_delta: amount };
        if ((id + pageIndex + variant) % 3) {
          const height = 100 + id % 101;
          Object.assign(row, { status: 'confirmed', block_height: height, block_hash: hash(height), confirmations: 201 - height });
        }
        return row;
      }).sort((a, b) => variant % 2 ? b.txid.localeCompare(a.txid) : a.txid.localeCompare(b.txid)));
    scenarios.push({ pages, wanted: [1, 499, 650, 1200, 2000][variant % 5] });
  }
  // Four overlapping 500-row pages contain 1700 uniques, then 500 reach 2100.
  scenarios.push({ pages: Array.from({ length: 6 }, (_, p) => Array.from({ length: 500 }, (_, i) => pending(p * 400 + i + 1))), wanted: 2000 });
  for (const [index, { pages, wanted }] of scenarios.entries()) {
    let expected = mergeHistory([], pages[0]), consumed = 1;
    while (expected.length < wanted && consumed < pages.length && consumed < 20) {
      expected = mergeHistory(expected, pages[consumed++]);
    }
    let delivered = 0;
    const f = fixture({ query: (method, params) => {
      if (method !== 'getaddresshistory') return reply(method, params);
      const pageIndex = delivered++;
      assert.equal(params.cursor, pageIndex ? `page${pageIndex}.cursor` : undefined);
      return reply(method, params, { items: pages[pageIndex], cursor: pageIndex + 1 < pages.length ? `page${pageIndex + 1}.cursor` : null });
    } });
    f.session.state = { ...f.session.state, address: ADDRESS, tip: tip(), history: Array.from({ length: wanted }, (_, i) => pending(10000 + i)) };
    assert.equal(await f.session.refresh({ reloadLoaded: true }), true, `scenario ${index}`);
    assert.equal(delivered, consumed, `scenario ${index}`);
    assert.deepEqual(f.session.state.history, expected, `scenario ${index}`);
    assert.equal(f.session.state.cursor, expected.length >= 2000 || consumed === pages.length ? null : `page${consumed}.cursor`, `scenario ${index}`);
  }
});

test('reloadLoaded private accumulation never publishes earlier pages after a late malformed page or cancellation', async () => {
  for (const mode of ['malformed', 'cancelled']) {
    let pageIndex = 0;
    const oldRows = Array.from({ length: 1600 }, (_, index) => pending(10000 + index));
    const f = fixture({ query: (method, params) => {
      if (method !== 'getaddresshistory') return reply(method, params);
      const index = pageIndex++;
      const result = reply(method, params, { items: Array.from({ length: 500 }, (_, i) => pending(index * 500 + i + 1)),
        cursor: index < 3 ? `page${index + 1}.cursor` : null });
      if (index === 2) {
        if (mode === 'malformed') result.items[0].balance_delta = '1';
        else void f.session.invalidate();
      }
      return result;
    } });
    const oldBalance = reply('getaddressbalance', { address: ADDRESS });
    f.session.state = { ...f.session.state, address: ADDRESS, tip: tip(), balance: oldBalance,
      history: oldRows, updatedAt: 1234, cursor: 'old.cursor' };
    assert.equal(await f.session.refresh({ reloadLoaded: true }), false);
    assert.equal(pageIndex, 3); assert.equal(f.session.state.history, oldRows); assert.equal(f.session.state.balance, oldBalance);
    assert.equal(f.session.state.updatedAt, 1234);
    assert.ok(f.snapshots.every(snapshot => snapshot.history[0].txid === oldRows[0].txid));
  }
});

test('reloadLoaded rejects an invalid intermediate row before a later valid duplicate could overwrite it', async () => {
  let pageIndex = 0;
  const f = fixture({ query: (method, params) => {
    if (method !== 'getaddresshistory') return reply(method, params);
    const index = pageIndex++;
    if (index === 2) assert.fail('Invalid page must not request its later replacement');
    return reply(method, params, { items: index === 1 ? [{ ...pending(1), balance_delta: '1' }] : [pending(1)],
      cursor: `page${index + 1}.cursor` });
  } });
  const oldRows = [pending(100), pending(101)];
  f.session.state = { ...f.session.state, address: ADDRESS, tip: tip(), history: oldRows };
  assert.equal(await f.session.refresh({ reloadLoaded: true }), false);
  assert.equal(pageIndex, 2); assert.equal(f.session.state.history, oldRows);
});

test('reloadLoaded unique-row accumulation still enforces the twenty-page bound without publication', async () => {
  let pageIndex = 0;
  const f = fixture({ query: (method, params) => {
    if (method !== 'getaddresshistory') return reply(method, params);
    const index = pageIndex++;
    return reply(method, params, { items: [pending(1)], cursor: `page${index + 1}.cursor` });
  } });
  const oldRows = [pending(100), pending(101)];
  f.session.state = { ...f.session.state, address: ADDRESS, tip: tip(), history: oldRows };
  assert.equal(await f.session.refresh({ reloadLoaded: true }), false);
  assert.equal(pageIndex, 20); assert.equal(f.session.state.history, oldRows);
  assert.equal(f.session.state.cursor, null); assert.equal(f.session.state.historyStale, true);
});

test('a tip change before pagination invalidates its cursor without requesting page data', async () => {
  let block = tip();
  const f = fixture({ query: (method, params) => reply(method, params, { block, cursor: 'first.signature' }) });
  await f.session.loadAccount(ADDRESS);
  const previous = structuredClone(f.session.state);
  block = tip(201);
  assert.equal(await f.session.refresh({ more: true }), false);
  assert.equal(f.calls.length, 3);
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
  await f.session.loadAccount(ADDRESS);
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
    await f.session.loadAccount(ADDRESS);
    const previous = structuredClone(f.session.state);
    block = { ...tip(), ...metadata };
    assert.equal(await f.session.refresh({ more: true }), false);
    assert.equal(f.calls.length, 3);
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
      await f.session.loadAccount(ADDRESS);
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
    (method, result) => method === 'getaddressbalance' ? { ...result, tip: { ...result.tip, chain: 'testnet4' } } : result,
    (method, result) => method === 'getaddresshistory' ? { ...result, tip: { ...result.tip, genesis_hash: hash(999) } } : result,
    (method, result) => method === 'getaddressbalance' ? { ...result, address: OTHER } : result,
    (method, result) => method === 'getaddressbalance' ? { ...result, total: '999999999999999999999' } : result,
    (method, result) => method === 'getaddressbalance' ? { ...result, total: '0' } : result,
    (method, result) => method === 'getaddresshistory' ? { ...result, items: [{ ...pending(), received: '<script>' }] } : result,
    (method, result) => method === 'getaddresshistory' ? { ...result, items: [pending(), pending()] } : result,
  ];
  for (const attack of attacks) {
    const f = fixture({ query: (method, params) => attack(method, reply(method, params)) });
    assert.equal(await f.session.loadAccount(ADDRESS), false);
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
  await f.session.loadAccount(ADDRESS);
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
    const old = f.session.loadAccount(ADDRESS);
    await until(() => f.calls.length === 2);
    assert.equal(await f.session.loadAccount(OTHER), true);
    const published = structuredClone(f.session.state);
    if (rejectOld) gate.reject(new Error('<script>old address failed</script>'));
    else gate.resolve(reply('getaddressbalance', { address: ADDRESS }));
    assert.equal(await old, false);
    assert.deepEqual(f.session.state, published);
    assert.equal(f.session.state.address, OTHER);
    assert.equal(f.session.state.error, '');
  }
});

test('clearAccount cancels in-flight work and late data cannot restore a removed address', async () => {
  const gate = deferred();
  const f = fixture({ query: (method, params) => method === 'getaddresshistory' ? gate.promise : reply(method, params) });
  const work = f.session.loadAccount(ADDRESS);
  await until(() => f.calls.length === 2);
  f.session.clearAccount();
  gate.resolve(reply('getaddresshistory', { address: ADDRESS }));
  assert.equal(await work, false);
  assert.equal(f.cancellations, 2);
  assert.deepEqual(f.session.state, { address: '', balance: null, tip: null, history: [], cursor: null,
    historyStale: false, busy: false, error: '', updatedAt: null, stale: false });
  assert.equal(await f.session.refresh(), false);
});

test('pause or offline invalidates pending responses; resume performs no automatic request', async () => {
  for (const changed of [{ active: false }, { connected: false }]) {
    const gate = deferred();
    let hold = false;
    const f = fixture({ query: (method, params) => hold && method === 'getaddressbalance' ? gate.promise : reply(method, params) });
    await f.session.loadAccount(ADDRESS);
    const before = structuredClone(f.session.state);
    hold = true;
    const work = f.session.refresh();
    await until(() => f.calls.length === 4);
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

test('concurrent refresh clicks cannot schedule another pass while balance or page work is pending', async () => {
  const balanceGate = deferred(), historyGate = deferred();
  const f = fixture({ query: (method, params) => method === 'getaddressbalance' ? balanceGate.promise
    : method === 'getaddresshistory' ? historyGate.promise : reply(method, params) });
  const work = f.session.loadAccount(ADDRESS);
  await until(() => f.calls.length === 2);
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => f.session.refresh())), new Array(20).fill(false));
  assert.equal(f.calls.length, 2);
  balanceGate.resolve(reply('getaddressbalance', { address: ADDRESS }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => f.session.refresh())), new Array(20).fill(false));
  assert.equal(f.calls.length, 2);
  assert.equal(f.session.state.balance, null);
  historyGate.resolve(reply('getaddresshistory', { address: ADDRESS }));
  assert.equal(await work, true);
  assert.equal(f.session.state.busy, false);
});

test('quota failures surface a safe message and are not retried automatically', async () => {
  for (const code of ['RATE_LIMIT', -32029, '-32029']) {
    const f = fixture({ query: async () => { throw Object.assign(new Error('<script>RPC attacker message</script>'), { code }); } });
    assert.equal(await f.session.loadAccount(ADDRESS), false);
    assert.match(f.session.state.error, /Too many requests/);
    assert.equal(f.session.state.busy, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 2);
    assert.equal(f.session.state.balance, null);
  }
  assert.doesNotMatch(publicError(new Error('<script>hostile</script>')), /script|hostile/);
  assert.match(publicError({ code: '-32001' }), /node is not ready/);
  assert.match(publicError({ code: 'UNAVAILABLE' }), /mobile app/);
});

test('two initial account loads with delayed cancellation query only the final address', async () => {
  const cancellation = deferred();
  let first = true;
  const f = fixture({ cancelAll: () => {
    if (first) { first = false; return cancellation.promise; }
    return Promise.resolve();
  } });
  const old = f.session.loadAccount(ADDRESS);
  assert.equal(f.calls.length, 0);
  assert.equal(await f.session.loadAccount(OTHER), true);
  cancellation.resolve();
  assert.equal(await old, false);
  assert.equal(f.session.state.address, OTHER);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => !call.params.address || call.params.address === OTHER));
});

test('clearAccount or pause before initial cancellation finishes prevents any startup query', async () => {
  for (const action of ['clearAccount', 'pause']) {
    const cancellation = deferred();
    const f = fixture({ cancelAll: () => cancellation.promise });
    const work = f.session.loadAccount(ADDRESS);
    if (action === 'clearAccount') f.session.clearAccount();
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
  await f.session.loadAccount(ADDRESS);
  const before = structuredClone(f.session.state);
  const count = f.calls.length;
  await assert.rejects(f.session.loadAccount('not a valid address'), /valid ConnectCoin mainnet/);
  assert.deepEqual(f.session.state, before);
  assert.equal(f.calls.length, count);
});

test('a repeated pagination cursor is discarded and requires a full refresh without merging its page', async () => {
  const f = fixture({ query: (method, params) => reply(method, params, {
    cursor: 'same.signature', items: params.cursor ? [pending(3)] : [pending(1)],
  }) });
  await f.session.loadAccount(ADDRESS);
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
  assert.equal(await f.session.loadAccount(ADDRESS), true);
  for (let i = 0; i < 3; i++) assert.equal(await f.session.refresh({ more: true }), true);
  assert.equal(f.session.state.history.length, 2000);
  assert.equal(f.session.state.cursor, null);
  const count = f.calls.length;
  assert.equal(await f.session.refresh({ more: true }), false);
  assert.equal(f.calls.length, count);
  assert.equal(page, 4);
});

test('balance-only refresh preserves history rows, anchor and pagination while publishing fresh funds', async () => {
  let block = tip();
  const f = fixture({ query: (method, params) => reply(method, params, { block, cursor: 'first.signature' }) });
  await f.session.loadAccount(ADDRESS);
  const before = structuredClone(f.session.state);
  const count = f.calls.length;
  assert.equal(await f.session.refresh({ balanceOnly: true }), true);
  assert.deepEqual(f.calls.slice(count).map(call => call.method), ['getaddressbalance']);
  assert.deepEqual(f.session.state.history, before.history);
  assert.deepEqual(f.session.state.tip, before.tip);
  assert.equal(f.session.state.cursor, before.cursor);
  assert.equal(f.session.state.historyStale, false);
  block = tip(201);
  assert.equal(await f.session.refresh({ balanceOnly: true }), true);
  assert.deepEqual(f.session.state.balance.tip, block);
  assert.deepEqual(f.session.state.tip, before.tip);
  assert.deepEqual(f.session.state.history, before.history);
  assert.equal(f.session.state.cursor, before.cursor);
  assert.equal(f.session.state.historyStale, true);
  assert.equal(f.session.state.stale, false);
  // Pagination must still compare with its actual historical anchor, not the
  // newer balance's tip. It cannot mix a page from the new chain snapshot.
  const moreCount = f.calls.length;
  assert.equal(await f.session.refresh({ more: true }), false);
  assert.equal(f.calls.length, moreCount + 1);
  assert.equal(f.session.state.cursor, null);
  assert.equal(f.session.state.historyStale, true);
  assert.equal(await f.session.refresh(), true);
  assert.deepEqual(f.session.state.tip, block);
  assert.equal(f.session.state.historyStale, false);
});

test('balance-only can recover a failed initial history without pretending history has loaded', async () => {
  const f = fixture({ query: (method, params) => {
    if (method === 'getaddresshistory') throw new Error('History temporarily unavailable');
    return reply(method, params);
  } });
  assert.equal(await f.session.loadAccount(ADDRESS), false);
  assert.equal(f.session.state.balance, null);
  assert.equal(await f.session.refresh({ balanceOnly: true }), true);
  assert.equal(f.session.state.balance.available_confirmed, '10000000000');
  assert.equal(f.session.state.tip, null);
  assert.equal(f.session.state.cursor, null);
  assert.equal(f.session.state.historyStale, true);
  assert.deepEqual(f.session.state.history, []);
  assert.equal(f.session.state.error, '');
  assert.equal(f.session.state.stale, false);
  assert.equal(f.session.pendingRefreshes, 0);
});

test('a contradictory known block in balance-only cannot publish and preserves the pagination anchor', async () => {
  for (const metadata of [{ height: 201 }, { mediantime: tip().mediantime + 1 }]) {
    let drift = false;
    const f = fixture({ query: (method, params) => reply(method, params, {
      block: drift && method === 'getaddressbalance' ? { ...tip(), ...metadata } : tip(), cursor: 'first.signature',
    }) });
    await f.session.loadAccount(ADDRESS);
    const before = structuredClone(f.session.state);
    drift = true;
    assert.equal(await f.session.refresh({ balanceOnly: true }), false);
    assert.deepEqual(f.session.state.balance, before.balance);
    assert.deepEqual(f.session.state.history, before.history);
    assert.deepEqual(f.session.state.tip, before.tip);
    assert.equal(f.session.state.cursor, before.cursor);
    assert.equal(f.session.state.updatedAt, before.updatedAt);
    assert.equal(f.session.state.stale, true);
    assert.equal(f.session.state.historyStale, true);
    assert.equal(f.session.pendingRefreshes, 0);
  }
});

test('late balance-only results cannot republish after an account or foreground change', async () => {
  for (const change of ['account', 'background', 'offline']) {
    const gate = deferred();
    let hold = false;
    const f = fixture({ query: (method, params) => hold && method === 'getaddressbalance' && params.address === ADDRESS
      ? gate.promise : reply(method, params) });
    await f.session.loadAccount(ADDRESS);
    hold = true;
    const work = f.session.refresh({ balanceOnly: true });
    await until(() => f.calls.length === 3);
    assert.equal(f.session.pendingRefreshes, 1);
    if (change === 'account') await f.session.loadAccount(OTHER);
    else f.session.setEnvironment(change === 'background' ? { active: false } : { connected: false });
    const before = structuredClone(f.session.state);
    assert.equal(f.session.pendingRefreshes, 1);
    assert.equal(f.session.state.busy, false);
    gate.resolve(reply('getaddressbalance', { address: ADDRESS }));
    assert.equal(await work, false);
    assert.deepEqual(f.session.state, before);
    assert.equal(f.session.pendingRefreshes, 0);
  }
});

test('pendingRefreshes survives invalidate until every physical sibling query settles', async () => {
  const balanceGate = deferred(), historyGate = deferred();
  let hold = false;
  const f = fixture({ query: (method, params) => hold && method === 'getaddressbalance' ? balanceGate.promise
    : hold && method === 'getaddresshistory' ? historyGate.promise : reply(method, params) });
  await f.session.loadAccount(ADDRESS);
  assert.equal(f.session.pendingRefreshes, 0);
  hold = true;
  let settled = false;
  const work = f.session.refresh().finally(() => { settled = true; });
  await until(() => f.calls.length === 4);
  assert.equal(f.session.pendingRefreshes, 1);
  balanceGate.reject(new Error('Transient balance failure'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(f.session.pendingRefreshes, 1);
  await f.session.invalidate();
  assert.equal(f.session.state.busy, false);
  assert.equal(f.session.pendingRefreshes, 1);
  historyGate.resolve(reply('getaddresshistory', { address: ADDRESS }));
  assert.equal(await work, false);
  assert.equal(f.session.pendingRefreshes, 0);
});

test('balance-only and pagination cannot be combined or spawn a second in-flight refresh', async () => {
  const gate = deferred();
  let hold = false;
  const f = fixture({ query: (method, params) => hold && method === 'getaddressbalance'
    ? gate.promise : reply(method, params, { cursor: 'first.signature' }) });
  await f.session.loadAccount(ADDRESS);
  const count = f.calls.length;
  assert.equal(await f.session.refresh({ balanceOnly: true, more: true }), false);
  assert.equal(f.calls.length, count);
  hold = true;
  const work = f.session.refresh({ balanceOnly: true });
  await until(() => f.calls.length === count + 1);
  assert.equal(f.session.pendingRefreshes, 1);
  assert.equal(await f.session.refresh({ balanceOnly: true }), false);
  assert.equal(await f.session.refresh({ more: true }), false);
  assert.equal(f.calls.length, count + 1);
  gate.resolve(reply('getaddressbalance', { address: ADDRESS }));
  assert.equal(await work, true);
  assert.equal(f.session.pendingRefreshes, 0);
});

test('ordinary tips project confirmations without RPC or mutating the account snapshot and pagination anchor', async () => {
  const f = fixture({ query: (method, params) => reply(method, params,
    { items: [confirmed(1), pending(2)], cursor: 'first.signature' }) });
  await f.session.loadAccount(ADDRESS);
  const before = structuredClone(f.session.state), balance = f.session.state.balance, history = f.session.state.history;
  const generation = f.session.generation, requests = f.calls.length;
  for (let height = 201; height <= 300; height++) {
    assert.equal(f.session.observeTip(tip(height)), false);
    const display = f.session.getState();
    assert.equal(display.history.find(row => row.txid === hash(1)).confirmations, height - 199);
    assert.equal(display.history.find(row => row.txid === hash(2)).confirmations, 0);
    assert.equal(display.history.find(row => row.txid === hash(2)).status, 'pending');
  }
  assert.equal(f.calls.length, requests);
  assert.equal(f.session.generation, generation);
  assert.equal(f.session.state.balance, balance);
  assert.equal(f.session.state.history, history);
  assert.deepEqual(f.session.state, before);
  assert.deepEqual(f.session.getState().displayTip, tip(300));
  // Returned row copies cannot corrupt the next render or validated source.
  f.session.getState().history[0].confirmations = 987654;
  assert.deepEqual(f.session.state, before);
});

test('identical validated tips do not republish history, but changed and malformed metadata are not deduplicated', async () => {
  const f = fixture({ query: (method, params) => reply(method, params, { items: [confirmed()] }) });
  await f.session.loadAccount(ADDRESS);
  const emitted = f.snapshots.length, generation = f.session.generation, calls = f.calls.length;
  for (let index = 0; index < 100; index++) assert.equal(f.session.observeTip({ ...tip() }), false);
  assert.equal(f.snapshots.length, emitted);
  assert.equal(f.session.generation, generation);
  assert.equal(f.calls.length, calls);
  for (const malformed of [{ ...tip(), chain: 'test' }, { ...tip(), genesis_hash: hash(99) },
    { ...tip(), mediantime: -1 }, { ...tip(), extra: true }]) assert.throws(() => f.session.observeTip(malformed));
  assert.equal(f.snapshots.length, emitted);
  assert.equal(f.session.observeTip({ ...tip(), mediantime: tip().mediantime + 1 }), true);
  assert.equal(f.snapshots.length, emitted + 1);
  assert.equal(f.session.generation, generation + 1);
  assert.equal(f.session.state.historyStale, true);
});

test('an explicit reset at the identical display tip still invalidates and freezes old confirmations', async () => {
  const f = fixture({ query: (method, params) => reply(method, params, { items: [confirmed()], cursor: 'first.signature' }) });
  await f.session.loadAccount(ADDRESS); f.session.observeTip(tip(210));
  assert.equal(f.session.getState().history[0].confirmations, 11);
  const generation = f.session.generation, emitted = f.snapshots.length;
  assert.equal(f.session.observeTip(tip(210), { reset: true }), true);
  assert.equal(f.session.generation, generation + 1);
  assert.equal(f.snapshots.length, emitted + 1);
  assert.equal(f.session.confirmationsStale, true);
  assert.equal(f.session.state.cursor, null);
  assert.equal(f.session.getState().history[0].confirmations, 1);
  assert.equal(f.session.observeTip(tip(210)), false);
  assert.equal(f.snapshots.length, emitted + 1);
  assert.equal(f.session.confirmationsStale, true);
});

test('connected and address hints still schedule full catch-up when their display tip is identical', async () => {
  for (const reason of ['connected', 'address']) {
    const f = fixture(); await f.session.loadAccount(ADDRESS);
    const emitted = f.snapshots.length, calls = f.calls.length;
    const live = new LiveBalance({ session: f.session, allowed: () => true, now: () => 0,
      setTimer: () => 1, clearTimer: () => {} });
    live.notify({ address: ADDRESS, reason, tip: tip() });
    assert.equal(f.snapshots.length, emitted, reason);
    assert.equal(live.connected, true); assert.equal(live.dirty, true); assert.equal(live.full, true);
    await live.flush();
    assert.deepEqual(f.calls.slice(calls).map(call => call.method), ['getaddressbalance', 'getaddresshistory']);
    assert.equal(live.dirty, false);
  }
});

test('a tip received during a held full refresh does not regress display or move its snapshot cursor', async () => {
  let hold = false;
  const gate = deferred();
  const f = fixture({ query: (method, params) => hold && method === 'getaddresshistory' ? gate.promise
    : reply(method, params, { items: [confirmed()], cursor: 'first.signature' }) });
  await f.session.loadAccount(ADDRESS);
  hold = true;
  const work = f.session.refresh({ reloadLoaded: true });
  await until(() => f.calls.length === 4);
  const generation = f.session.generation;
  f.session.observeTip(tip(205));
  assert.equal(f.session.getState().history[0].confirmations, 6);
  gate.resolve(reply('getaddresshistory', { address: ADDRESS }, { items: [confirmed()], cursor: 'first.signature' }));
  assert.equal(await work, true);
  assert.equal(f.session.generation, generation);
  assert.deepEqual(f.session.state.tip, tip());
  assert.equal(f.session.state.cursor, 'first.signature');
  assert.equal(f.session.state.history[0].confirmations, 1);
  assert.equal(f.session.getState().history[0].confirmations, 6);
  assert.equal(f.calls.length, 4);
});

test('disconnect or a replacement tip rejects held old-chain reads and disables projection until full history validation', async () => {
  for (const mode of ['disconnect', 'replacement', 'rollback', 'explicit-reset']) {
    let block = tip(), items = [confirmed()], hold = false;
    const gate = deferred();
    const f = fixture({ query: (method, params) => hold && method === 'getaddresshistory' ? gate.promise
      : reply(method, params, { block, items, cursor: 'first.signature' }) });
    await f.session.loadAccount(ADDRESS);
    const before = structuredClone(f.session.state);
    f.session.observeTip(tip(210));
    assert.equal(f.session.getState().history[0].confirmations, 11);
    hold = true;
    const old = f.session.refresh({ reloadLoaded: true });
    await until(() => f.calls.length === 4);
    const generation = f.session.generation;
    if (mode === 'disconnect') f.session.disconnectWatch();
    else {
      const changed = mode === 'replacement' ? { ...tip(210), hash: hash(999) }
        : mode === 'rollback' ? tip(190) : tip(211);
      assert.equal(f.session.observeTip(changed, { reset: mode === 'explicit-reset' }), true);
    }
    assert.equal(f.session.generation, generation + 1);
    assert.equal(f.session.confirmationsStale, true);
    assert.equal(f.session.state.historyStale, true);
    f.session.observeTip(tip(220));
    assert.equal(f.session.getState().history[0].confirmations, 1);
    gate.resolve(reply('getaddresshistory', { address: ADDRESS }, { items: [confirmed()], cursor: 'old.signature' }));
    assert.equal(await old, false);
    assert.deepEqual(f.session.state.balance, before.balance);
    assert.deepEqual(f.session.state.history, before.history);
    assert.equal(f.session.state.updatedAt, before.updatedAt);
    assert.equal(f.session.pendingRefreshes, 0);
    hold = false; block = tip(220); items = [pending(1)];
    assert.equal(await f.session.refresh({ balanceOnly: true }), true);
    assert.equal(f.session.confirmationsStale, true);
    f.session.observeTip(tip(221));
    assert.equal(f.session.getState().history[0].confirmations, 1);
    assert.equal(await f.session.refresh({ reloadLoaded: true }), true);
    assert.equal(f.session.confirmationsStale, false);
    assert.equal(f.session.getState().history[0].status, 'pending');
    assert.equal(f.session.getState().history[0].confirmations, 0);
  }
});

test('a duplicate reset and later new-branch tips cannot starve a held replacement baseline', async () => {
  let block = tip(), items = [confirmed()], hold = false;
  const gate = deferred();
  const f = fixture({ query: (method, params) => hold && method === 'getaddresshistory' ? gate.promise
    : reply(method, params, { block, items }) });
  await f.session.loadAccount(ADDRESS);
  const rolled = tip(190);
  assert.equal(f.session.observeTip(rolled, { reset: true }), true);
  block = rolled; items = [pending(1)]; hold = true;
  const work = f.session.refresh({ reloadLoaded: true });
  await until(() => f.calls.length === 4);
  const generation = f.session.generation;
  assert.equal(f.session.observeTip(rolled, { reset: true }), true);
  assert.equal(f.session.generation, generation);
  for (let height = 191; height <= 195; height++) assert.equal(f.session.observeTip(tip(height)), false);
  assert.equal(f.session.generation, generation);
  assert.equal(f.session.state.busy, true);
  gate.resolve(reply('getaddresshistory', { address: ADDRESS }, { block, items }));
  assert.equal(await work, true);
  assert.equal(f.session.confirmationsStale, false);
  assert.deepEqual(f.session.state.tip, rolled);
  assert.deepEqual(f.session.getState().displayTip, tip(195));
  assert.equal(f.session.getState().history[0].confirmations, 0);
  assert.equal(f.calls.length, 4);
});

test('reloadLoaded revalidates all displayed pages at one tip and removes evicted old rows atomically', async () => {
  let replacement = false;
  const f = fixture({ query: (method, params) => reply(method, params, {
    items: params.cursor ? (replacement ? [pending(4), pending(5)] : [pending(2), pending(3)]) : [pending(1)],
    cursor: params.cursor ? null : 'first.signature',
  }) });
  await f.session.loadAccount(ADDRESS);
  assert.equal(await f.session.refresh({ more: true }), true);
  assert.equal(f.session.state.history.length, 3);
  replacement = true;
  const count = f.calls.length;
  assert.equal(await f.session.refresh({ reloadLoaded: true }), true);
  assert.deepEqual(f.calls.slice(count).map(call => call.method),
    ['getaddressbalance', 'getaddresshistory', 'getaddresshistory']);
  assert.deepEqual(f.calls.at(-1).params, { address: ADDRESS, cursor: 'first.signature' });
  assert.deepEqual(f.session.state.history, [pending(1), pending(4), pending(5)]);
  assert.equal(f.session.state.cursor, null);
  assert.equal(f.session.state.stale, false);
});

test('invalid extra reload pages, changed tips and cursor cycles cannot partially publish', async () => {
  for (const attack of ['address', 'amount', 'height', 'median-time', 'same-cursor', 'cursor-cycle']) {
    let replacement = false;
    const f = fixture({ query: (method, params) => {
      const page = reply(method, params, { items: params.cursor ? [pending(2), pending(3), pending(4)] : [pending(1)],
        cursor: params.cursor ? null : 'first.signature' });
      if (!replacement || method !== 'getaddresshistory') return page;
      if (!params.cursor) { page.items = [pending(9)]; return page; }
      page.items = [pending(10)];
      if (attack === 'address') page.address = OTHER;
      if (attack === 'amount') page.items[0].received = 'malformed';
      if (attack === 'height') page.tip.height++;
      if (attack === 'median-time') page.tip.mediantime++;
      if (attack === 'same-cursor') page.next_cursor = params.cursor;
      if (attack === 'cursor-cycle') page.next_cursor = params.cursor === 'first.signature' ? 'second.signature' : 'first.signature';
      return page;
    } });
    await f.session.loadAccount(ADDRESS);
    await f.session.refresh({ more: true });
    const before = structuredClone(f.session.state), count = f.calls.length;
    replacement = true;
    assert.equal(await f.session.refresh({ reloadLoaded: true }), false, attack);
    assert.deepEqual(f.session.state.balance, before.balance, attack);
    assert.deepEqual(f.session.state.history, before.history, attack);
    assert.deepEqual(f.session.state.tip, before.tip, attack);
    assert.equal(f.session.state.updatedAt, before.updatedAt, attack);
    assert.equal(f.session.state.stale, true, attack);
    assert.equal(f.session.state.busy, false, attack);
    assert.ok(f.session.state.error, attack);
    assert.equal(f.session.pendingRefreshes, 0, attack);
    assert.equal(f.calls.length - count, attack === 'cursor-cycle' ? 4 : 3, attack);
  }
});

test('a reorg while an extra loaded page is pending cannot publish its earlier valid pages', async () => {
  let hold = false;
  const gate = deferred();
  const f = fixture({ query: (method, params) => hold && method === 'getaddresshistory' && params.cursor ? gate.promise
    : reply(method, params, { items: params.cursor ? [pending(2)] : [pending(1)], cursor: params.cursor ? null : 'first.signature' }) });
  await f.session.loadAccount(ADDRESS);
  await f.session.refresh({ more: true });
  const before = structuredClone(f.session.state), count = f.calls.length;
  hold = true;
  const work = f.session.refresh({ reloadLoaded: true });
  await until(() => f.calls.length === count + 3);
  f.session.observeTip(tip(190), { reset: true });
  gate.resolve(reply('getaddresshistory', { address: ADDRESS }, { items: [pending(8)] }));
  assert.equal(await work, false);
  assert.deepEqual(f.session.state.history, before.history);
  assert.deepEqual(f.session.state.balance, before.balance);
  assert.deepEqual(f.session.state.tip, before.tip);
  assert.equal(f.session.confirmationsStale, true);
  assert.equal(f.session.pendingRefreshes, 0);
});

test('balance-only same-height replacements or rollbacks freeze old confirmations until a new history baseline', async () => {
  for (const changed of [{ ...tip(123), hash: hash(999) }, tip(122)]) {
    let block = tip(123), items = [{ ...confirmed(1, 121), confirmations: 3 }];
    const f = fixture({ query: (method, params) => reply(method, params, { block, items, cursor: 'first.signature' }) });
    assert.equal(await f.session.loadAccount(ADDRESS), true);
    const history = structuredClone(f.session.state.history);
    block = changed;
    assert.equal(await f.session.refresh({ balanceOnly: true }), true);
    assert.equal(f.session.state.historyStale, true);
    assert.equal(f.session.confirmationsStale, true);
    assert.equal(f.session.state.cursor, null);
    assert.equal(f.session.historyNeedsBaseline(), true);
    assert.deepEqual(f.session.state.history, history);
    f.session.observeTip(tip(124));
    assert.equal(f.session.getState().history[0].confirmations, 3);
    assert.deepEqual(f.session.state.balance.tip, changed);
    block = tip(124); items = [pending(1)];
    assert.equal(await f.session.refresh({ reloadLoaded: true }), true);
    assert.equal(f.session.historyNeedsBaseline(), false);
    assert.equal(f.session.confirmationsStale, false);
    assert.equal(f.session.getState().history[0].confirmations, 0);
    assert.equal(f.session.getState().history[0].status, 'pending');
  }
});

test('a delayed balance-only response at the earlier tip is not mistaken for a rollback after a forward notification', async () => {
  let hold = false;
  const gate = deferred(), block = tip(123), items = [{ ...confirmed(1, 121), confirmations: 3 }];
  const f = fixture({ query: (method, params) => hold && method === 'getaddressbalance' ? gate.promise
    : reply(method, params, { block, items, cursor: 'first.signature' }) });
  await f.session.loadAccount(ADDRESS);
  hold = true;
  const work = f.session.refresh({ balanceOnly: true });
  await until(() => f.calls.length === 3);
  const generation = f.session.generation;
  f.session.observeTip(tip(124));
  assert.equal(f.session.getState().history[0].confirmations, 4);
  gate.resolve(reply('getaddressbalance', { address: ADDRESS }, { block }));
  assert.equal(await work, true);
  assert.equal(f.session.generation, generation);
  assert.equal(f.session.confirmationsStale, false);
  assert.equal(f.session.state.historyStale, false);
  assert.equal(f.session.historyNeedsBaseline(), false);
  assert.equal(f.session.state.cursor, 'first.signature');
  assert.deepEqual(f.session.state.tip, block);
  assert.deepEqual(f.session.getState().displayTip, tip(124));
  assert.equal(f.session.getState().history[0].confirmations, 4);
  assert.equal(f.calls.length, 3);
});

test('ordinary reads need no standalone tip quota while pagination still preflights its anchor', async () => {
  const f = fixture({ query: (method, params) => {
    if (method === 'getchaintip') throw Object.assign(new Error('Tip quota exhausted'), { code: -32029 });
    return reply(method, params, { cursor: 'first.signature' });
  } });
  assert.equal(await f.session.loadAccount(ADDRESS), true);
  assert.equal(await f.session.refresh(), true);
  assert.equal(await f.session.refresh({ balanceOnly: true }), true);
  assert.deepEqual(f.calls.map(call => call.method), [
    'getaddressbalance', 'getaddresshistory', 'getaddressbalance', 'getaddresshistory', 'getaddressbalance',
  ]);
  const before = structuredClone(f.session.state);
  assert.equal(await f.session.refresh({ more: true }), false);
  assert.equal(f.calls.length, 6);
  assert.equal(f.calls.at(-1).method, 'getchaintip');
  assert.deepEqual(f.session.state.balance, before.balance);
  assert.deepEqual(f.session.state.history, before.history);
  assert.match(f.session.state.error, /Too many requests/);
});

test('embedded tips independently validate the pinned network and shape on every read path', async () => {
  for (const mode of ['full', 'balance-only', 'more']) {
    for (const method of mode === 'balance-only' ? ['getaddressbalance'] : ['getaddressbalance', 'getaddresshistory']) {
      for (const malformed of [{ chain: 'testnet4' }, { genesis_hash: hash(123) }, { height: -1 },
        { height: 1.5 }, { hash: 'invalid' }, { mediantime: -1 }]) {
        let attack = false;
        const f = fixture({ query: (name, params) => {
          const value = reply(name, params, { items: params.cursor ? [pending(2)] : [pending()],
            cursor: params.cursor ? null : 'first.signature' });
          if (attack && name === method) value.tip = { ...value.tip, ...malformed };
          return value;
        } });
        assert.equal(await f.session.loadAccount(ADDRESS), true);
        const before = structuredClone(f.session.state); attack = true;
        assert.equal(await f.session.refresh({ balanceOnly: mode === 'balance-only', more: mode === 'more' }), false);
        assert.deepEqual(f.session.state.balance, before.balance);
        assert.deepEqual(f.session.state.history, before.history);
        assert.deepEqual(f.session.state.tip, before.tip);
        assert.equal(f.session.state.updatedAt, before.updatedAt);
        assert.equal(f.session.pendingRefreshes, 0);
      }
    }
  }
});

test('matching responses cannot redefine metadata of an already known immutable block', async () => {
  for (const metadata of [{ height: 201 }, { mediantime: tip().mediantime + 1 }]) {
    let block = tip();
    const f = fixture({ query: (method, params) => reply(method, params, { block, cursor: 'first.signature' }) });
    assert.equal(await f.session.loadAccount(ADDRESS), true);
    const before = structuredClone(f.session.state); block = { ...block, ...metadata };
    assert.equal(await f.session.refresh(), false);
    assert.deepEqual(f.session.state.balance, before.balance);
    assert.deepEqual(f.session.state.history, before.history);
    assert.deepEqual(f.session.state.tip, before.tip);
    assert.equal(f.session.state.cursor, null);
    assert.equal(f.session.state.updatedAt, before.updatedAt);
    assert.equal(f.session.pendingRefreshes, 0);
  }
});
