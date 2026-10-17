import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StatePublisher } from '../src/core/state-publisher.mjs';
import { WalletService } from '../src/core/wallet-service.mjs';
import { DEFAULT_CONFIG } from '../src/core/config.mjs';

function clock() {
  let time = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) {
      const timer = { unref() {} };
      timers.set(timer, { callback, at: time + delay });
      return timer;
    },
    clearTimer: timer => timers.delete(timer),
    get pending() { return timers.size; },
    advance(ms) {
      time += ms;
      for (const [timer, entry] of [...timers]) if (entry.at <= time && timers.delete(timer)) entry.callback();
    },
  };
}

test('publication bursts build only the newest snapshot at a bounded five updates per second', () => {
  const scheduler = clock(), observed = [];
  let latest = 0;
  const publisher = new StatePublisher({ ...scheduler, publish: () => observed.push(latest) });
  publisher.request();
  for (latest = 1; latest <= 1000; latest++) publisher.request();
  latest = 1000;
  assert.deepEqual(observed, [0]);
  assert.equal(scheduler.pending, 1);
  scheduler.advance(199);
  assert.deepEqual(observed, [0]);
  scheduler.advance(1);
  assert.deepEqual(observed, [0, 1000]);
  assert.equal(scheduler.pending, 0);
  for (let second = 0; second < 5; second++) {
    for (let i = 0; i < 1000; i++) { latest++; publisher.request(); }
    scheduler.advance(200);
  }
  assert.equal(observed.length, 7);
  assert.equal(observed.at(-1), 6000);
  publisher.close();
});

test('immediate transitions discard the pending event and cannot replay its old snapshot', () => {
  const scheduler = clock(), observed = [];
  let latest = 'unlocked';
  const publisher = new StatePublisher({ ...scheduler, publish: () => observed.push(latest) });
  publisher.request();
  latest = 'private progress'; publisher.request();
  assert.equal(scheduler.pending, 1);
  latest = 'locked'; publisher.request({ immediate: true });
  assert.equal(scheduler.pending, 0);
  scheduler.advance(1000);
  assert.deepEqual(observed, ['unlocked', 'locked']);
  latest = 'shutdown'; publisher.request(); publisher.request();
  publisher.close();
  assert.equal(scheduler.pending, 0);
  publisher.request({ immediate: true }); scheduler.advance(1000);
  assert.equal(observed.at(-1), 'shutdown');
});

function serviceFixture() {
  const scheduler = clock();
  const service = new WalletService({
    directory: '.', proofRunner: async () => '020100',
    clientFactory: () => Object.assign(new EventEmitter(), { close() {} }),
  });
  service.config = structuredClone(DEFAULT_CONFIG);
  service.walletExists = true;
  service.session = { data: { name: 'Fixture', receiveIndex: 0 } };
  service.epoch = 1;
  service.createEngine();
  service.statePublisher.close();
  let snapshots = 0;
  const originalGetState = service.getState.bind(service);
  service.getState = () => { snapshots++; return originalGetState(); };
  service.statePublisher = new StatePublisher({ ...scheduler, publish: () => service.emit('state', service.getState()) });
  const states = [];
  service.on('state', state => states.push(state));
  return { service, scheduler, states, get snapshots() { return snapshots; } };
}

test('one thousand claim updates coalesce before WalletService constructs full state', async () => {
  const fixture = serviceFixture(), { service, scheduler, states } = fixture;
  service.emitState();
  for (let attempts = 1; attempts <= 1000; attempts++) service.engine.notify({ attempts });
  assert.equal(fixture.snapshots, 1);
  assert.equal(states.length, 1);
  assert.equal(scheduler.pending, 1);
  scheduler.advance(200);
  assert.equal(fixture.snapshots, 2);
  assert.equal(states.at(-1).claims.attempts, 1000);
  await service.close();
});

test('transient failure and retry bursts coalesce without delaying a fatal error', async () => {
  const fixture = serviceFixture(), { service, scheduler, states } = fixture;
  service.engine.enabled = true; service.engine.notify({ status: 'searching' });
  const job = { diagnosticId: 1, failures: 0 };
  for (let attempt = 0; attempt < 1000; attempt++) {
    service.engine.jobError(job, new Error('TLS capture or proof validation failed'), 'proof', false);
    service.engine.notify({ status: 'waiting' });
    service.engine.notify({ status: 'submitting' });
    service.engine.notify({ status: 'searching', lastError: null });
  }
  assert.equal(fixture.snapshots, 1, 'failed attempts must not bypass the progress throttle');
  service.engine.jobError(job, new Error('TLS capture or proof validation failed'), 'proof', false);
  scheduler.advance(200);
  assert.equal(fixture.snapshots, 2);
  assert.equal(states.at(-1).claims.status, 'retrying');
  assert.equal(states.at(-1).claims.lastError, 'TLS capture or proof validation failed', 'a sustained retry warning remains available');
  assert.equal(states.at(-1).claims.lastErrorTransient, true);
  service.engine.fatal(Object.assign(new Error('Broadcast outcome unknown.'), { unknownOutcome: true }));
  assert.equal(states.at(-1).claims.enabled, false);
  assert.equal(states.at(-1).claims.lastError, 'Broadcast outcome unknown.');
  assert.equal(states.at(-1).claims.lastErrorTransient, false);
  assert.equal(states.at(-1).claims.lastErrorDiagnostic, false);
  scheduler.advance(200);
  assert.equal(states.at(-1).claims.enabled, false);
  assert.equal(states.at(-1).claims.lastError, 'Broadcast outcome unknown.');
  await service.close();
});

test('lock is immediate despite progress backlog, and close releases the final timer', async () => {
  const { service, scheduler, states } = serviceFixture();
  service.emitState();
  service.history = [{ txid: 'private-history-fixture' }];
  service.emitState();
  assert.equal(scheduler.pending, 1);
  let finishStop;
  const originalStop = service.engine.stop.bind(service.engine);
  service.engine.stop = () => new Promise(resolve => { finishStop = resolve; });
  const locking = service.lock();
  assert.equal(states.at(-1).phase, 'locked');
  assert.equal(states.at(-1).wallet, null);
  assert.deepEqual(states.at(-1).history, []);
  assert.equal(scheduler.pending, 0);
  const lockIndex = states.length - 1;
  finishStop(); await locking;
  scheduler.advance(1000);
  assert.ok(states.slice(lockIndex).every(state => state.phase === 'locked' && state.wallet === null && state.history.length === 0));
  service.engine.stop = originalStop;
  service.emitState();
  await service.close();
  const count = states.length;
  assert.equal(scheduler.pending, 0);
  scheduler.advance(1000); service.emitState();
  assert.equal(states.length, count);
});

test('critical errors, stopped claims and Developer Mode bypass progress delay', async () => {
  const { service, scheduler, states } = serviceFixture();
  service.engine.enabled = true;
  service.emitState();
  service.engine.notify({ attempts: 20 });
  service.engine.notify({ lastError: 'Broadcast outcome unknown.', lastErrorDiagnostic: false });
  assert.equal(states.at(-1).claims.lastError, 'Broadcast outcome unknown.');
  assert.equal(scheduler.pending, 0);
  const beforeStop = states.length;
  await service.engine.stop();
  assert.equal(states.length, beforeStop + 1);
  assert.equal(states.at(-1).claims.enabled, false);
  service.config.developerMode = true; service.emitState();
  assert.equal(states.at(-1).config.developerMode, true);
  service.error = 'RPC disconnected'; service.emitState();
  assert.equal(states.at(-1).error, 'RPC disconnected');
  await service.close();
});

function refreshGate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('automatic refresh constructs snapshots only for coalesced state publications', async () => {
  const fixture = serviceFixture(), { service, scheduler, states } = fixture;
  service.connectClient();
  const gate = refreshGate(); let reads = 0;
  service.refreshInternal = async () => { reads++; await gate.promise; service.walletReadRevision = service.walletUpdateRevision; };
  service.walletUpdateRevision++;
  const automatic = service.walletUpdates.run(), operation = service.refreshing;
  assert.ok(operation); assert.equal(reads, 1);
  assert.equal(fixture.snapshots, states.length);
  gate.resolve(); await automatic;
  assert.equal(await operation, undefined);
  assert.equal(service.refreshing, null);
  assert.equal(fixture.snapshots, states.length, 'the unused automatic return must not project history');
  scheduler.advance(200);
  assert.equal(fixture.snapshots, states.length);
  assert.equal(states.at(-1).busy, false);
  const before = fixture.snapshots;
  await service.walletUpdates.run();
  assert.equal(reads, 1); assert.equal(fixture.snapshots, before, 'an acknowledged revision requires no extra read or projection');
  await service.close();
});

test('manual callers join an automatic read and obtain independent final snapshots after busy clears', async () => {
  const fixture = serviceFixture(), { service, scheduler, states } = fixture;
  service.connectClient();
  const gate = refreshGate(); let reads = 0;
  service.history = [{ txid: 'public-fixture', confirmations: 2, status: 'confirmed', blockHeight: 1 }];
  service.refreshInternal = async () => { reads++; await gate.promise; };
  service.walletUpdateRevision++;
  const automatic = service.walletUpdates.run(), operation = service.refreshing;
  // Renderer parameters remain ignored; only the module's private marker can
  // suppress a return snapshot. Concurrent callers still share one read.
  const first = service.refresh({ returnState: false }), second = service.refresh(null);
  assert.equal(service.refreshing, operation); assert.equal(reads, 1);
  gate.resolve(); const [one, two] = await Promise.all([first, second]); await automatic;
  assert.equal(one.phase, 'unlocked'); assert.equal(one.busy, false); assert.equal(two.busy, false);
  assert.notEqual(one, two); assert.notEqual(one.history, two.history);
  assert.equal(fixture.snapshots, states.length + 2);
  scheduler.advance(200);
  assert.equal(fixture.snapshots, states.length + 2);
  assert.equal(states.at(-1).busy, false); assert.equal(reads, 1);
  await service.close();
});

test('manual refresh never returns history captured before a lock', async () => {
  const { service, scheduler, states } = serviceFixture();
  service.connectClient(); const gate = refreshGate();
  service.history = [{ txid: 'previous-private-history' }];
  service.refreshInternal = async () => { await gate.promise; };
  const pending = service.refresh();
  await service.lock(); const lockedIndex = states.length;
  gate.resolve(); const result = await pending;
  assert.equal(result.phase, 'locked'); assert.equal(result.wallet, null); assert.equal(result.busy, false);
  assert.deepEqual(result.history, []);
  scheduler.advance(1000);
  assert.ok(states.slice(lockedIndex).every(state => state.phase === 'locked' && state.history.length === 0));
  await service.close();
});

test('an old completion cannot clear a replacement connection read or return its old snapshot', async () => {
  const { service } = serviceFixture(); service.connectClient();
  const firstGate = refreshGate(), secondGate = refreshGate();
  service.refreshInternal = async () => { await firstGate.promise; };
  const first = service.refresh(), oldOperation = service.refreshing;
  service.epoch++; service.connectClient();
  service.network.height = 123; service.history = [{ txid: 'replacement-history' }];
  service.refreshInternal = async () => { await secondGate.promise; };
  const second = service.refresh(), replacementOperation = service.refreshing;
  assert.notEqual(replacementOperation, oldOperation);
  firstGate.resolve(); const oldCallerResult = await first;
  assert.equal(service.refreshing, replacementOperation);
  assert.equal(oldCallerResult.securityEpoch, service.epoch);
  assert.equal(oldCallerResult.busy, true); assert.equal(oldCallerResult.network.height, 123);
  assert.equal(oldCallerResult.history[0].txid, 'replacement-history');
  secondGate.resolve(); assert.equal((await second).busy, false);
  assert.equal(service.refreshing, null);
  await service.close();
});

test('a shared refresh failure reaches every caller without constructing return snapshots', async () => {
  const fixture = serviceFixture(), { service, states } = fixture;
  service.connectClient(); const gate = refreshGate(), error = new Error('isolated refresh failure');
  service.refreshInternal = async () => { await gate.promise; };
  service.walletUpdateRevision++;
  const automatic = service.walletUpdates.run(), manual = service.refresh();
  const automaticRejected = assert.rejects(automatic, value => value === error);
  const manualRejected = assert.rejects(manual, value => value === error);
  gate.reject(error); await Promise.all([automaticRejected, manualRejected]);
  assert.equal(service.refreshing, null); assert.equal(service.error, error.message);
  assert.equal(fixture.snapshots, states.length);
  assert.ok(service.walletReadRevision < service.walletUpdateRevision, 'failed work must not acknowledge its notification revision');
  await service.close();
});

function addressRotationFixture() {
  const fixture = serviceFixture(), { service } = fixture;
  const calls = { persisted: 0, refreshed: 0, requested: 0 };
  service.persist = async () => { calls.persisted++; };
  service.refresh = async () => { calls.refreshed++; };
  service.walletUpdates = { request() { calls.requested++; }, close() {} };
  service.buildAccounts = async () => {
    const index = service.session.data.receiveIndex;
    service.accounts = [
      { change: 1, index, address: 'change-address' },
      { change: 0, index: index - 1, address: 'previous-address' },
      { change: 0, index, address: `receive-address-${index}` },
    ];
  };
  service.makeQR = async () => { service.qrDataUrl = `current-qr-${service.session.data.receiveIndex}`; };
  return { fixture, calls };
}

test('address rotation returns the current address and QR without constructing an unused full snapshot', async () => {
  const { fixture, calls } = addressRotationFixture(), { service, scheduler, states } = fixture;
  service.history = Array.from({ length: 1000 }, (_, i) => ({ txid: `history-${i}` }));
  const result = await service.newAddress();
  assert.deepEqual(result, { address: 'receive-address-1', qrDataUrl: 'current-qr-1' });
  assert.deepEqual(calls, { persisted: 1, refreshed: 1, requested: 1 });
  assert.equal(fixture.snapshots, states.length, 'only state publications may project the history');
  assert.equal(states.at(-1).wallet.address, result.address);
  assert.equal(states.at(-1).wallet.qrDataUrl, result.qrDataUrl);
  scheduler.advance(200);
  assert.equal(fixture.snapshots, states.length);
  await service.close();
});

test('address rotation cannot return an earlier address after locking during QR generation', async () => {
  const { fixture, calls } = addressRotationFixture(), { service } = fixture;
  const entered = refreshGate(), finish = refreshGate();
  service.makeQR = async () => { entered.resolve(); await finish.promise; };
  const pending = service.newAddress();
  const rejected = assert.rejects(pending, /Wallet locked or changed/);
  await entered.promise; await service.lock(); finish.resolve(); await rejected;
  assert.equal(service.qrDataUrl, null); assert.deepEqual(service.accounts, []);
  assert.equal(calls.refreshed, 0);
  await service.close();
});

test('address rotation rechecks the session if a state listener locks it before the reply', async () => {
  const { fixture } = addressRotationFixture(), { service } = fixture;
  let locking;
  service.on('state', state => { if (state.phase === 'unlocked') locking = service.lock(); });
  await assert.rejects(service.newAddress(), /Wallet locked or changed/);
  await locking;
  assert.equal(service.session, null); assert.equal(service.qrDataUrl, null);
  await service.close();
});

function referenceHistoryProjection(service) {
  return service.session ? service.history.map(row => ({ ...row,
    ...(service.confirmationTip && !service.confirmationsStale && row.status === 'confirmed' &&
      Number.isSafeInteger(row.blockHeight) && row.blockHeight >= 0 && row.blockHeight <= service.confirmationTip.height
      ? { confirmations: service.confirmationTip.height - row.blockHeight + 1 } : {}),
    ...service.session.data.paymentDetails?.[row.txid] })) : [];
}

test('history display projection matches the original fields and ordering for every confirmation guard', async () => {
  const { service } = serviceFixture();
  const rows = [];
  for (const status of ['confirmed', 'pending']) {
    for (const blockHeight of [undefined, null, -1, 0, 90, 100, 101, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const row = { txid: `projection-${rows.length}`, direction: 'received', amount: '1', status };
      if (blockHeight !== undefined) row.blockHeight = blockHeight;
      if (rows.length % 2) row.confirmations = rows.length;
      rows.push(Object.freeze(row));
    }
  }
  service.history = Object.freeze(rows);
  const original = structuredClone(rows);
  for (const confirmationTip of [null, { height: 100 }]) {
    for (const stale of [false, true]) {
      for (const annotated of [false, true]) {
        service.confirmationTip = confirmationTip; service.confirmationsStale = stale;
        service.session.data.paymentDetails = annotated ? Object.freeze(Object.fromEntries(rows.filter((_, index) => index % 3 === 0)
          .map(row => [row.txid, Object.freeze({ label: `label-${row.txid}`, message: 'saved note' })]))) : undefined;
        const expected = referenceHistoryProjection(service), actual = service.getState().history;
        assert.deepEqual(actual, expected);
        assert.deepEqual(actual.map(Object.keys), expected.map(Object.keys), 'property ordering and absent fields remain unchanged');
      }
    }
  }
  assert.deepEqual(service.history, original);
  await service.close();
});

test('history projections preserve annotation precedence without sharing mutable row envelopes', async () => {
  const { service } = serviceFixture();
  service.history = Object.freeze([
    Object.freeze({ txid: 'plain-row', status: 'confirmed', blockHeight: 90, confirmations: 1 }),
    Object.freeze({ txid: 'annotated-row', status: 'confirmed', blockHeight: 90, confirmations: 1 }),
  ]);
  // Keep the exact existing final-spread semantics even if an internal test or
  // future annotation schema supplies a field also present in the projection.
  const detail = Object.freeze({ label: 'saved label', confirmations: 77 });
  service.session.data.paymentDetails = Object.freeze({ 'annotated-row': detail });
  service.confirmationTip = { height: 100 };
  const first = service.getState(), second = service.getState();
  assert.deepEqual(first.history, referenceHistoryProjection(service));
  assert.equal(first.history[0].confirmations, 11); assert.equal(first.history[1].confirmations, 77);
  assert.notEqual(first.history, second.history);
  for (let index = 0; index < first.history.length; index++) {
    assert.notEqual(first.history[index], service.history[index]);
    assert.notEqual(first.history[index], second.history[index]);
    first.history[index].confirmations = -1;
    first.history[index].label = 'changed by caller';
  }
  assert.equal(second.history[0].confirmations, 11); assert.equal(second.history[1].label, 'saved label');
  assert.equal(service.history[0].confirmations, 1); assert.equal(detail.label, 'saved label');
  assert.deepEqual(service.getState().history, second.history);
  await service.close();
});

test('history display projection does not cache confirmations across stale tips, fresh tips or locks', async () => {
  const { service } = serviceFixture();
  service.history = [{ txid: 'confirmed-row', status: 'confirmed', blockHeight: 90, confirmations: 2 },
    { txid: 'pending-row', status: 'pending', blockHeight: null, confirmations: 0 }];
  service.confirmationTip = { height: 100 };
  const first = service.getState().history;
  assert.deepEqual(first.map(row => row.confirmations), [11, 0]);
  service.confirmationsStale = true;
  assert.deepEqual(service.getState().history.map(row => row.confirmations), [2, 0]);
  service.confirmationsStale = false; service.confirmationTip = { height: 101 };
  assert.deepEqual(service.getState().history.map(row => row.confirmations), [12, 0]);
  assert.deepEqual(first.map(row => row.confirmations), [11, 0]);
  await service.lock();
  assert.deepEqual(service.getState().history, []);
  await service.close();
});

test('history projection retains the complete row order without truncation', async () => {
  const { service } = serviceFixture();
  service.history = Array.from({ length: 10001 }, (_, index) => ({ txid: `history-${index}`, status: 'confirmed', blockHeight: index, confirmations: 1 }));
  service.confirmationTip = { height: 10001 };
  const result = service.getState().history;
  assert.equal(result.length, 10001);
  assert.deepEqual(result, referenceHistoryProjection(service));
  assert.equal(result[0].txid, 'history-0'); assert.equal(result.at(-1).txid, 'history-10000');
  await service.close();
});
