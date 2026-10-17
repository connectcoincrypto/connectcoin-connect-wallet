import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransactionDetails } from '../src/transaction-details.mjs';

const row = { txid: 'a'.repeat(64), status: 'confirmed', confirmations: 3, block_height: 10,
  block_hash: 'b'.repeat(64), received: '10000000000', spent: '2000000000', balance_delta: '8000000000' };
const state = () => ({ address: 'verified-owner', history: [{ ...row }], stale: false, historyStale: false, confirmationsStale: false });
function fixture() {
  // Minimal synchronous DOM surface; no browser/network/native bridge.
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { text: '', writes: 0,
      get textContent() { return this.text; }, set textContent(value) { this.text = value; this.writes++; },
      hidden: false, open: false, disabled: false,
      handlers: new Map(), addEventListener(event, listener) { this.handlers.set(event, listener); },
      close() { this.open = false; }, showModal() { this.open = true; },
      querySelectorAll() { return []; }, focus() { this.focused = true; } });
    return elements.get(id);
  } };
  const fixture = { state: state(), reads: 0, calls: [], permitted: true, explorer: async () => {} };
  fixture.$ = id => document.getElementById(id);
  fixture.view = createTransactionDetails({ document, readState: () => { fixture.reads++; return fixture.state; },
    canOpenExplorer: () => fixture.permitted,
    openExplorer: async txid => { fixture.calls.push(txid); await fixture.explorer(); } });
  return fixture;
}

test('opening details uses one current snapshot and supplied render frames do not reread/project history', () => {
  const f = fixture(); f.view.open(row.txid);
  assert.equal(f.reads, 1); assert.equal(f.view.isOpen(), true);
  assert.equal(f.$('transaction-net').textContent, '0.8 CONN');
  const frame = { ...state(), history: [{ ...row, confirmations: 8, received: '30000000000', balance_delta: '28000000000' }] };
  f.view.render(frame);
  assert.equal(f.reads, 1);
  assert.equal(f.$('transaction-confirmations').textContent, '8');
  assert.equal(f.$('transaction-net').textContent, '2.8 CONN');
  // Frames are not cached: the next independent render rereads the current state.
  f.state.history[0].confirmations = 9;
  f.view.render();
  assert.equal(f.reads, 2); assert.equal(f.$('transaction-confirmations').textContent, '9');
});

test('supplied frames preserve stale warnings, pending details and owner/removal invalidation', () => {
  for (const staleFlag of ['stale', 'historyStale', 'confirmationsStale']) {
    const f = fixture(); f.view.open(row.txid);
    f.view.render({ ...state(), [staleFlag]: true, history: [{ ...row, status: 'pending', confirmations: 0, block_height: null, block_hash: null }] });
    assert.equal(f.$('transaction-stale').hidden, false);
    assert.equal(f.$('transaction-status').textContent, 'Unconfirmed');
    assert.equal(f.$('transaction-block').hidden, true);
    assert.equal(f.$('transaction-block-height').textContent, '');
    assert.equal(f.$('transaction-block-hash').textContent, '');
    assert.equal(f.reads, 1);
  }
  for (const invalidation of [{ ...state(), address: 'another-owner' }, { ...state(), history: [] }]) {
    const f = fixture(); f.view.open(row.txid); f.view.render(invalidation);
    assert.equal(f.view.isOpen(), false); assert.equal(f.reads, 1);
    f.view.render(); assert.equal(f.reads, 1);
  }
});

test('explorer actions reread current state and asynchronous completion never uses the old supplied frame', async () => {
  const f = fixture(); let resolve;
  f.explorer = () => new Promise(done => { resolve = done; });
  f.view.open(row.txid);
  const action = f.$('transaction-open-explorer').handlers.get('click')();
  assert.equal(f.reads, 2); assert.deepEqual(f.calls, [row.txid]);
  assert.equal(f.$('transaction-open-explorer').disabled, true);
  f.state = { ...state(), address: 'replacement-owner' };
  resolve(); await action;
  assert.equal(f.reads, 3); assert.equal(f.view.isOpen(), false);
});

test('an explorer click after ownership/removal changes cannot open the obsolete transaction', async () => {
  for (const replacement of [{ ...state(), address: 'another-owner' }, { ...state(), history: [] }]) {
    const f = fixture(); f.view.open(row.txid);
    f.state = replacement;
    await f.$('transaction-open-explorer').handlers.get('click')();
    assert.equal(f.reads, 2); assert.deepEqual(f.calls, []); assert.equal(f.view.isOpen(), false);
  }
});

test('identical detail frames reuse only the three formatted amounts while reading current state', t => {
  const originalBigInt = globalThis.BigInt;
  let conversions = 0;
  t.mock.method(globalThis, 'BigInt', value => { conversions++; return originalBigInt(value); });
  const f = fixture(); f.view.open(row.txid);
  assert.equal(conversions, 3);
  for (let index = 0; index < 100; index++) {
    // New row and snapshot objects must not invalidate scalar presentation.
    f.state = { ...state(), history: [{ ...row, confirmations: 4 + index }], stale: index % 2 === 0 };
    f.view.render();
    assert.equal(f.$('transaction-confirmations').textContent, String(4 + index));
    assert.equal(f.$('transaction-stale').hidden, index % 2 !== 0);
  }
  assert.equal(f.reads, 101);
  assert.equal(conversions, 3);
  for (const id of ['received', 'spent', 'net']) assert.equal(f.$(`transaction-${id}`).writes, 1);
  assert.equal(f.$('transaction-net').textContent, '0.8 CONN');
});

test('changed amounts are formatted independently and malformed replacements never become cache hits', t => {
  const originalBigInt = globalThis.BigInt;
  let conversions = 0;
  t.mock.method(globalThis, 'BigInt', value => { conversions++; return originalBigInt(value); });
  const f = fixture(); f.view.open(row.txid);
  f.state.history[0].spent = '30000000001';
  f.state.history[0].balance_delta = '-20000000001';
  f.view.render();
  assert.equal(conversions, 5);
  assert.equal(f.$('transaction-received').writes, 1);
  assert.equal(f.$('transaction-spent').textContent, '3.0000000001 CONN');
  assert.equal(f.$('transaction-net').textContent, '-2.0000000001 CONN');
  for (const malformed of [null, undefined, 10000000000, '01', '1.0', '-0', '1000000000000000001']) {
    f.state.history[0].received = malformed;
    assert.throws(() => f.view.render());
    assert.throws(() => f.view.render());
    assert.equal(f.$('transaction-received').textContent, '1 CONN');
    const first = fixture(); first.state.history[0].received = malformed;
    assert.throws(() => first.view.open(row.txid));
    assert.throws(() => first.view.open(row.txid));
  }
  f.state.history[0].received = '9999999999';
  f.view.render();
  assert.equal(f.$('transaction-received').textContent, '0.9999999999 CONN');
  f.state.history[0].received = row.received;
  f.view.render();
  assert.equal(f.$('transaction-received').textContent, '1 CONN');
});

test('closing, reopening and replacing the selected transaction cannot reuse an earlier presentation', t => {
  const originalBigInt = globalThis.BigInt;
  let conversions = 0;
  t.mock.method(globalThis, 'BigInt', value => { conversions++; return originalBigInt(value); });
  const f = fixture(); f.view.open(row.txid);
  f.view.close(); f.view.open(row.txid);
  assert.equal(conversions, 6);
  const another = { ...row, txid: 'c'.repeat(64), received: '1', spent: '0', balance_delta: '1' };
  f.state.history.push(another); f.view.open(another.txid);
  assert.equal(conversions, 9);
  assert.equal(f.$('transaction-net').textContent, '0.0000000001 CONN');
  f.state = { ...state(), address: 'another-owner' };
  f.view.render(); assert.equal(f.view.isOpen(), false);
  f.view.open(row.txid); assert.equal(conversions, 12);
  assert.equal(f.$('transaction-address').textContent, 'another-owner');
  assert.equal(f.$('transaction-net').textContent, '0.8 CONN');
});
