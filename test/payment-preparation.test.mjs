import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { WalletService } from '../src/core/wallet-service.mjs';
import { DEFAULT_CONFIG, GENESIS } from '../src/core/config.mjs';
import { deriveAccount, verifySchnorr } from '../src/core/crypto.mjs';
import { buildPaymentInWorker } from '../src/core/payment-builder.mjs';
import { COIN, MAX_PAYMENT_INPUTS, formatCoinAmount, parseCoinAmount, parseTransaction, serializeTransaction, signatureHash, transactionId } from '../src/core/transaction.mjs';

const mnemonic = 'abandon '.repeat(11) + 'about'; // Public test vector, never a real wallet.
const owner = deriveAccount(mnemonic, { network: 'main' });
const tip = { chain: 'main', genesis_hash: GENESIS.main, height: 100, hash: 'ab'.repeat(32), mediantime: 1800000000 };
const payment = { address: 'cc1pr6lfwrhp9h65ffn7zs20ce4r56zh3uvucuzxp0w6xp9yzx847c7qeejl6q', amount: '3' };
function coins(count, value = COIN / 50n) {
  return Array.from({ length: count }, (_, index) => {
    const parent = { version: 2, locktime: index,
      inputs: [{ txid: '12'.repeat(32), vout: 0, sequence: 0xffffffff, scriptSig: '', witness: ['02' + 'aa'.repeat(8191)] }],
      outputs: [{ type: 1, amount: String(value), publicKey: owner.publicKey }] };
    return { txid: transactionId(parent), vout: 0, amount: String(value), status: 'confirmed', mature: true,
      account: { index: 0, change: 0 }, rawTransaction: serializeTransaction(parent).toString('hex') };
  });
}
async function fixture(t, utxos) {
  const service = new WalletService({ directory: '/unused-payment-preparation-test' });
  service.config = structuredClone(DEFAULT_CONFIG);
  service.session = { data: { mnemonic, network: 'main', receiveIndex: 0, changeIndex: 0 }, password: 'unused' };
  service.utxos = utxos;
  await service.buildAccounts();
  const calls = [], parents = new Map(utxos.map(row => [row.txid, row.rawTransaction]));
  service.rpc = { async request(method, params) {
    calls.push(method);
    if (method === 'getchaintip') return tip;
    if (method === 'getaddressutxos') {
      const rows = params.address === owner.address ? utxos : [];
      const offset = Number(params.cursor ?? 0);
      return { tip, address: params.address, unit: 'connects', next_cursor: offset + 500 < rows.length ? String(offset + 500) : null,
        items: rows.slice(offset, offset + 500).map(({ rawTransaction, account, ...row }) => row) };
    }
    if (method === 'gettransaction') return { tip, transaction: { hex: parents.get(params.txid) } };
    if (method === 'gettransactions') return { tip, transactions: params.txids.map(txid => ({ txid, hex: parents.get(txid) })), remaining: [] };
    assert.fail(`Unexpected RPC ${method}; real broadcasting is prohibited in this fixture`);
  } };
  service.refresh = () => { assert.fail('A payment must not wait for display history'); };
  t.after(() => { service.cancelSendPreview(); service.statePublisher.close(); });
  return { service, calls };
}

test('3 CONN with hundreds of claim outputs prepares without history and fetches only required parents', async t => {
  const { service, calls } = await fixture(t, coins(1000));
  // A stuck background history refresh must not gate a foreground payment.
  service.refreshing = new Promise(() => {});
  const started = performance.now();
  let heartbeats = 0;
  const timer = setInterval(() => heartbeats++, 10);
  t.after(() => clearInterval(timer));
  const review = await service.previewSend(payment);
  const elapsed = performance.now() - started;
  assert.equal(review.amount, '3');
  const tx = parseTransaction(service.preview.hex);
  assert.equal(tx.inputs.length, 151);
  assert.equal(calls.filter(method => method === 'getaddressutxos').length, 2);
  assert.equal(calls.filter(method => method === 'gettransaction').length, 0);
  assert.equal(calls.filter(method => method === 'gettransactions').length, 5);
  assert.equal(calls.includes('getaddresshistory'), false);
  assert.equal(calls.includes('sendrawtransaction'), false);
  assert.ok(heartbeats >= 2, 'Main event loop stays responsive while signing');
  const spent = tx.inputs.map(() => ({ type: 1, amount: String(COIN / 50n), publicKey: owner.publicKey }));
  for (const index of [0, 75, 150]) assert.ok(verifySchnorr(Buffer.from(tx.inputs[index].witness[0], 'hex'), signatureHash(tx, spent, index), owner.publicKey));
  assert.equal(BigInt(service.preview.inputTotal), 3n * COIN + BigInt(service.preview.change) + BigInt(service.preview.fee));
  t.diagnostic(`151-input preparation, mocked local RPC: ${Math.round(elapsed)} ms; event-loop ticks: ${heartbeats}`);
});

test('an exact sufficient amount plus its fee does not fetch extra outputs for an arbitrary 0.01 CONN cushion', async t => {
  // One input, two P2PK outputs: 150 vB at 1500 connects/vB.
  const { service, calls } = await fixture(t, coins(100, 3n * COIN + 1000000n));
  await service.previewSend(payment);
  assert.equal(service.preview.selected.length, 1);
  assert.equal(calls.filter(method => method === 'gettransactions').length, 1);
});

test('all available funds can be spent with the fee deducted, including more than 256 claim outputs', async t => {
  const { service, calls } = await fixture(t, coins(301, COIN));
  const review = await service.previewSend({ ...payment, amount: '301', subtractFeeFromAmount: true });
  const tx = parseTransaction(service.preview.hex);
  assert.equal(tx.inputs.length, 301);
  assert.equal(tx.outputs.length, 1);
  assert.equal(service.preview.change, '0');
  assert.equal(review.requestedAmount, '301');
  assert.equal(review.subtractFeeFromAmount, true);
  assert.equal(review.total, '301');
  assert.equal(parseCoinAmount(review.amount) + parseCoinAmount(review.fee), 301n * COIN);
  assert.equal(tx.outputs[0].amount, parseCoinAmount(review.amount).toString());
  assert.equal(service.preview.amount, review.amount);
  assert.equal(calls.includes('sendrawtransaction'), false);
  assert.equal(calls.filter(method => method === 'gettransactions').length, 10);
  const spent = tx.inputs.map(() => ({ type: 1, amount: String(COIN), publicKey: owner.publicKey }));
  for (const index of [0, 150, 300]) assert.ok(verifySchnorr(Buffer.from(tx.inputs[index].witness[0], 'hex'), signatureHash(tx, spent, index), owner.publicKey));
});

test('fee deduction is opt-in, rejects truthy non-booleans and shows the actual recipient value', async t => {
  const { service, calls } = await fixture(t, coins(1, COIN));
  await assert.rejects(service.previewSend({ ...payment, amount: '1' }), /Insufficient/);
  for (const subtractFeeFromAmount of ['true', 'false', 1, null]) {
    await assert.rejects(service.previewSend({ ...payment, amount: '1', subtractFeeFromAmount }), /whether to deduct/);
    assert.equal(service.preview, null);
  }
  const review = await service.previewSend({ ...payment, amount: '1', subtractFeeFromAmount: true });
  assert.equal(review.total, '1');
  assert.equal(review.amount, formatCoinAmount(COIN - parseCoinAmount(review.fee)));
  assert.equal(calls.includes('sendrawtransaction'), false);
});

test('all-balance subtraction never includes unconfirmed, immature or reserved outputs', async t => {
  const rows = coins(4, COIN);
  const { service, calls } = await fixture(t, rows);
  rows[1].status = 'mempool'; rows[2].mature = false;
  service.reserved.add(`${rows[3].txid}:0`);
  await assert.rejects(service.previewSend({ ...payment, amount: '4', subtractFeeFromAmount: true }), /Insufficient/);
  const review = await service.previewSend({ ...payment, amount: '1', subtractFeeFromAmount: true });
  assert.equal(service.preview.selected.length, 1);
  assert.equal(review.total, '1');
  assert.equal(calls.includes('sendrawtransaction'), false);
});

test('a balance exceeding the standard input limit is not silently truncated or signed', async t => {
  const { service, calls } = await fixture(t, coins(MAX_PAYMENT_INPUTS + 1, COIN));
  await assert.rejects(service.previewSend({ ...payment, amount: String(MAX_PAYMENT_INPUTS + 1), subtractFeeFromAmount: true }), /too many inputs for one standard transaction/);
  assert.equal(service.preview, null);
  assert.equal(calls.includes('gettransactions'), false);
  assert.equal(calls.includes('sendrawtransaction'), false);
});

test('candidate retention keeps the only viable exact coin beyond the standard input count', async t => {
  const larger = coins(MAX_PAYMENT_INPUTS, 300000n), exact = coins(1, 200000n)[0];
  const { service, calls } = await fixture(t, [...larger, exact]);
  const review = await service.previewSend({ ...payment, amount: '0.00002', subtractFeeFromAmount: true });
  assert.equal(review.amount, '0.00000365');
  assert.equal(review.fee, '0.00001635');
  assert.equal(review.total, '0.00002');
  assert.equal(service.preview.change, '0');
  assert.deepEqual(service.preview.selected, [{ txid: exact.txid, vout: 0 }]);
  assert.equal(calls.filter(method => method === 'gettransactions').length, 1);
  assert.equal(calls.includes('sendrawtransaction'), false);
});

test('oversized small-coin selection does not hide a larger fresh coin on a later account', async t => {
  const rows = coins(MAX_PAYMENT_INPUTS, COIN);
  const { service, calls } = await fixture(t, rows);
  const other = service.publicAccount(1, 0);
  service.accounts = [service.publicAccount(0, 0), other];
  const request = service.rpc.request;
  service.rpc.request = (method, params) => {
    if (method === 'getaddressutxos' && params.address === other.address) return Promise.resolve({ tip, address: other.address, unit: 'connects', next_cursor: null,
      items: [{ txid: 'fe'.repeat(32), vout: 0, amount: String(10000n * COIN), status: 'confirmed', mature: true }] });
    return request(method, params);
  };
  const selected = await service.paymentFunding({ outputs: [{ domain: 'example.com', expectedConnections: '1', amount: String(BigInt(MAX_PAYMENT_INPUTS) * COIN) }],
    changeAddress: owner.address, network: 'main', subtractFeeFromAmount: true }, new AbortController().signal);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].txid, 'fe'.repeat(32));
  assert.equal(calls.includes('gettransactions'), false);
});

test('a dust-change top-up is disclosed separately from the network fee in the review', async t => {
  const { service } = await fixture(t, coins(1, COIN + 1n));
  const review = await service.previewSend({ ...payment, amount: '1', subtractFeeFromAmount: true });
  assert.ok(parseCoinAmount(review.changeAdjustment) > 0n);
  assert.equal(parseCoinAmount(review.total) + parseCoinAmount(review.changeAdjustment), COIN);
  assert.equal(parseCoinAmount(review.amount) + parseCoinAmount(review.fee), parseCoinAmount(review.total));
  assert.equal(BigInt(service.preview.change), parseCoinAmount(review.changeAdjustment) + 1n);
});

test('expensive fragmented candidates do not hide an economical coin on a later account', async t => {
  const { service } = await fixture(t, coins(100, 10000n));
  const other = service.publicAccount(1, 0);
  service.accounts = [service.publicAccount(0, 0), other];
  const request = service.rpc.request;
  service.rpc.request = (method, params) => {
    if (method === 'getaddressutxos' && params.address === other.address) return Promise.resolve({ tip, address: other.address, unit: 'connects', next_cursor: null,
      items: [{ txid: 'fe'.repeat(32), vout: 0, amount: String(COIN), status: 'confirmed', mature: true }] });
    return request(method, params);
  };
  const selected = await service.paymentFunding({ outputs: [{ address: owner.address, amount: '1000000' }],
    changeAddress: owner.address, network: 'main', subtractFeeFromAmount: true }, new AbortController().signal);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].txid, 'fe'.repeat(32));
});

test('fresh UTXO read excludes spent cached coins and refuses unconfirmed, immature and reserved funds', async t => {
  const utxos = coins(4, 4n * COIN);
  const { service, calls } = await fixture(t, utxos);
  service.utxos = [...utxos];
  utxos.shift(); // Cached output already spent; absent from current RPC response.
  utxos[0].status = 'mempool'; utxos[1].mature = false;
  service.reserved.add(`${utxos[2].txid}:0`);
  await assert.rejects(service.previewSend(payment), /Insufficient/);
  assert.equal(calls.includes('gettransaction'), false);
  assert.equal(service.preview, null);
});

test('forged funding amount cannot publish a preview or reach broadcast', async t => {
  const utxos = coins(1, COIN);
  const { service, calls } = await fixture(t, utxos);
  utxos[0].amount = String(4n * COIN);
  await assert.rejects(service.previewSend(payment), /amount/);
  assert.equal(service.preview, null);
  assert.equal(calls.includes('sendrawtransaction'), false);
});

test('cancel exits a pending UTXO lookup immediately and ignores late results', async t => {
  const { service } = await fixture(t, coins(1, 4n * COIN));
  let finish, entered;
  const gate = new Promise(resolve => { finish = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  service.page = async () => { entered(); return gate; };
  const pending = service.previewSend(payment);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started; service.cancelSendPreview(); await rejected;
  assert.equal(service.preview, null);
  finish([]); await tick();
  assert.equal(service.preview, null);
});

test('preparation reports the network check and validated UTXO pages without exposing addresses', async t => {
  const utxos = coins(2, 2n * COIN);
  const { service } = await fixture(t, utxos);
  const request = service.rpc.request, progress = [];
  service.emitState = () => { if (service.paymentPreparation) progress.push({ ...service.paymentPreparation }); };
  service.rpc.request = async (method, params) => {
    if (method === 'getchaintip') assert.deepEqual(service.paymentPreparation, { stage: 'network', completed: 0, total: 0, pages: 0 });
    if (method === 'getaddressutxos' && params.address === owner.address) {
      const index = params.cursor ? 1 : 0;
      if (index) assert.deepEqual(service.paymentPreparation, { stage: 'outputs', completed: 0, total: 2, pages: 1 });
      const { account, rawTransaction, ...row } = utxos[index];
      return { tip, address: params.address, unit: 'connects', items: [row], next_cursor: index ? null : 'next' };
    }
    return request(method, params);
  };
  const review = await service.previewSend(payment);
  assert.equal(review.amount, '3');
  assert.deepEqual(progress.filter(update => update.stage === 'outputs'), [
    { stage: 'outputs', completed: 0, total: 2, pages: 0 },
    { stage: 'outputs', completed: 0, total: 2, pages: 1 },
    { stage: 'outputs', completed: 0, total: 2, pages: 2 },
    { stage: 'outputs', completed: 1, total: 2, pages: 2 },
  ]);
  for (const update of progress) for (const [key, value] of Object.entries(update)) {
    if (key !== 'stage') assert.equal(typeof value, 'number');
  }
  assert.equal(service.paymentPreparation, null);
});

test('cancelled UTXO pages cannot publish late preparation progress', async t => {
  const utxos = coins(2, 2n * COIN);
  const { service } = await fixture(t, utxos);
  const request = service.rpc.request, progress = [];
  let finish, entered;
  const gate = new Promise(resolve => { finish = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  service.emitState = () => { if (service.paymentPreparation) progress.push({ ...service.paymentPreparation }); };
  service.rpc.request = async (method, params) => {
    if (method === 'getaddressutxos' && params.address === owner.address) {
      const index = params.cursor ? 1 : 0;
      if (index) { entered(); await gate; }
      const { account, rawTransaction, ...row } = utxos[index];
      return { tip, address: params.address, unit: 'connects', items: [row], next_cursor: index ? null : 'next' };
    }
    return request(method, params);
  };
  const rejected = assert.rejects(service.previewSend(payment), { name: 'AbortError' });
  await started;
  assert.deepEqual(progress.at(-1), { stage: 'outputs', completed: 0, total: 2, pages: 1 });
  service.cancelSendPreview();
  await rejected;
  const count = progress.length;
  finish(); await tick();
  assert.equal(progress.length, count);
  assert.equal(service.paymentPreparation, null);
  assert.equal(service.preview, null);
});

test('an invalid page cursor is rejected before that page advances preparation progress', async t => {
  const { service } = await fixture(t, coins(1, 4n * COIN));
  const request = service.rpc.request, progress = [];
  service.emitState = () => { if (service.paymentPreparation) progress.push({ ...service.paymentPreparation }); };
  service.rpc.request = async (method, params) => {
    const response = await request(method, params);
    return method === 'getaddressutxos' ? { ...response, next_cursor: {} } : response;
  };
  await assert.rejects(service.previewSend(payment), /invalid or repeated cursor/);
  assert.deepEqual(progress.filter(update => update.stage === 'outputs'), [{ stage: 'outputs', completed: 0, total: 2, pages: 0 }]);
  assert.equal(service.paymentPreparation, null);
});

test('worker cancellation interrupts cryptography and returns no private data', async () => {
  const controller = new AbortController();
  const utxos = coins(256);
  const pending = buildPaymentInWorker({ utxos, outputs: [{ address: owner.address, amount: String(5n * COIN) }],
    changeAddress: owner.address, network: 'main', mnemonic }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick(); controller.abort(); await rejected;
  await assert.rejects(buildPaymentInWorker({}, { signal: controller.signal }), { name: 'AbortError' });
});

test('bounded partial batches make progress, preserve order and never trust missing or forged parents', async t => {
  const utxos = coins(4, COIN);
  const { service } = await fixture(t, utxos);
  const request = service.rpc.request;
  let calls = 0;
  service.rpc.request = async (method, params) => {
    if (method !== 'gettransactions') return request(method, params);
    calls++;
    const txid = params.txids[0];
    return { tip, transactions: [{ txid, hex: utxos.find(row => row.txid === txid).rawTransaction }], remaining: params.txids.slice(1) };
  };
  await service.previewSend(payment);
  assert.equal(calls, 4);
  for (const broken of [
    { tip, transactions: [], remaining: utxos.map(row => row.txid) },
    { tip, transactions: [{ txid: utxos[1].txid, hex: utxos[1].rawTransaction }], remaining: utxos.slice(1).map(row => row.txid) },
    { tip, transactions: [{ txid: utxos[0].txid, hex: utxos[1].rawTransaction }], remaining: utxos.slice(1).map(row => row.txid) },
  ]) {
    service.fundingCache.clear();
    service.rpc.request = (method, params) => method === 'gettransactions' ? Promise.resolve(broken) : request(method, params);
    await assert.rejects(service.previewSend(payment), /Invalid RPC funding batch|do not match/);
    assert.equal(service.preview, null);
  }
});

test('legacy servers fall back only for unknown method, and batch errors never silently skip verification', async t => {
  const { service, calls } = await fixture(t, coins(1, 4n * COIN));
  const request = service.rpc.request;
  let probes = 0;
  service.rpc.request = (method, params) => {
    if (method === 'gettransactions') { probes++; throw Object.assign(new Error('Method not found'), { code: -32601 }); }
    return request(method, params);
  };
  await service.previewSend(payment);
  assert.equal(probes, 1); assert.equal(calls.filter(method => method === 'gettransaction').length, 1);
  service.fundingCache.clear(); await service.previewSend(payment);
  assert.equal(probes, 1, 'One capability probe per RPC client');
  for (const code of [-32011, -32029, -32002]) {
    service.fundingCache.clear(); service.batchFundingSupported = undefined;
    service.rpc.request = (method, params) => {
      if (method === 'gettransactions') throw Object.assign(new Error('Synthetic RPC error'), { code });
      return request(method, params);
    };
    await assert.rejects(service.previewSend(payment), error => error.code === code);
    assert.equal(service.preview, null);
  }
});

test('worker derives distinct receive/change paths and verifies each selected owner', async () => {
  const other = deriveAccount(mnemonic, { network: 'main', change: 1, index: 3 });
  try {
    const utxos = coins(1, 2n * COIN);
    const parent = parseTransaction(utxos[0].rawTransaction);
    parent.outputs[0].publicKey = other.publicKey;
    utxos.push({ ...utxos[0], txid: transactionId(parent), rawTransaction: serializeTransaction(parent).toString('hex'), account: { change: 1, index: 3 } });
    const result = await buildPaymentInWorker({ utxos, outputs: [{ address: owner.address, amount: String(3n * COIN) }], changeAddress: owner.address, network: 'main', mnemonic });
    const tx = parseTransaction(result.hex), spent = [owner, other].map(account => ({ type: 1, amount: String(2n * COIN), publicKey: account.publicKey }));
    for (const [index, account] of [owner, other].entries()) assert.ok(verifySchnorr(Buffer.from(tx.inputs[index].witness[0], 'hex'), signatureHash(tx, spent, index), account.publicKey));
    assert.equal(JSON.stringify(result).includes(mnemonic), false);
    utxos[1].account = { index: 0, change: 0 };
    await assert.rejects(buildPaymentInWorker({ utxos, outputs: [{ address: owner.address, amount: String(3n * COIN) }], changeAddress: owner.address, network: 'main', mnemonic }), /not owned/);
  } finally { other.privateKey.fill(0); }
});

test.after(() => owner.privateKey.fill(0));
