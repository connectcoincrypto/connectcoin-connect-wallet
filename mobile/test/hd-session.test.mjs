import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import { MAINNET_GENESIS } from '../src/model.mjs';
import { HdWalletSession, nativeHdAccounts, HD_READ_CONCURRENCY } from '../src/hd-session.mjs';
import { availableSendAmount } from '../src/send-request.mjs';
import { LiveBalance } from '../src/live-balance.mjs';

const hash = n => n.toString(16).padStart(64, '0');
const accounts = [1, 2, 3].map((i, n) => ({ address: bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.multiply(BigInt(i)).toBytes(true).slice(1))]), network: 'main', index: n === 2 ? 0 : n, change: n === 2 ? 1 : 0, path: `m/44'/0'/0'/${n === 2 ? 1 : 0}/${n === 2 ? 0 : n}` }));
const walletId = accounts[0].address;
const info = (patch = {}) => ({ exists: true, locked: false, accountScope: 'hd-wallet', walletId, account: accounts[0], accounts, hd: { complete: true, recovering: false }, ...patch });
const tip = { chain: 'main', genesis_hash: MAINNET_GENESIS, height: 200, hash: hash(200), mediantime: 1700000000 };
const history = (id, received, spent = '0') => ({ txid: hash(id), status: 'confirmed', block_height: 100, block_hash: hash(100), confirmations: 101, received, spent, balance_delta: (BigInt(received) - BigInt(spent)).toString() });
const utxo = (id, amount, patch = {}) => ({ txid: hash(id), vout: 0, amount, status: 'confirmed', block_height: 100, confirmations: 101, coinbase: false, mature: true, pending_spent_by: null, ...patch });
const journal = (patch = {}) => ({ tip, unit: 'connects', changes: [], next_cursor: 'journal.1', has_more: false, through_sequence: 0, journal_epoch: 1, ...patch });
const page = (address, items, next_cursor = null) => ({ address, tip, unit: 'connects', live: true, items, next_cursor });
const expandedAccounts = Array.from({ length: 40 }, (_, index) => ({
  address: bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.multiply(BigInt(index + 1)).toBytes(true).slice(1))]),
  network: 'main', index, change: 0, path: `m/44'/0'/0'/0/${index}`,
}));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture({ histories = {}, utxos = {}, override, options = {} } = {}) {
  const calls = []; let active = 0, maximum = 0;
  const query = async (method, params) => {
    calls.push({ method, params }); active++; maximum = Math.max(maximum, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      const custom = override && await override(method, params);
      if (custom !== undefined) return custom;
      if (method === 'getaddresschanges') return journal();
      if (method === 'getaddresshistory') return page(params.address, histories[params.address] ?? []);
      if (method === 'getaddressutxos') return page(params.address, utxos[params.address] ?? []);
      throw new Error('Unexpected RPC: ' + method);
    } finally { active--; }
  };
  return { session: new HdWalletSession({ query, ...options }), calls, maximum: () => maximum };
}

const recoveryGroup = (members = accounts, histories = {}) => ({ addresses: members.map(a => a.address),
  sync: journal(), histories: members.map(a => page(a.address, histories[a.address] ?? [])) });

test('recovery first pages and empty accounts are reused instead of duplicate history/UTXO queries', async () => {
  const events = [], group = recoveryGroup(accounts, { [walletId]: [history(1, '10000000000')] });
  const { session, calls } = fixture({ utxos: { [walletId]: [utxo(1, '10000000000')] }, options: {
    readRecoverySnapshots: async () => ({ walletId, groups: [group] }), onChange: state => events.push(state.progress),
  } });
  assert.equal(await session.loadWallet(info()), true);
  assert.deepEqual(calls.map(call => call.method), ['getaddressutxos', 'getaddresschanges', 'getaddresschanges']);
  assert.equal(availableSendAmount(session.state), '1');
  assert.ok(events.some(progress => progress?.completed === 3 && progress.total === 3));
  assert.equal(session.state.progress, null);
});

test('recovery reuse catches same-tip incoming money and pending spends through the ORIGINAL checkpoint', async () => {
  const group = recoveryGroup(); group.sync.next_cursor = 'recovery.0';
  const { session, calls } = fixture({ options: { readRecoverySnapshots: async () => ({ walletId, groups: [group] }) }, override: (method, params) => {
    if (method !== 'getaddresschanges') return;
    assert.equal(params.cursor, 'recovery.0');
    return journal({ through_sequence: 2, next_cursor: 'current.2', changes: [
      { sequence: 1, address: walletId, kind: 'history', action: 'upsert', txid: hash(9), item: history(9, '50000000000') },
      { sequence: 2, address: walletId, kind: 'utxo', action: 'upsert', txid: hash(9), vout: 0, item: utxo(9, '50000000000', { pending_spent_by: hash(10) }) },
    ] });
  } });
  assert.equal(await session.loadWallet(info()), true);
  assert.deepEqual(calls.map(call => call.method), ['getaddresschanges', 'getaddresschanges']);
  assert.equal(session.state.balance.confirmed, '50000000000');
  assert.equal(session.state.balance.pending_spent, '50000000000');
  assert.equal(availableSendAmount(session.state), null);
});

test('cached history continuation starts with its original cursor, not page one again', async () => {
  const group = recoveryGroup(); group.histories[0].next_cursor = 'recovery.more';
  const { session, calls } = fixture({ options: { readRecoverySnapshots: async () => ({ walletId, groups: [group] }) }, override: (method, params) => {
    if (method === 'getaddresshistory') { assert.equal(params.cursor, 'recovery.more'); return page(walletId, [history(1, '1')]); }
  } });
  assert.equal(await session.loadWallet(info()), true);
  assert.equal(calls.filter(call => call.method === 'getaddresshistory').length, 1);
  assert.equal(session.state.history.length, 1);
});

test('partial recovery cache checkpoints only missing addresses afresh', async () => {
  const { session, calls } = fixture({ options: { readRecoverySnapshots: async () => ({ walletId, groups: [recoveryGroup(accounts.slice(0, 2))] }) } });
  assert.equal(await session.loadWallet(info()), true);
  assert.deepEqual(calls.find(call => call.method === 'getaddresschanges' && !call.params.cursor).params.addresses, [accounts[2].address]);
  assert.deepEqual(calls.filter(call => call.method === 'getaddresshistory').map(call => call.params.address), [accounts[2].address]);
});

test('100 recovered addresses do not cause another 100 history queries', async () => {
  const large = Array.from({ length: 100 }, (_, index) => ({
    address: bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.multiply(BigInt(index + 1)).toBytes(true).slice(1))]),
    network: 'main', index, change: 0, path: `m/44'/0'/0'/0/${index}`,
  }));
  const group = recoveryGroup(large, { [walletId]: [history(1, '10')] });
  const { session, calls } = fixture({ utxos: { [walletId]: [utxo(1, '10')] },
    options: { readRecoverySnapshots: async () => ({ walletId, groups: [group] }) } });
  assert.equal(await session.loadWallet(info({ accounts: large })), true);
  assert.deepEqual(calls.map(call => call.method), ['getaddressutxos', 'getaddresschanges', 'getaddresschanges']);
  assert.equal(session.state.addressCount, 100); assert.equal(session.state.balance.total, '10');
});

test('first listener connection during a 41-address recovery baseline never restarts or rereads histories', async () => {
  const members = makeAccounts(41), entered = deferred(), release = deferred();
  const group = recoveryGroup(members, { [walletId]: [history(1, '10000000000')] });
  let seedReads = 0;
  const { session, calls } = fixture({ utxos: { [walletId]: [utxo(1, '10000000000')] }, options: {
    readRecoverySnapshots: async () => { seedReads++; return { walletId, groups: [group] }; },
  }, override: async method => {
    if (method === 'getaddressutxos') { entered.resolve(); await release.promise; }
  } });
  const live = new LiveBalance({ session, allowed: () => true, setTimer: () => 1, clearTimer: () => {} });
  const loading = session.loadWallet(info({ accounts: members }));
  try {
    await entered.promise;
    const generation = session.generation;
    live.notify({ address: walletId, reason: 'connected', tip, reorg: false, resync_required: false });
    assert.equal(session.generation, generation);
    assert.equal(session.pendingRefreshes, 1);
    assert.equal(session.state.busy, true);
  } finally { release.resolve(); }
  assert.equal(await loading, true);
  const beforeCatchUp = calls.length;
  await live.flush();
  assert.deepEqual(calls.slice(beforeCatchUp).map(call => call.method), ['getaddresschanges']);
  assert.equal(calls.filter(call => call.method === 'getaddresshistory').length, 0);
  assert.equal(seedReads, 1);
  assert.equal(session.state.verifiedAddresses.length, 41);
  assert.equal(availableSendAmount(session.state), '1');
});

test('interrupted discovery reuse survives cancellation, disconnect and backgrounding until a snapshot commits', async () => {
  for (const action of ['cancel', 'disconnect', 'background']) {
    const entered = deferred(), release = deferred(); let seedReads = 0;
    const group = recoveryGroup(accounts, { [walletId]: [history(1, '10000000000')] });
    const { session, calls } = fixture({ utxos: { [walletId]: [utxo(1, '10000000000')] }, options: {
      readRecoverySnapshots: async () => { seedReads++; return { walletId, groups: [group] }; },
    }, override: async method => {
      if (method === 'getaddressutxos') { entered.resolve(); await release.promise; }
    } });
    const loading = session.loadWallet(info());
    try {
      await entered.promise;
      if (action === 'cancel') session.invalidate();
      else if (action === 'disconnect') session.disconnectWatch();
      else session.setEnvironment({ active: false });
    } finally { release.resolve(); }
    assert.equal(await loading, false);
    assert.equal(session.recoveryConsumed, false);
    assert.equal(session.journal, null);
    assert.equal(session.pendingRefreshes, 0);
    assert.equal(availableSendAmount(session.state), null);
    if (action === 'background') session.setEnvironment({ active: true });
    assert.equal(await session.refresh(), true);
    assert.equal(seedReads, 2);
    assert.equal(calls.filter(call => call.method === 'getaddresshistory').length, 0);
    assert.equal(session.recoveryConsumed, true);
    assert.equal(availableSendAmount(session.state), '1');
  }
});

test('an older registration ACK cannot reset a newer partial snapshot but live rollbacks still invalidate it', async () => {
  for (const reason of ['connected', 'tip']) {
    const entered = deferred(), release = deferred(), published = deferred();
    const group = recoveryGroup(accounts, { [walletId]: [history(1, '10000000000')] });
    const newerTip = { ...tip, height: 201, hash: hash(201) };
    const { session, calls } = fixture({ utxos: { [walletId]: [utxo(1, '10000000000')] }, options: {
      readRecoverySnapshots: async () => ({ walletId, groups: [group] }),
      onChange: state => { if (state.partial && state.tip.height === 201) published.resolve(); },
    }, override: async method => {
      if (method === 'getaddressutxos') { entered.resolve(); await release.promise; }
      if (method === 'getaddresschanges') return journal({ tip: newerTip });
    } });
    const live = new LiveBalance({ session, allowed: () => true, setTimer: () => 1, clearTimer: () => {} });
    const loading = session.loadWallet(info());
    try {
      await entered.promise; await published.promise;
      const generation = session.generation;
      live.notify({ address: walletId, reason, tip, reorg: false, resync_required: false });
      assert.equal(session.generation === generation, reason === 'connected');
      assert.equal(session.recoveryConsumed, reason === 'tip');
      if (reason === 'connected') {
        assert.equal(session.displayTip.height, 201);
        assert.equal(session.state.busy, true);
        assert.equal(session.state.stale, false);
      } else assert.equal(session.state.stale, true);
    } finally { release.resolve(); }
    assert.equal(await loading, reason === 'connected');
    if (reason === 'connected') {
      const before = calls.length; await live.flush();
      assert.deepEqual(calls.slice(before).map(call => call.method), ['getaddresschanges']);
      assert.equal(calls.filter(call => call.method === 'getaddresshistory').length, 0);
      assert.equal(availableSendAmount(session.state), '1');
    }
  }
});

test('a transient funding read failure does not burn reusable recovery history', async () => {
  let fail = true;
  const group = recoveryGroup(accounts, { [walletId]: [history(1, '10000000000')] });
  const { session, calls } = fixture({ utxos: { [walletId]: [utxo(1, '10000000000')] }, options: {
    readRecoverySnapshots: async () => ({ walletId, groups: [group] }),
  }, override: method => {
    if (method === 'getaddressutxos' && fail) { fail = false; throw new Error('offline'); }
  } });
  assert.equal(await session.loadWallet(info()), false);
  assert.equal(session.recoveryConsumed, false);
  assert.equal(availableSendAmount(session.state), null);
  assert.equal(await session.refresh(), true);
  assert.equal(calls.filter(call => call.method === 'getaddresshistory').length, 0);
  assert.equal(availableSendAmount(session.state), '1');
});

test('a real listener reorg during recovery discards old hints and uses a fresh baseline', async () => {
  const entered = deferred(), release = deferred(); let replacement = false, seedReads = 0;
  const newTip = { ...tip, hash: hash(999) };
  const group = recoveryGroup(accounts, { [walletId]: [history(1, '10000000000')] });
  const { session, calls } = fixture({ options: {
    readRecoverySnapshots: async () => { seedReads++; return { walletId, groups: [group] }; },
  }, override: async (method, params) => {
    if (method === 'getaddressutxos' && !replacement) { entered.resolve(); await release.promise; }
    if (replacement) return method === 'getaddresschanges' ? journal({ tip: newTip }) : { ...page(params.address, []), tip: newTip };
  } });
  const live = new LiveBalance({ session, allowed: () => true, setTimer: () => 1, clearTimer: () => {} });
  const loading = session.loadWallet(info());
  try {
    await entered.promise;
    replacement = true;
    live.notify({ address: walletId, reason: 'connected', tip: newTip, reorg: true, resync_required: false });
  } finally { release.resolve(); }
  assert.equal(await loading, false);
  assert.equal(session.recoveryConsumed, true);
  assert.equal(await session.refresh(), true);
  assert.equal(seedReads, 1);
  assert.equal(calls.filter(call => call.method === 'getaddresshistory').length, accounts.length);
  assert.equal(session.state.tip.hash, newTip.hash);
  assert.equal(session.state.balance.total, '0');
});

test('account-set expansion during recovery can reuse old groups and queries only the added address', async () => {
  const members = makeAccounts(4), entered = deferred(), release = deferred();
  const group = recoveryGroup(members.slice(0, 3), { [walletId]: [history(1, '10000000000')] });
  const { session, calls } = fixture({ utxos: { [walletId]: [utxo(1, '10000000000')] }, options: {
    readRecoverySnapshots: async () => ({ walletId, groups: [group] }),
  }, override: async method => {
    if (method === 'getaddressutxos') { entered.resolve(); await release.promise; }
  } });
  const loading = session.loadWallet(info({ accounts: members.slice(0, 3) }));
  try {
    await entered.promise;
    assert.equal(await session.loadWallet(info({ accounts: members })), false);
  } finally { release.resolve(); }
  assert.equal(await loading, false);
  assert.equal(await session.refresh(), true);
  assert.deepEqual(calls.filter(call => call.method === 'getaddresshistory').map(call => call.params.address), [members[3].address]);
  assert.equal(session.state.verifiedAddresses.length, 4);
});

test('expired recovery checkpoint retries a fresh baseline once without exposing partial funds', async () => {
  const group = recoveryGroup(); group.sync.next_cursor = 'expired.0';
  const { session, calls } = fixture({ options: { readRecoverySnapshots: async () => ({ walletId, groups: [group] }) }, override: (method, params) => {
    if (method === 'getaddresschanges' && params.cursor === 'expired.0') throw Object.assign(new Error('expired'), { code: -32011 });
  } });
  assert.equal(await session.loadWallet(info()), true);
  assert.equal(calls.filter(call => call.params.cursor === 'expired.0').length, 1);
  assert.equal(calls.filter(call => call.method === 'getaddresshistory').length, accounts.length);
});

test('expired recovery HISTORY continuation also rebuilds once without manual refresh', async () => {
  const group = recoveryGroup(); group.histories[0].next_cursor = 'expired.history';
  const { session, calls } = fixture({ options: { readRecoverySnapshots: async () => ({ walletId, groups: [group] }) }, override: (method, params) => {
    if (params.cursor === 'expired.history') throw Object.assign(new Error('expired'), { code: -32011 });
  } });
  assert.equal(await session.loadWallet(info()), true);
  assert.equal(calls.filter(call => call.params.cursor === 'expired.history').length, 1);
  assert.equal(calls.filter(call => call.method === 'getaddresshistory' && !call.params.cursor).length, accounts.length);
});

test('expired recovery hints stay discarded even if the fresh fallback is interrupted by an RPC failure', async () => {
  let fail = true, seedReads = 0;
  const group = recoveryGroup(); group.sync.next_cursor = 'expired.0';
  const { session, calls } = fixture({ options: {
    readRecoverySnapshots: async () => { seedReads++; return { walletId, groups: [group] }; },
  }, override: (method, params) => {
    if (params.cursor === 'expired.0') throw Object.assign(new Error('expired'), { code: -32011 });
    if (method === 'getaddresshistory' && fail) { fail = false; throw new Error('offline'); }
  } });
  assert.equal(await session.loadWallet(info()), false);
  assert.equal(session.recoveryConsumed, true);
  assert.equal(await session.refresh(), true);
  assert.equal(seedReads, 1);
  assert.equal(calls.filter(call => call.params.cursor === 'expired.0').length, 1);
});

test('foreign, overlapping or malformed recovery hints cannot skip verified reads', async () => {
  for (const groups of [[recoveryGroup(), recoveryGroup()], [{ ...recoveryGroup(), histories: [] }],
    [{ ...recoveryGroup(), sync: journal({ has_more: true }) }]]) {
    const { session, calls } = fixture({ options: { readRecoverySnapshots: async () => ({ walletId, groups }) } });
    assert.equal(await session.loadWallet(info()), true);
    assert.equal(calls.filter(call => call.method === 'getaddresshistory').length, accounts.length);
  }
});

test('last known public snapshot loads before RPC completes, but never enables use-all until verified', async () => {
  let saved;
  const first = fixture({ histories: { [walletId]: [history(1, '10000000000')] }, utxos: { [walletId]: [utxo(1, '10000000000')] },
    options: { writeCache: async (_, value) => { saved = value; } } });
  await first.session.loadWallet(info()); await Promise.resolve();
  assert.equal(saved.version, 1);
  const entered = deferred(), release = deferred();
  const { session } = fixture({ options: { readCache: async () => saved }, override: async method => {
    if (method === 'getaddresschanges') { entered.resolve(); await release.promise; }
  } });
  const loading = session.loadWallet(info()); await entered.promise;
  assert.equal(session.state.cached, true); assert.equal(session.state.stale, true);
  assert.equal(session.state.balance.total, '10000000000'); assert.equal(session.state.history.length, 1);
  assert.equal(availableSendAmount(session.state), null);
  release.resolve(); assert.equal(await loading, true);
  assert.equal(session.state.cached, false); assert.equal(session.state.balance.total, '0');
});

test('queued cache writes cannot cross a wallet or RPC endpoint generation change', async () => {
  let changed = false;
  const saves = [];
  const { session } = fixture({ options: {
    writeCache: async (...value) => saves.push(value),
    onChange: state => {
      if (!changed && state.balance && !state.busy && !state.partial && state.updatedAt) {
        changed = true;
        // Endpoint replacement clears the account synchronously while the
        // completed old-server snapshot write is still queued as a microtask.
        session.clearAccount();
      }
    },
  } });
  await session.loadWallet(info());
  await Promise.resolve();
  assert.equal(changed, true);
  assert.equal(session.state.address, '');
  assert.deepEqual(saves, []);
});

test('an outdated cache read cannot overwrite a newer RPC snapshot or resurrect cleared accounts', async () => {
  let saved;
  const first = fixture({ options: { writeCache: async (_, value) => { saved = value; } } });
  await first.session.loadWallet(info()); await Promise.resolve();
  for (const clear of [true, false]) {
    const gate = deferred(); const { session } = fixture({ options: { readCache: async () => gate.promise } });
    const loading = session.loadWallet(info());
    if (clear) session.clearAccount(); else await session.refresh();
    gate.resolve(saved); assert.equal(await loading, false);
    assert.notEqual(session.state.cached, true);
    assert.equal(session.state.address, clear ? '' : walletId);
  }
});

test('HD native account descriptors reject foreign identity, duplicate paths, invalid networks and current change address', () => {
  assert.equal(nativeHdAccounts(info()).length, 3);
  assert.equal(nativeHdAccounts({ accountScope: 'first-receive-address' }), null);
  for (const patch of [{ walletId: accounts[1].address }, { account: accounts[2] }, { accounts: [] }, { accounts: [...accounts, accounts[0]] }, { accounts: accounts.map(a => ({ ...a, network: 'testnet4' })) }, { hd: {} }]) assert.throws(() => nativeHdAccounts(info(patch)));
});

test('aggregate receive/change balance is exact and one self transfer appears once with net wallet delta', async () => {
  const { session, maximum } = fixture({ histories: {
    [walletId]: [history(5, '0', '10000000000')],
    [accounts[2].address]: [history(5, '9999900000')],
  }, utxos: { [accounts[1].address]: [utxo(6, '20000000000')], [accounts[2].address]: [utxo(5, '9999900000')] } });
  assert.equal(await session.loadWallet(info()), true);
  assert.equal(maximum(), 3);
  assert.equal(availableSendAmount(session.state), '2.99999');
  assert.equal(session.state.history.length, 1);
  assert.equal(session.state.history[0].balance_delta, '-100000');
  assert.deepEqual(session.state.history[0].addresses, [walletId, accounts[2].address]);
});

test('recovery incomplete never reads or offers a partial balance', async () => {
  const { session, calls } = fixture();
  await session.loadWallet(info({ hd: { complete: false, recovering: true } }));
  assert.equal(calls.length, 0); assert.equal(session.state.hdComplete, false);
  assert.equal(availableSendAmount(session.state), null);
  await session.loadWallet(info());
  assert.equal(session.state.balance.confirmed, '0');
});

test('new receive address retains wallet identity, published funds and journal without RPC', async () => {
  const { session, calls } = fixture({ utxos: { [walletId]: [utxo(1, '10000000000')] } });
  await session.loadWallet(info()); const before = calls.length;
  await session.loadWallet(info({ account: accounts[1] }));
  assert.equal(session.state.address, walletId);
  assert.equal(session.state.receiveAddress, accounts[1].address);
  assert.equal(availableSendAmount(session.state), '1'); assert.equal(calls.length, before);
});

test('address updates use only the journal and ordinary tip notifications perform zero queries', async () => {
  const { session, calls } = fixture({ utxos: { [walletId]: [utxo(1, '10000000000')] } });
  await session.loadWallet(info()); const before = calls.length;
  session.observeTip({ ...tip, height: 201, hash: hash(201) });
  assert.equal(calls.length, before);
  await session.refresh();
  assert.deepEqual(calls.slice(before).map(c => c.method), ['getaddresschanges']);
});

test('failure in one branch publishes no partial total and settles all bounded workers', async () => {
  let failed = false;
  const { session, maximum } = fixture({ utxos: { [walletId]: [utxo(1, '10000000000')] }, override: (method, params) => {
    if (method === 'getaddressutxos' && params.address === accounts[1].address) { failed = true; throw new Error('offline'); }
  } });
  assert.equal(await session.loadWallet(info()), false);
  assert.equal(failed, true); assert.equal(session.state.balance, null);
  assert.equal(session.pendingRefreshes, 0); assert.equal(session.state.busy, false); assert.equal(maximum(), 3);
});

test('initial HD load has sixteen real concurrent reads and a free worker advances past slow siblings', { timeout: 5000 }, async () => {
  assert.equal(HD_READ_CONCURRENCY, 16);
  const allStarted = deferred(), nextStarted = deferred();
  const gates = Array.from({ length: 16 }, deferred);
  const started = [], finished = [];
  const { session, maximum } = fixture({ override: async (method, params) => {
    if (method !== 'getaddresshistory') return;
    const index = expandedAccounts.findIndex(account => account.address === params.address);
    started.push(index);
    if (started.length === 16) allStarted.resolve();
    if (index === 16) nextStarted.resolve();
    if (index < 16) await gates[index].promise;
    finished.push(index);
  } });
  const loading = session.loadWallet(info({ accounts: expandedAccounts }));
  try {
    await allStarted.promise;
    assert.deepEqual(started, Array.from({ length: 16 }, (_, i) => i));
    assert.equal(maximum(), 16);
    gates[15].resolve();
    await nextStarted.promise;
    assert.ok(finished.includes(15));
    assert.equal(finished.includes(0), false);
  } finally { for (const gate of gates) gate.resolve(); }
  assert.equal(await loading, true);
  assert.equal(maximum(), 16);
  assert.equal(started.length, expandedAccounts.length);
  assert.equal(session.state.addressCount, 40);
});

test('empty continuation history is exhausted, repeated cursor is rejected without publishing', async () => {
  for (const repeated of [false, true]) {
    const { session } = fixture({ override: (method, params) => {
      if (method === 'getaddresshistory' && params.address === walletId) return page(walletId, params.cursor && !repeated ? [history(1, '1')] : [], params.cursor && !repeated ? null : 'next.1');
    } });
    assert.equal(await session.loadWallet(info()), !repeated);
    assert.equal(session.state.history.length, repeated ? 0 : 1);
  }
});

test('a failed sibling stops further pages after the one in-flight read settles', async () => {
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const { session, calls } = fixture({ override: async (method, params) => {
    if (method !== 'getaddresshistory') return;
    if (params.address === walletId) { enter(); await held; return page(walletId, [], 'more.1'); }
    if (params.address === accounts[1].address) { await entered; setTimeout(release, 5); throw new Error('offline'); }
    await held;
  } });
  assert.equal(await session.loadWallet(info()), false);
  assert.equal(calls.filter(c => c.params.address === walletId).length, 1);
  assert.equal(calls.filter(c => c.method === 'getaddressutxos').length, 0);
  assert.equal(session.pendingRefreshes, 0);
});

test('sixteen in-flight reads drain on cancellation without starting queued addresses', { timeout: 5000 }, async () => {
  const entered = deferred(), release = deferred(); let started = 0;
  const { session, calls, maximum } = fixture({ override: async method => {
    if (method !== 'getaddresshistory') return;
    if (++started === 16) entered.resolve();
    await release.promise;
  } });
  const loading = session.loadWallet(info({ accounts: expandedAccounts }));
  try { await entered.promise; session.clearAccount(); }
  finally { release.resolve(); }
  assert.equal(await loading, false);
  assert.equal(maximum(), 16); assert.equal(started, 16);
  assert.equal(calls.filter(call => call.method === 'getaddressutxos').length, 0);
  assert.equal(session.state.balance, null); assert.equal(session.pendingRefreshes, 0);
});

test('duplicate outpoint across two owned addresses is rejected', async () => {
  const { session } = fixture({ utxos: { [walletId]: [utxo(1, '100')], [accounts[1].address]: [utxo(1, '100')] } });
  assert.equal(await session.loadWallet(info()), false);
  assert.equal(session.state.stale, true); assert.equal(availableSendAmount(session.state), null);
});

test('pending outgoing, pending change and immature mining outputs do not enter send-all', async () => {
  const { session } = fixture({ utxos: {
    [walletId]: [utxo(1, '10000000000', { pending_spent_by: hash(3) }), utxo(2, '40000000000', { coinbase: true, block_height: 199, confirmations: 2, mature: false })],
    [accounts[2].address]: [utxo(3, '9000000000', { status: 'pending', block_height: null, confirmations: 0 }), utxo(4, '20000000000')],
  } });
  assert.equal(await session.loadWallet(info()), true);
  assert.equal(availableSendAmount(session.state), '2');
  assert.equal(session.state.balance.pending_delta, '-1000000000');
  assert.equal(session.state.balance.immature, '40000000000');
});

test('locking/recovery generation changes cannot publish an old partial read', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const { session } = fixture({ override: async method => { if (method === 'getaddresshistory') { entered(); await blocked; } } });
  const loading = session.loadWallet(info()); await started;
  session.clearAccount(); release(); await loading;
  assert.equal(session.state.address, ''); assert.equal(session.state.balance, null); assert.equal(session.pendingRefreshes, 0);
});

test('reorg invalidates the journal and reloads baseline, stale cursor discards candidate', async () => {
  let expired = false;
  const { session, calls } = fixture({ override: method => { if (expired && method === 'getaddresschanges') throw Object.assign(new Error('expired'), { code: -32011 }); } });
  await session.loadWallet(info());
  const before = calls.length;
  assert.equal(session.observeTip({ ...tip, hash: hash(999) }), true);
  assert.equal(session.journal, null);
  await session.refresh(); assert.ok(calls.slice(before).some(c => c.method === 'getaddressutxos'));
  expired = true; await session.refresh(); assert.equal(session.journal, null); assert.equal(session.state.stale, true);
});

const makeAccounts = count => Array.from({ length: count }, (_, index) => ({
  address: bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.multiply(BigInt(index + 1)).toBytes(true).slice(1))]),
  network: 'main', index, change: 0, path: `m/44'/0'/0'/0/${index}`,
}));

test('48 verified addresses are spendable while later addresses wait, with at most 16 RPC reads', async () => {
  const large = makeAccounts(64), ready = deferred(), later = deferred(), saves = [];
  const amounts = Object.fromEntries(large.map((account, i) => [account.address, [utxo(i + 1, '10000000000')]]));
  const { session, maximum } = fixture({ utxos: amounts, options: {
    onChange: state => { if (state.partial && state.verifiedAddresses.length >= 48) ready.resolve(); },
    writeCache: async (_, saved) => saves.push(saved),
  }, override: async (method, params) => {
    if (method === 'getaddresshistory' && large.findIndex(account => account.address === params.address) >= 48) await later.promise;
  } });
  const loading = session.loadWallet(info({ accounts: large }));
  try {
    await ready.promise;
    assert.equal(session.state.busy, true); assert.equal(session.state.partial, true);
    assert.equal(session.state.verifiedAddresses.length, 48);
    assert.equal(session.state.fundingAddresses.length, 48);
    assert.equal(availableSendAmount(session.state), '48');
    assert.equal(session.journal, null); assert.equal(saves.length, 0);
    assert.ok(maximum() <= 16);
  } finally { later.resolve(); }
  assert.equal(await loading, true); await Promise.resolve();
  assert.equal(session.state.partial, false); assert.equal(availableSendAmount(session.state), '64');
  assert.equal(saves.length, 1); assert.equal(saves[0].balance.total, '640000000000');
});

test('a partial balance waits for all pages and journal replay, and scopes funding to spendable accounts only', async () => {
  const ready = deferred(), release = deferred();
  const { session, calls } = fixture({ utxos: { [accounts[1].address]: [utxo(2, '20000000000')] },
    options: { onChange: state => { if (state.partial && state.verifiedAddresses.length === 2) ready.resolve(); } },
    override: async (method, params) => {
      if (method === 'getaddressutxos' && params.address === walletId) {
        if (!params.cursor) return page(walletId, [utxo(1, '90000000000')], 'utxos.more');
        await release.promise; return page(walletId, []);
      }
      if (method === 'getaddresschanges' && params.cursor) return journal({ next_cursor: 'replayed.1', through_sequence: 1, changes: [
        { sequence: 1, address: accounts[1].address, kind: 'utxo', action: 'upsert', txid: hash(2), vout: 0,
          item: utxo(2, '20000000000', { pending_spent_by: hash(3) }) },
      ] });
    } });
  const loading = session.loadWallet(info());
  try {
    await ready.promise;
    assert.deepEqual(session.state.verifiedAddresses, accounts.slice(1).map(account => account.address));
    assert.equal(session.state.balance.pending_spent, '20000000000');
    assert.equal(availableSendAmount(session.state), null); assert.deepEqual(session.state.fundingAddresses, []);
    assert.ok(calls.some(call => call.method === 'getaddresschanges' && call.params.cursor));
  } finally { release.resolve(); }
  assert.equal(await loading, true); assert.equal(availableSendAmount(session.state), '9');
  assert.deepEqual(session.state.fundingAddresses, [walletId]);
});

test('partial funds are revoked on cancellation, reorg, wallet change or a later RPC failure', async () => {
  for (const action of ['cancel', 'reorg', 'wallet', 'failure']) {
    const ready = deferred(), release = deferred();
    const { session } = fixture({ utxos: { [walletId]: [utxo(1, '10000000000')] },
      options: { onChange: state => { if (state.partial && state.fundingAddresses.includes(walletId)) ready.resolve(); } },
      override: async (method, params) => {
        if (method === 'getaddresshistory' && params.address === accounts[2].address) {
          await release.promise; if (action === 'failure') throw new Error('offline');
        }
      } });
    const loading = session.loadWallet(info()); await ready.promise;
    assert.equal(availableSendAmount(session.state), '1');
    if (action === 'cancel') session.invalidate();
    if (action === 'reorg') session.observeTip({ ...tip, hash: hash(999) });
    if (action === 'wallet') session.clearAccount();
    release.resolve(); assert.equal(await loading, false);
    assert.equal(availableSendAmount(session.state), null); assert.equal(session.journal, null);
    assert.equal(session.pendingRefreshes, 0);
  }
});

test('busy partial journal cannot be retained as a complete wallet baseline on retry', async () => {
  const busySeen = deferred(), release = deferred(); let sequence = 0, moving = true;
  const groups = [recoveryGroup([accounts[0], accounts[2]], { [walletId]: [history(1, '10000000000')] }),
    recoveryGroup([accounts[1]], { [accounts[1].address]: [history(2, '20000000000')] })];
  groups[0].histories[1].next_cursor = 'later.page';
  const { session, calls } = fixture({ utxos: {
    [walletId]: [utxo(1, '10000000000')], [accounts[1].address]: [utxo(2, '20000000000')],
    [accounts[2].address]: [utxo(3, '30000000000')],
  }, options: { readRecoverySnapshots: async () => ({ walletId, groups }) }, override: async (method, params) => {
    if (method === 'getaddresshistory' && params.cursor === 'later.page') { await release.promise; return page(accounts[2].address, [history(3, '30000000000')]); }
    if (method === 'getaddresschanges' && params.cursor) {
      if (moving) sequence++;
      if (sequence >= 4) busySeen.resolve();
      return journal({ through_sequence: sequence, next_cursor: `moving.${sequence}` });
    }
  } });
  const loading = session.loadWallet(info());
  try {
    await busySeen.promise;
    assert.equal(session.journal, null);
    assert.ok(!session.state.verifiedAddresses.includes(accounts[2].address));
  } finally { moving = false; release.resolve(); }
  assert.equal(await loading, true);
  assert.equal(session.state.partial, false); assert.equal(availableSendAmount(session.state), '6');
  assert.ok(calls.some(call => call.method === 'getaddressutxos' && call.params.address === accounts[2].address));
});

test('1000 addresses reuse reconciled groups without quadratically repeating old checkpoints', async () => {
  const large = makeAccounts(1000), changes = [], publications = [];
  const session = new HdWalletSession({ onChange: state => { if (state.partial) publications.push(state.verifiedAddresses.length); },
    query: async (method, params) => {
      if (method === 'getaddresschanges') { changes.push(params); return journal(); }
      return page(params.address, []);
    } });
  assert.equal(await session.loadWallet(info({ accounts: large })), true);
  assert.ok(publications.length > 0); assert.equal(session.state.verifiedAddresses.length, 1000);
  // Ten starting checkpoints + incremental active groups + ten final deltas.
  assert.ok(changes.length < 110, `unexpected checkpoint requests: ${changes.length}`);
});

test('a funded second completion after an empty publication is not lost while all others wait', async () => {
  const emptyPublished = deferred(), fundedPublished = deferred(), second = deferred(), last = deferred();
  const { session } = fixture({ utxos: { [accounts[1].address]: [utxo(2, '20000000000')] }, options: {
    onChange: state => {
      if (state.partial && state.verifiedAddresses.length === 1) emptyPublished.resolve();
      if (state.partial && state.fundingAddresses.includes(accounts[1].address)) fundedPublished.resolve();
    },
  }, override: async (method, params) => {
    if (method === 'getaddresshistory' && params.address === accounts[1].address) await second.promise;
    if (method === 'getaddresshistory' && params.address === accounts[2].address) await last.promise;
  } });
  const loading = session.loadWallet(info());
  try {
    await emptyPublished.promise;
    // Let the first publisher's finally run before the second worker completes.
    await new Promise(resolve => setTimeout(resolve, 20)); second.resolve();
    await fundedPublished.promise;
    assert.equal(session.state.busy, true); assert.equal(availableSendAmount(session.state), '2');
    assert.deepEqual(session.state.fundingAddresses, [accounts[1].address]);
  } finally { second.resolve(); last.resolve(); }
  assert.equal(await loading, true);
});
