import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { WalletService } from '../src/core/wallet-service.mjs';
import { GENESIS } from '../src/core/config.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';

const PASSWORD = 'local-test-password-only';
const tip = { chain:'testnet4',height:999,hash:'a'.repeat(64),mediantime:1789500000,genesis_hash:GENESIS.testnet4 };
class Backend extends EventEmitter {
  constructor() { super(); this.socket = {}; this.calls = []; this.negative = false; }
  async connect() { if (!this.socket) { this.socket = {}; this.emit('connected'); } return this.socket; }
  async request(method, params) {
    this.calls.push([method,params]);
    if (['subscribetip', 'subscribebounties', 'subscribeaddress'].includes(method)) return {
      subscription_id: `${method}-${params?.address ?? 'global'}`, tip, cursor: 'fixture-journal',
    };
    if (method === 'unsubscribe') return { removed: true };
    if(method==='getchaintip')return tip;
    if(method==='getaddressbalance')return {tip,address:params.address,unit:'connects',confirmed:'10000000000',available_confirmed:'0',immature:'0',pending_delta:this.negative?'-10000000000':'0'};
    if(['getaddresshistory','getaddressutxos'].includes(method))return {tip,address:params.address,unit:'connects',items:[],next_cursor:null};
    throw new Error('Unexpected mock RPC request '+method);
  }
  close() { this.socket=null; }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'connectwallet-service-test-'));
  const service = new WalletService({directory,clientFactory:()=>new Backend(),proofRunner:async()=> '020100'});
  await service.initialize();
  t.after(async()=>{await service.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+ '\\connectwallet-service-test-') || resolve(directory).startsWith(resolve(tmpdir())+'/connectwallet-service-test-'));await rm(directory,{recursive:true,force:true});});
  return service;
}
async function create(service) {
  const setup=await service.prepareWallet({name:'Test wallet',password:PASSWORD,wordCount:12});
  const words=setup.mnemonic.split(' ');
  const answers=Object.fromEntries(setup.checkIndexes.map(index=>[index,words[index]]));
  await service.confirmWallet({setupId:setup.setupId,answers});
  await service.refresh();
  // Tests deliberately start their own mocked engine or snapshot RPC counters.
  // Drain initial registration catch-ups first, including their debounce timer,
  // so those independent operations cannot race the behavior being asserted.
  let idle = false;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const live = service.liveUpdates;
    idle = live.baseReady && service.accounts.every(account => live.registrations.has(`address:${account.address}`)) &&
      !service.refreshing && !service.bountySync && !live.running && !live.requested &&
      !live.retryTimer && !live.addressTimer && !live.addressPending &&
      [service.walletUpdates, service.bountyUpdates].every(queue => !queue.running && !queue.timer && !queue.dirty);
    if (idle) break;
    await new Promise(done => setTimeout(done, 5));
  }
  assert.ok(idle, 'Initial live subscription catch-ups must finish before the test takes ownership');
  return setup;
}

test('transient claim failure remains on disk and in history after a successful next bounty', async t => {
  const s = await fixture(t);
  await s.setDeveloperMode({ enabled: true });
  const setup = await create(s);
  s.engine.setOptions({ connectionsPerSecond: 256, concurrency: 1 });
  s.engine.prepare = async item => {
    if (item.vout === 0) throw Object.assign(new Error('untrusted diagnostic canary ' + PASSWORD), { code: -32020, data: { node_code: -26 } });
    return { context: { domain: 'example.com', txid: '01'.repeat(32), input_index: 0,
      connection_work_target: 'ff'.repeat(32), root_certificates_version: 1, signature_algorithms_mask: 7, validation_time: 1800000000 } };
  };
  s.engine.submit = async prepared => prepared.context.txid;
  s.engine.enqueue([0, 1].map(vout => ({ txid: '02'.repeat(32), vout, amount: vout === 0 ? '2000000000' : '1000000000', domain: 'example.com', connection_work_target: 'f'.repeat(64), signature_algorithms_mask: 7, root_certificates_version: 1, status: 'available' })));
  s.engine.start();
  for (let i = 0; i < 100 && s.engine.snapshot().completed !== 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(s.engine.snapshot().completed, 1);
  assert.equal(s.engine.snapshot().lastError, null);
  assert.equal(s.engine.enabled, true);
  const recent = s.getState().diagnostics.recent;
  assert.equal(recent.at(-1).event, 'claim.failed');
  assert.equal(recent.at(-1).details.error.code, -32020);
  assert.equal(recent.at(-1).details.error.nodeCode, -26);
  assert.equal(recent.at(-1).details.stage, 'prepare');
  await s.diagnostics.flush();
  const text = await readFile(s.diagnostics.snapshot().file, 'utf8');
  for (const secret of [setup.mnemonic, PASSWORD, 'untrusted diagnostic canary', s.getState().wallet.address, '02'.repeat(32)]) assert.ok(!text.includes(secret));
  const rows = text.trim().split('\n').map(JSON.parse);
  assert.ok(rows.find(row => row.event === 'claim.failed'));
  assert.ok(rows.find(row => row.event === 'claim.succeeded'));
});
test('wallet creation requires backup verification and writes only encrypted data',async t=>{
  const s=await fixture(t);
  const setup=await s.prepareWallet({name:'Test wallet',password:PASSWORD,wordCount:18});
  await assert.rejects(s.confirmWallet({setupId:setup.setupId,answers:{}}),/backup words/);
  assert.equal(s.walletExists,false);
  s.cancelSetup();
  const created=await create(s);
  assert.equal(s.getState().phase,'unlocked');
  assert.equal(s.getState().claims.enabled,false);
  assert.match(s.getState().wallet.address,/^tcc1p/);
  assert.match(s.getState().wallet.qrDataUrl,/^data:image\/png;base64,/);
  const file=await readFile(s.vaultFile,'utf8');
  assert.ok(!file.includes(created.mnemonic));assert.ok(!file.includes(PASSWORD));
  assert.ok(!JSON.stringify(s.getState()).includes(created.mnemonic));
  assert.ok(s.rpc.calls.every(([,params])=>!JSON.stringify(params ?? {}).includes(created.mnemonic)));
});
test('negative pending deltas render exactly; locks invalidate previews and remove secrets',async t=>{
  const s=await fixture(t);await create(s);
  s.rpc.negative=true;await s.refresh();
  assert.equal(s.getState().wallet.balance.pending,'-2');
  s.preview={previewId:'stale'};
  await s.lock();
  assert.equal(s.getState().phase,'locked');assert.equal(s.getState().wallet,null);assert.equal(s.session,null);assert.equal(s.preview,null);
  await assert.rejects(s.getRecoveryPhrase({password:PASSWORD}),/locked/);
  await assert.rejects(s.unlock({password:'not-the-password'}),/incorrect password/);
  await s.unlock({password:PASSWORD});await s.refresh();assert.equal(s.getState().phase,'unlocked');
});
test('locking during password derivation cancels unlock without reviving keys',async t=>{
  const s=await fixture(t);await create(s);await s.lock();
  const pending=s.unlock({password:PASSWORD});await s.lock();
  await assert.rejects(pending,/cancelled/);assert.equal(s.session,null);
});
test('receive rotation persists and a stale review never broadcasts',async t=>{
  const s=await fixture(t);await create(s);
  const old=s.getState().wallet.address;
  const next=await s.newAddress();assert.notEqual(next.address,old);
  await s.lock();await s.unlock({password:PASSWORD});await s.refresh();
  assert.equal(s.getState().wallet.address,next.address);
  await assert.rejects(s.confirmSend({previewId:'invented'}),/expired/);
  assert.ok(s.rpc.calls.every(([method])=>method!=='sendrawtransaction'));
});
test('restoration keeps watching unused addresses and finds a later payment at the gap edge',async t=>{
  const s=await fixture(t);
  const mnemonic='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  await s.restoreWallet({name:'Restored',password:PASSWORD,mnemonic});await s.refresh();
  assert.equal(s.session.data.scanLookahead,true);
  assert.ok(s.accounts.some(a=>a.change===0&&a.index===19));
  assert.ok(s.accounts.some(a=>a.change===1&&a.index===19));
  const account=deriveAccount(mnemonic,{index:19,change:0});account.privateKey.fill(0);
  const original=s.rpc.request.bind(s.rpc);
  s.rpc.request=async(method,params)=>{
    if(method==='getaddresshistory'&&params.address===account.address)return {tip,address:account.address,unit:'connects',items:[{txid:'b'.repeat(64),status:'confirmed',block_height:10,confirmations:990,received:'10000000000',spent:'0',balance_delta:'10000000000'}],next_cursor:null};
    return original(method,params);
  };
  await s.refresh();
  assert.equal(s.history.length,1);assert.equal(s.history[0].amount,'1');
  assert.equal(s.session.data.lastUsedReceive,19);
  assert.ok(s.accounts.some(a=>a.change===0&&a.index===39));
});

test('late network and QR completions cannot repopulate locked state',async t=>{
  const s=await fixture(t);await create(s);
  let complete;
  s.rpc.request=()=>new Promise(resolve=>{complete=resolve;});
  const network=s.ensureNetwork();
  const qr=s.makeQR();
  await s.lock();complete(tip);
  await assert.rejects(network,/locked or changed/);await qr;
  assert.equal(s.getState().network.status,'offline');
  assert.equal(s.qrDataUrl,null);assert.equal(s.session,null);
});

test('wallet locking gives the claims engine a distinct cancellation reason', async t => {
  const s = await fixture(t); await create(s);
  const reasons = [], stop = s.engine.stop.bind(s.engine);
  s.engine.stop = reason => { reasons.push(reason); return stop(reason); };
  await s.lock();
  assert.equal(reasons[0], 'locked');
});

test('lock emits cleared secrets before slow helper shutdown and close drains encrypted writes',async t=>{
  const s=await fixture(t);await create(s);
  let finishStop, finishWrite;
  const originalStop=s.engine.stop.bind(s.engine);
  s.engine.stop=()=>new Promise(resolve=>{finishStop=resolve;});
  s.persisting=new Promise(resolve=>{finishWrite=resolve;});
  const states=[];s.on('state',state=>states.push(state));
  let closed=false;const closing=s.close().then(()=>{closed=true;});
  try {
    assert.ok(states.some(state=>state.phase==='locked'&&state.wallet===null));
    assert.equal(closed,false);finishStop();
    await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
    finishWrite();await closing;assert.equal(closed,true);
  } finally {
    s.engine.stop=originalStop;
    finishStop?.();finishWrite?.();
    await closing;
  }
});

test('closing drains an interrupted refresh as cancellation before the lifecycle marker', async t => {
  const s = await fixture(t); await create(s);
  const errors = s.diagnostics.snapshot().errors;
  let rejectRefresh;
  s.refreshInternal = () => new Promise((_, reject) => { rejectRefresh = reject; });
  const rpc = s.rpc, close = rpc.close.bind(rpc);
  rpc.close = () => { close(); rejectRefresh(Object.assign(new Error('RPC client closed.'), { name: 'AbortError', code: 'ABORT_ERR' })); };
  const pending = assert.rejects(s.refresh(), error => error.name === 'AbortError');
  await s.close(); await pending;
  const rows = (await readFile(s.diagnostics.snapshot().file, 'utf8')).trim().split('\n').map(JSON.parse);
  const cancelled = rows.findIndex(row => row.event === 'wallet.refresh_cancelled');
  const closed = rows.findIndex(row => row.event === 'wallet.closed');
  assert.ok(cancelled >= 0 && cancelled < closed);
  assert.equal(rows[cancelled].details.error, undefined);
  assert.equal(rows.some(row => row.event === 'wallet.refresh_failed'), false);
  assert.equal(s.diagnostics.snapshot().errors, errors);
  assert.equal(s.error, null);
});

test('closing does not hide a real refresh failure already in flight', async t => {
  const s = await fixture(t); await create(s);
  const errors = s.diagnostics.snapshot().errors;
  let rejectRefresh;
  s.refreshInternal = () => new Promise((_, reject) => { rejectRefresh = reject; });
  const failure = Object.assign(new Error('Connection to the RPC server was lost.'), { code: 'ECONNRESET' });
  const pending = assert.rejects(s.refresh(), error => error === failure);
  rejectRefresh(failure);
  await s.close(); await pending;
  const rows = (await readFile(s.diagnostics.snapshot().file, 'utf8')).trim().split('\n').map(JSON.parse);
  const failed = rows.findIndex(row => row.event === 'wallet.refresh_failed');
  assert.ok(failed >= 0 && failed < rows.findIndex(row => row.event === 'wallet.closed'));
  assert.equal(rows[failed].details.error.category, 'network');
  assert.equal(s.diagnostics.snapshot().errors, errors + 1);
});

test('appearance persists without touching the wallet, connection, claims or payment review',async t=>{
  const s=await fixture(t);await create(s);
  const epoch=s.epoch, rpc=s.rpc, engine=s.engine;
  const encrypted=await readFile(s.vaultFile,'utf8');
  const preview=s.preview={previewId:'preserve-me',epoch};
  engine.start();
  for(const theme of ['dark','light','system']) {
    const result=await s.setTheme({theme});
    assert.equal(result.config.theme,theme);
    assert.equal(s.epoch,epoch);assert.equal(s.rpc,rpc);assert.equal(s.engine,engine);
    assert.equal(engine.enabled,true);assert.equal(s.preview,preview);
    assert.equal(await readFile(s.vaultFile,'utf8'),encrypted);
    assert.equal(JSON.parse(await readFile(join(s.directory,'config.json'),'utf8')).theme,theme);
  }
  await assert.rejects(s.setTheme({theme:'invalid'}),/appearance/);
  assert.equal(s.config.theme,'system');assert.equal(s.preview,preview);
});

test('appearance can be saved before onboarding or while locked, without exposing a session',async t=>{
  const s=await fixture(t);
  await s.setTheme({theme:'dark'});assert.equal(s.getState().phase,'welcome');
  assert.equal(s.session,null);assert.equal(s.walletExists,false);
  await create(s);await s.lock();
  await s.setTheme({theme:'light'});assert.equal(s.getState().phase,'locked');
  assert.equal(s.session,null);assert.equal(s.getState().wallet,null);
});

test('Developer Mode changes only diagnostic visibility and persists without touching active wallet state', async t => {
  const s = await fixture(t); await create(s);
  assert.equal(s.config.developerMode, false);
  assert.equal(s.getState().diagnostics, null);
  assert.equal(s.getState().claims.lastErrorDiagnostic, false);
  s.recordDiagnostic('claim.failed', { stage: 'submit', error: { code: -32020, data: { node_code: -26 } } });
  const epoch = s.epoch, rpc = s.rpc, engine = s.engine, session = s.session, timer = s.timer;
  const encrypted = await readFile(s.vaultFile, 'utf8');
  const preview = s.preview = { previewId: 'preserve-review', epoch };
  engine.start();
  engine.notify({ lastError: 'The node rejected this claim.', lastErrorDiagnostic: true });
  const claims = engine.snapshot(), calls = rpc.calls.length;
  const { developerMode, ...otherSettings } = s.config;
  for (const enabled of [true, false, true, false]) {
    const result = await s.setDeveloperMode({ enabled });
    assert.equal(result.config.developerMode, enabled);
    assert.equal(result.diagnostics !== null, enabled);
    if (enabled) assert.equal(result.diagnostics.recent.at(-1).details.error.code, -32020);
    // Keep the complete claim error in state; the renderer decides visibility.
    assert.equal(result.claims.lastError, 'The node rejected this claim.');
    assert.equal(result.claims.lastErrorDiagnostic, true);
    assert.equal(s.epoch, epoch); assert.equal(s.rpc, rpc); assert.equal(s.engine, engine);
    assert.equal(s.session, session); assert.equal(s.timer, timer); assert.equal(s.preview, preview);
    assert.equal(engine.enabled, true); assert.deepEqual(engine.snapshot(), claims);
    assert.equal(rpc.calls.length, calls);
    assert.equal(await readFile(s.vaultFile, 'utf8'), encrypted);
    const saved = JSON.parse(await readFile(join(s.directory, 'config.json'), 'utf8'));
    assert.equal(saved.developerMode, enabled);
    const { developerMode: savedMode, ...savedSettings } = saved;
    assert.deepEqual(savedSettings, otherSettings);
  }
  for (const enabled of [undefined, null, 'true', 'false', 1, 0, {}, []]) await assert.rejects(s.setDeveloperMode({ enabled }), /Developer Mode/);
  assert.equal(s.config.developerMode, false); assert.equal(s.preview, preview);
  s.recordDiagnostic('wallet.refresh_failed', { stage: 'refresh', error: new Error('RPC request timed out.') });
  await s.diagnostics.flush();
  const disk = await readFile(s.diagnostics.snapshot().file, 'utf8');
  assert.ok(disk.includes('wallet.refresh_failed'));
  assert.equal(s.getState().diagnostics, null);
});

test('Developer Mode never exposes diagnostic history before onboarding or while locked', async t => {
  const s = await fixture(t);
  await s.setDeveloperMode({ enabled: true });
  assert.equal(s.getState().phase, 'welcome');
  assert.equal(s.getState().diagnostics, null);
  await create(s);
  assert.ok(s.getState().diagnostics);
  await s.lock();
  assert.equal(s.getState().phase, 'locked');
  assert.equal(s.getState().diagnostics, null);
  await s.setDeveloperMode({ enabled: false });
  assert.equal(s.session, null); assert.equal(s.getState().wallet, null);
});
