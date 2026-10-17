import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { WalletService } from '../src/core/wallet-service.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { COIN, MAX_PAYMENT_INPUTS, selectPaymentFunding } from '../src/core/transaction.mjs';

// Public fixture only: this exercises selection, never signing or broadcast.
const mnemonic = 'abandon '.repeat(11) + 'about';
const tip = { chain: 'main', genesis_hash: GENESIS.main, height: 200, hash: 'ab'.repeat(32), mediantime: 1800000000 };
const hash = n => n.toString(16).padStart(64, '0');
const row = (n, amount = COIN, extra = {}) => ({ txid: hash(n), vout: 0, amount: String(amount), status: 'confirmed', mature: true, ...extra });
async function fixture(t, pages) {
  const service = new WalletService({ directory: '/unused-funding-reuse-test' });
  service.config = structuredClone(DEFAULT_CONFIG);
  service.session = { data: { mnemonic, network: 'main', receiveIndex: 0, changeIndex: 0 }, password: 'unused' };
  await service.buildAccounts();
  service.accounts = pages.map((_, index) => service.publicAccount(index, 0));
  const calls = [], updates = [];
  service.rpc = { async request(method, params) {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'getchaintip') return tip;
    assert.equal(method, 'getaddressutxos', 'No funding lookup, history query or broadcast is permitted');
    const index = service.accounts.findIndex(account => account.address === params.address);
    assert.notEqual(index, -1);
    const rows = pages[index], offset = Number(params.cursor ?? 0);
    return { tip, address: params.address, unit: 'connects', items: rows.slice(offset, offset + 500),
      next_cursor: offset + 500 < rows.length ? String(offset + 500) : null };
  } };
  let plans = 0;
  const outputs = [{ address: service.accounts[0].address, amount: String(10n * COIN) }];
  // paymentPlan maps recipients exactly once. Count actual planner entries,
  // without stubbing its monetary/address/weight/fee/input validation.
  Object.defineProperty(outputs, 'map', { value(...args) { plans++; return Array.prototype.map.apply(this, args); } });
  const options = { outputs, changeAddress: service.accounts[0].address, network: 'main' };
  t.after(() => service.statePublisher.close());
  return { service, calls, updates, options, plans: () => plans,
    run: (signal = new AbortController().signal) => service.paymentFunding(options, signal, update => updates.push({ ...update })) };
}

test('empty address pages preserve every read and progress event without replanning unchanged funds', async t => {
  const rows = Object.freeze(Array.from({ length: 1000 }, (_, index) => Object.freeze(row(index + 1, 1000000n))));
  const pages = [rows, ...Array.from({ length: 63 }, () => [])];
  const { run, plans, calls, updates } = await fixture(t, pages);
  const started = performance.now();
  await assert.rejects(run(), /Insufficient verified funds/);
  t.diagnostic(`Mocked local RPC: 64 accounts, 1000 candidates, ${plans()} planner call(s), ${(performance.now() - started).toFixed(2)} ms`);
  assert.equal(plans(), 1);
  assert.equal(calls.filter(call => call.method === 'getaddressutxos').length, 65);
  const expected = [{ stage: 'network', completed: 0, total: 0, pages: 0 },
    { stage: 'outputs', completed: 0, total: 64, pages: 0 }];
  let pageCount = 0;
  for (let completed = 0; completed < 64; completed++) {
    for (let page = 0; page < (completed === 0 ? 2 : 1); page++)
      expected.push({ stage: 'outputs', completed, total: 64, pages: ++pageCount });
    expected.push({ stage: 'outputs', completed: completed + 1, total: 64, pages: pageCount });
  }
  assert.deepEqual(updates, expected);
});

test('ineligible rows never replan free funds and pending replacement still gets a final validated plan', async t => {
  for (const allowPendingSpent of [false, true]) {
    const pending = row(4, 20n * COIN, { pending_spent_by: hash(100) });
    const pages = [[row(1)], [row(2, COIN, { mature: false })], [row(3)], [pending],
      [row(5, COIN, { status: 'pending' })], [row(6, COIN, { coinbase: true, block_height: 200 })], []];
    const { service, run, options, plans, calls, updates } = await fixture(t, pages);
    service.reserved.add(`${hash(3)}:0`); options.allowPendingSpent = allowPendingSpent;
    if (allowPendingSpent) {
      const selected = await run();
      assert.deepEqual(selected.map(input => input.txid), [pending.txid]);
      assert.equal(selected[0].pending_spent_by, pending.pending_spent_by);
      assert.equal(plans(), 2, 'One free-input plan and the final pending-input plan');
    } else {
      await assert.rejects(run(), /Insufficient verified funds/);
      assert.equal(plans(), 1);
    }
    assert.equal(calls.filter(call => call.method === 'getaddressutxos').length, pages.length);
    assert.equal(updates.at(-1).completed, pages.length);
    assert.equal(updates.at(-1).pages, pages.length);
  }
});

test('a new free output after empty accounts is planned immediately and keeps early completion', async t => {
  const large = row(2, 20n * COIN);
  const { run, plans, calls, service, updates } = await fixture(t, [[row(1)], [], [], [], [large], []]);
  assert.deepEqual((await run()).map(input => input.txid), [large.txid]);
  assert.equal(plans(), 2);
  assert.deepEqual(calls.filter(call => call.method === 'getaddressutxos').map(call => call.params.address), service.accounts.slice(0, 5).map(account => account.address));
  assert.equal(updates.at(-1).completed, 5);
});

test('a new candidate replans even when the retained input count is already at the cap', async t => {
  const rows = Array.from({ length: MAX_PAYMENT_INPUTS }, (_, index) => row(index + 1));
  const large = row(MAX_PAYMENT_INPUTS + 1, 10000n * COIN);
  const { run, options, plans, calls } = await fixture(t, [rows, [], [large]]);
  options.outputs[0].amount = String(BigInt(MAX_PAYMENT_INPUTS + 1) * COIN);
  assert.deepEqual((await run()).map(input => input.txid), [large.txid]);
  assert.equal(plans(), 2);
  assert.equal(calls.filter(call => call.method === 'getaddressutxos').length, 6);
});

test('later invalid rows and pages still fail after a recoverable plan and empty account', async t => {
  for (const [bad, message] of [
    [row(2, -1n), /Invalid RPC output/],
    [row(2, COIN, { amount: 'not-money' }), /invalid monetary amount/],
    [row(2, COIN, { pending_spent_by: 'not-a-hash' }), /Invalid RPC pending spender/],
    [row(1), /Duplicate RPC funding output/],
    [row(2, COIN, { vout: -1 }), /Invalid RPC output/],
  ]) {
    const { run, plans, updates } = await fixture(t, [[row(1)], [], [bad]]);
    await assert.rejects(run(), message); assert.equal(plans(), 1);
    assert.equal(updates.at(-1).completed, 2, 'Invalid row does not complete the account');
  }
  for (const patch of [{ next_cursor: {} }, { tip: { ...tip, genesis_hash: hash(123) } }]) {
    const { service, run, plans, updates } = await fixture(t, [[row(1)], [], []]);
    const request = service.rpc.request;
    service.rpc.request = async (method, params) => {
      const response = await request(method, params);
      return method === 'getaddressutxos' && params.address === service.accounts[2].address ? { ...response, ...patch } : response;
    };
    await assert.rejects(run()); assert.equal(plans(), 1);
    assert.equal(updates.at(-1).completed, 2);
  }
});

test('cancel during a later unchanged lookup rejects promptly and ignores its late response', async t => {
  const { service, run, plans, updates } = await fixture(t, [[row(1)], [], []]);
  const request = service.rpc.request;
  let release, enter;
  const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { enter = resolve; });
  service.rpc.request = async (method, params) => {
    if (method === 'getaddressutxos' && params.address === service.accounts[2].address) { enter(); await gate; }
    return request(method, params);
  };
  const controller = new AbortController(), work = run(controller.signal);
  const rejected = assert.rejects(work, { name: 'AbortError' });
  await entered; controller.abort(); await rejected;
  const count = updates.length;
  assert.equal(plans(), 1);
  release(); await tick(); assert.equal(updates.length, count); assert.equal(plans(), 1);
});

// Reference the former always-sort selection strategy. Test rows here are
// canonical, but the actual service still reads and validates each RPC page.
// Keep the real planner in both paths so fees, dust, weight, exact-coin
// preference and tie order are compared rather than replaced with a mock.
function previouslySortedSelection(pages, accounts, options, reserved) {
  const free = [], pending = [];
  const exact = options.subtractFeeFromAmount ? BigInt(options.outputs[0].amount) : null;
  const compare = (a, b) => {
    const first = BigInt(a.amount), second = BigInt(b.amount);
    if (exact !== null && (first === exact) !== (second === exact)) return first === exact ? -1 : 1;
    return first > second ? -1 : first < second ? 1 : 0;
  };
  let insufficient, exceeds = false, queried = 0;
  const trim = values => {
    values.sort(compare);
    if (values.length > MAX_PAYMENT_INPUTS) { exceeds = true; values.length = MAX_PAYMENT_INPUTS; }
  };
  const select = () => selectPaymentFunding({ ...options, outputs: Array.from(options.outputs), utxos: free }).selected;
  for (let index = 0; index < pages.length; index++) {
    queried++;
    for (const item of pages[index]) {
      if (item.status !== 'confirmed' || !item.mature || item.coinbase && tip.height - item.block_height + 1 < 100) continue;
      if (item.pending_spent_by) {
        if (options.allowPendingSpent) pending.push({ ...item, account: accounts[index] });
      } else if (!reserved.has(`${item.txid}:${item.vout}`)) free.push({ ...item, account: accounts[index] });
    }
    if (pending.length > MAX_PAYMENT_INPUTS) trim(pending);
    trim(free);
    if (!free.length) continue;
    try { return { selected: select(), queried }; }
    catch (error) {
      if (!/^(?:Insufficient|Payment exceeds (?:relay|the standard transaction weight)|Recipient amount after deducting the fee|Transaction fee exceeds the wallet safety limit)/.test(error.message)) throw error;
      insufficient = error;
    }
  }
  if (options.allowPendingSpent && pending.length) {
    free.push(...pending); trim(free);
    try { return { selected: select(), queried }; } catch (error) { insufficient = error; }
  }
  return { error: exceeds ? 'This amount needs too many inputs for one standard transaction. Send smaller amounts in separate payments.'
    : insufficient?.message ?? 'Insufficient verified funds for this payment and its fee', queried };
}

test('planner-only sorting is differential-equivalent for ties, exact coins, pending funds and later additions', async t => {
  for (let scenario = 0; scenario < 32; scenario++) {
    const pages = Array.from({ length: 5 }, (_, account) => Array.from({ length: (scenario + account * 3) % 7 }, (_, index) =>
      row(1 + account * 100 + index, BigInt(1 + (scenario + index) % 4) * 1000000n, {
        ...(scenario % 2 && account % 2 ? { pending_spent_by: hash(999) } : {}),
      })));
    const { service, options, run, calls } = await fixture(t, pages);
    options.outputs[0].amount = String(BigInt(1 + scenario % 4) * 3000000n);
    options.subtractFeeFromAmount = scenario % 3 === 0;
    options.allowPendingSpent = scenario % 2 === 1;
    if (scenario % 4 === 0) pages[3].push(row(900, BigInt(options.outputs[0].amount)));
    if (pages[0].length && scenario % 5 === 0) service.reserved.add(`${pages[0][0].txid}:0`);
    const expected = previouslySortedSelection(pages, service.accounts, options, service.reserved);
    if (expected.error) await assert.rejects(run(), { message: expected.error });
    else assert.deepEqual(await run(), expected.selected, `Selection including equal-amount order for scenario ${scenario}`);
    assert.deepEqual(calls.filter(call => call.method === 'getaddressutxos').map(call => call.params.address),
      service.accounts.slice(0, expected.queried).map(account => account.address));
  }
});

test('outer candidate sorting is retained only for truncation, including combined pending funds', async t => {
  const cases = [
    { pages: [[row(1, 20n * COIN), row(2, 20n * COIN)]], sorts: 0 },
    { pages: [[row(1)], [row(2, 20n * COIN, { pending_spent_by: hash(999) })]], sorts: 0 },
    { pages: [Array.from({ length: MAX_PAYMENT_INPUTS + 1 }, (_, index) => row(index + 1, 300000n)), [],
      [row(9999, 200000n)]], amount: '200000', subtract: true, sorts: 2 },
    { pages: [Array.from({ length: 10 }, (_, index) => row(index + 1, 1n)), [],
      Array.from({ length: MAX_PAYMENT_INPUTS - 1 }, (_, index) => row(index + 100, index === 0 ? 200000n : 300000n,
        { pending_spent_by: hash(9999) }))], amount: '200000', subtract: true, sorts: 1 },
  ];
  for (const item of cases) {
    const { service, options, run } = await fixture(t, item.pages);
    options.allowPendingSpent = true; options.subtractFeeFromAmount = item.subtract === true;
    if (item.amount) options.outputs[0].amount = item.amount;
    const expected = previouslySortedSelection(item.pages, service.accounts, options, service.reserved);
    const original = Array.prototype.sort; let sorts = 0;
    try {
      Array.prototype.sort = function (...args) {
        if (this.length && this.every(item => typeof item?.txid === 'string' && typeof item.amount === 'string')) sorts++;
        return Reflect.apply(original, this, args);
      };
      assert.ok(expected.selected, 'The fixture must exercise a successful final selection');
      assert.deepEqual(await run(), expected.selected);
    } finally { Array.prototype.sort = original; }
    assert.equal(sorts, item.sorts, 'The planner retains its own sorting; count only redundant/truncating outer row sorts');
  }
});
