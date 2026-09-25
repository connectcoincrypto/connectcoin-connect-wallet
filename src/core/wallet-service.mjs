import { EventEmitter } from 'node:events';
import { randomUUID, randomInt } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { RpcClient } from './rpc.mjs';
import { readConfig, writeConfig, validateConfig, validateTheme, validateDeveloperMode, validateTip } from './config.mjs';
import { deriveAccount, generateMnemonic, normalizeMnemonic, validateMnemonic } from './crypto.mjs';
import { createVault, unlockVault, updateVault, validatePassword, replaceVault, vaultFingerprint } from './vault.mjs';
import { buildPayment, prepareClaim, attachClaimProof, parseCoinAmount, formatCoinAmount, estimateClaimFee, parseTransaction, transactionId } from './transaction.mjs';
import { ClaimsEngine, getClaimsHelper, isKnownClaimRejection } from './claims.mjs';
import { bountyKey, discoverBounties, readBountyBlock } from './bounty-discovery.mjs';
import { DiagnosticLog } from './diagnostics.mjs';
import { StatePublisher } from './state-publisher.mjs';
import { performance } from 'node:perf_hooks';
import { selectVaultFile, VAULT_NAME } from './profile-paths.mjs';
import { createRsaProbe } from './rsa-probe.mjs';
import { LiveUpdates } from './live-updates.mjs';
import { EventRefresh } from './event-refresh.mjs';

const HASH = /^[0-9a-f]{64}$/;
const MONEY = /^-?\d{1,19}$/;
function amount(value) {
  if (typeof value !== 'string' || !MONEY.test(value) || BigInt(value) > 1000000000000000000n || BigInt(value) < -1000000000000000000n) throw new Error('RPC returned an invalid monetary amount.');
  return BigInt(value);
}
function walletName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 40 || /[\x00-\x1f]/.test(name)) throw new Error('Use a wallet name between 1 and 40 characters.');
  return name.trim();
}
function formatSigned(value) { return value < 0n ? `-${formatCoinAmount(-value)}` : formatCoinAmount(value); }
function waitForReview(promise, signal) {
  // Cancel this review's wait, never a refresh shared with the rest of the wallet.
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(Object.assign(new Error('Payment review cancelled.'), { name: 'AbortError' })); };
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
function validateRow(row) {
  if (!row || !HASH.test(row.txid)) throw new Error('Invalid transaction returned by RPC.');
  return row;
}
export class WalletService extends EventEmitter {
  constructor({ directory, resourcesPath, allowRegtest = false, clientFactory = options => new RpcClient(options), proofRunner, connectionPoolFactory, rsaProbe } = {}) {
    super(); Object.assign(this, { directory, resourcesPath, allowRegtest, clientFactory, proofRunner, connectionPoolFactory });
    this.vaultFile = join(directory, VAULT_NAME);
    this.diagnostics = null;
    this.session = null; this.epoch = 0; this.setup = null; this.preview = null;
    this.rsaProbe = rsaProbe ?? createRsaProbe({ resourcesPath });
    this.sendPreparation = null;
    this.replacement = null; this.walletWrite = null; this.closed = false;
    this.walletExists = false; this.accounts = []; this.accountCache = new Map(); this.utxos = []; this.history = [];
    this.balance = null; this.qrDataUrl = null; this.error = null; this.rpc = null;
    this.network = { status: 'offline', chain: 'testnet4', height: null };
    this.claimBlocks = new Map(); this.claimCursor = null; this.claimInfo = {}; this.retiredClaims = new Map(); this.tip = null;
    this.reserved = new Set(); this.fundingCache = new Map(); this.fundingPending = new Map(); this.lastActivity = Date.now(); this.persisting = Promise.resolve();
    this.statePublisher = new StatePublisher({ publish: () => this.emit('state', this.getState()) });
    this.statePriority = null;
    this.settingsWrite = Promise.resolve(); this.claimToggleGeneration = 0; this.claimsResumePending = false;
    this.walletGeneration = 0; this.claimsReviewRequired = false; this.claimsReviewGeneration = 0;
    this.claimRevision = 0;
  }
  async initialize() {
    this.vaultFile = selectVaultFile(this.directory);
    this.config = await readConfig(this.directory, { allowRegtest: this.allowRegtest });
    this.walletExists = await access(this.vaultFile).then(() => true, () => false);
    this.diagnostics = new DiagnosticLog({ directory: this.directory });
    this.recordDiagnostic('wallet.started', { stage: 'lifecycle' });
    await this.diagnostics.flush();
    this.connectClient(); this.createEngine();
    this.timer = setInterval(() => {
      if (this.setup && Date.now() > this.setup.expires) { this.setup = null; this.emitState(); }
      if (this.replacement && Date.now() > this.replacement.expires) this.cancelWalletReplacement();
      if (this.session && Date.now() - this.lastActivity >= this.config.autoLockMinutes * 60000) void this.lock();
      // Local security housekeeping only. Network updates arrive via RPC subscriptions.
    }, 1000);
    this.timer.unref?.();
    return this.getState();
  }
  connectClient() {
    this.stopLiveUpdates();
    this.cancelSendPreview();
    this.rpc?.close(); this.refreshing = null; this.fundingPending.clear();
    const rpc = this.clientFactory({ ...this.config.rpc, onDiagnostic: (event, details) => this.recordDiagnostic(event, details) }); this.rpc = rpc;
    this.tip = null;
    this.liveUpdateWarning = null;
    this.network = { status: 'offline', chain: this.config.network, height: null };
    this.walletUpdateRevision = 0; this.walletReadRevision = -1;
    const active = () => !this.closed && Boolean(this.session) && this.rpc === rpc;
    this.walletUpdates = new EventRefresh({ isActive: active, delayMs: 150, run: async () => {
      // An event during an existing read needs a fresh pass, not its old promise.
      if (this.refreshing) await this.refreshing.catch(() => {});
      if (active() && this.walletReadRevision < this.walletUpdateRevision) await this.refresh();
    } });
    this.bountyUpdates = new EventRefresh({ isActive: active, run: async () => {
      await this.claimSuspending;
      if (this.bountySync) await this.bountySync.catch(() => {});
      if (!active()) return;
      if (!this.engine.enabled && this.claimsResumePending) {
        await this.resumeClaims({ retryErrors: true });
        await this.bountySync;
      } else if (this.engine.enabled) await this.syncBounties();
    } });
    this.liveUpdates = new LiveUpdates({ rpc, network: this.config.network, isActive: active,
      getAddresses: () => {
        // Watch the currently displayed receive/change addresses first when a
        // large recovered wallet reaches the shared server subscription limit.
        const current = this.accounts.filter(account => account.index === this.session?.data[account.change ? 'changeIndex' : 'receiveIndex']);
        return [...new Set([...current, ...this.accounts, ...this.accountCache.values()].map(account => account.address))];
      },
      onChange: ({ wallet, bounties, reset, catchup }) => {
        if (!active()) return;
        if (reset) {
          // Reject an in-flight pre-reorg snapshot before it can resume workers.
          this.claimRevision++; this.claimCursor = null; this.claimBlocks.clear();
          this.claimSuspending = this.engine.suspend();
        }
        if (bounties) this.bountyUpdates.request();
        // Refresh subscribes before reading each address. Its registration
        // catch-ups are already covered by those reads; actual pushes are not.
        if (wallet) {
          if (!(catchup && this.refreshing)) this.walletUpdateRevision++;
          // Keep a waiter even for a covered catch-up: if that read fails, its
          // revision is not acknowledged and the waiter retries the snapshot.
          this.walletUpdates.request();
        }
      },
      onError: error => {
        if (!active()) return;
        if (error.code === 'LIVE_UPDATE_ADDRESS_CAPACITY') this.liveUpdateWarning = error.message;
        this.error = error.message;
        this.recordDiagnostic('wallet.subscription_failed', { stage: 'request', error });
        this.emitState();
      },
    });
    rpc.on('connected', () => {
      if (this.rpc !== rpc) return;
      // A new connection negotiates address capacity again, including after an
      // automatic reconnect which deliberately reuses this RpcClient instance.
      if (this.error === this.liveUpdateWarning) this.error = null;
      this.liveUpdateWarning = null;
    });
    rpc.on('disconnected', () => {
      if (this.rpc !== rpc) return;
      this.claimsResumePending = Boolean(this.session && this.config.claims.enabled && !this.claimsReviewRequired);
      this.claimRevision++; this.claimToggleGeneration++;
      this.walletUpdateRevision++;
      this.tip = null;
      this.network.status = 'offline';
      this.cancelSendPreview();
      this.claimSuspending = this.engine?.stop(); this.emitState();
    });
  }
  stopLiveUpdates() {
    this.liveUpdates?.close(); this.walletUpdates?.close(); this.bountyUpdates?.close();
  }
  createEngine() {
    this.engine = new ClaimsEngine({
      isUnlocked: () => Boolean(this.session),
      resourcesPath: this.resourcesPath,
      ...(this.proofRunner ? { generateProof: this.proofRunner } : {}),
      ...(this.connectionPoolFactory ? { poolFactory: this.connectionPoolFactory } : {}),
      onDiagnostic: (event, details) => this.recordDiagnostic(event, details),
      prepare: (bounty, options) => this.prepareAutomaticClaim(bounty, options),
      submit: (prepared, proof, options) => this.submitAutomaticClaim(prepared, proof, options),
      getNetReward: bounty => BigInt(bounty.amount) - BigInt(estimateClaimFee(this.config.feeRate)),
      getValidationTime: () => validateTip(this.tip, this.config.network).mediantime,
      options: { connectionsPerSecond: this.config.claims.maxConnectionsPerSecond, concurrency: this.config.claims.maxConcurrent },
      onState: state => {
        this.claimInfo = state;
        for (const [key, row] of this.retiredClaims) if (!this.engine?.hasActive(key)) {
          if (this.claimOutpoints?.get(key) === row) this.claimOutpoints.delete(key);
          this.retiredClaims.delete(key);
        }
        this.emitState();
      },
    });
  }
  getState() {
    const current = this.accounts.find(a => a.change === 0 && a.index === this.session?.data.receiveIndex);
    return {
      phase: this.session ? 'unlocked' : this.walletExists ? 'locked' : 'welcome',
      setupActive: Boolean(this.setup), securityEpoch: this.epoch,
      replacementActive: Boolean(!this.session && this.replacement && this.replacement.epoch === this.epoch && this.replacement.expires > Date.now()),
      replacementMode: !this.session && this.replacement && this.replacement.epoch === this.epoch && this.replacement.expires > Date.now() ? this.replacement.mode : null,
      wallet: this.session ? { name: this.session.data.name, address: current?.address ?? '', path: current?.path,
        qrDataUrl: this.qrDataUrl, balance: this.balance, recovering: Boolean(this.recovering), addressCount: this.accounts.length } : null,
      network: { ...this.network, host: this.config.rpc.host, port: this.config.rpc.port },
      config: structuredClone(this.config), history: this.session ? this.history : [],
      claims: { ...this.claimInfo, enabled: Boolean(this.engine?.enabled), available: this.claimInfo.queued ?? 0,
        lastErrorDiagnostic: this.claimInfo.lastErrorDiagnostic === true,
        sent: this.claimInfo.completed ?? 0, successful: this.claimInfo.completed ?? 0,
        helperAvailable: Boolean(this.proofRunner || this.connectionPoolFactory || getClaimsHelper({ resourcesPath: this.resourcesPath })), scanning: Boolean(this.scanningBounties) },
      busy: Boolean(this.refreshing), error: this.error ?? this.liveUpdateWarning,
      diagnostics: this.session && this.config.developerMode ? this.diagnostics?.snapshot() ?? null : null,
    };
  }
  emitState() {
    if (!this.config) return;
    // Progress bursts must not serialize history/QR/diagnostics once per bounty.
    // Security transitions and actionable errors bypass the progress throttle.
    const priority = [this.epoch, Boolean(this.session), this.walletExists, this.config.developerMode, this.config.claims.enabled,
      this.network.status, Boolean(this.engine?.enabled), this.error,
      this.claimInfo.lastErrorDiagnostic === true || this.claimInfo.lastErrorTransient === true
        ? null : this.claimInfo.lastError ?? null];
    const immediate = !this.statePriority || priority.some((value, index) => value !== this.statePriority[index]);
    this.statePriority = priority;
    this.statePublisher.request({ immediate });
  }
  recordDiagnostic(event, details = {}) {
    try { this.diagnostics?.record(event, { ...details, height: this.network.height }); } catch { /* Logging never controls the wallet. */ }
  }
  activity() { this.lastActivity = Date.now(); }
  assertSession(epoch = this.epoch) { if (!this.session || epoch !== this.epoch) throw new Error('Wallet locked or changed; please try again after unlocking.'); }
  assertReplacement(replacementId, mode) {
    const value = this.replacement;
    if (this.closed || this.session || !this.walletExists || !value || value.replacementId !== replacementId || value.epoch !== this.epoch || value.expires <= Date.now()) throw new Error('Wallet replacement expired or was cancelled. Start again from the unlock screen.');
    if (mode && value.mode !== mode) throw new Error('Use recovery words to reset your password, or choose Use another wallet.');
    return value;
  }
  async beginWalletReplacement({ mode } = {}) {
    if (mode !== 'recover' && mode !== 'switch') throw new Error('Choose recovery or another wallet.');
    if (this.closed || !this.walletExists || this.session || this.walletWrite) throw new Error('Lock the existing wallet and wait for any wallet operation to finish.');
    const epoch = ++this.epoch;
    this.replacement = null; this.setup = null;
    await this.persisting.catch(() => {});
    const expectedFingerprint = await vaultFingerprint(this.vaultFile);
    if (this.closed || this.epoch !== epoch || this.session || this.walletWrite) throw new Error('Wallet replacement was cancelled.');
    this.replacement = { replacementId: randomUUID(), mode, epoch, expectedFingerprint, expires: Date.now() + 600000 };
    this.emitState();
    return { replacementId: this.replacement.replacementId };
  }
  cancelWalletReplacement() {
    this.replacement = null; this.setup = null; this.epoch++;
    this.emitState(); return this.getState();
  }
  async prepareWallet({ name, password, wordCount = 24, replacementId } = {}) {
    if (this.closed || this.walletWrite || this.session) throw new Error('A wallet operation is already in progress.');
    if (this.walletExists) this.assertReplacement(replacementId, 'switch');
    else if (replacementId !== undefined) throw new Error('No wallet is available to replace.');
    validatePassword(password); name = walletName(name);
    const mnemonic = generateMnemonic(wordCount);
    const checkIndexes = new Set(); while (checkIndexes.size < 3) checkIndexes.add(randomInt(wordCount));
    this.setup = { setupId: randomUUID(), mnemonic, password, name, replacementId, epoch: this.epoch, checkIndexes: [...checkIndexes].sort((a,b) => a-b), expires: Date.now() + 600000 };
    return { setupId: this.setup.setupId, mnemonic, checkIndexes: this.setup.checkIndexes };
  }
  cancelSetup() { this.setup = null; return this.getState(); }
  async confirmWallet({ setupId, answers } = {}) {
    const setup = this.setup;
    if (!setup || setup.setupId !== setupId || setup.epoch !== this.epoch || setup.expires < Date.now()) throw new Error('Wallet setup expired. Please create a new recovery phrase.');
    const words = setup.mnemonic.split(' ');
    if (!answers || setup.checkIndexes.some(index => String(answers[index] ?? '').trim().toLowerCase() !== words[index])) throw new Error('The backup words do not match. Check your written recovery phrase.');
    await this.createWallet(setup, false);
    if (this.setup === setup) this.setup = null;
    return this.getState();
  }
  async restoreWallet({ name, password, mnemonic, replacementId } = {}) {
    validatePassword(password);
    if (!validateMnemonic(mnemonic)) throw new Error('Enter a valid 12, 18 or 24-word BIP39 recovery phrase.');
    await this.createWallet({ name: walletName(name), password, mnemonic: normalizeMnemonic(mnemonic), replacementId }, true);
    return this.getState();
  }
  async createWallet(input, recover) {
    if (this.closed || this.walletWrite || this.session) throw new Error('A wallet operation is already in progress.');
    const operation = this.createWalletInternal(input, recover);
    this.walletWrite = operation;
    try { await operation; }
    finally { if (this.walletWrite === operation) this.walletWrite = null; }
  }
  async createWalletInternal({ name, password, mnemonic, replacementId, setupId }, recover) {
    const replacement = this.walletExists ? this.assertReplacement(replacementId, recover ? undefined : 'switch') : null;
    if (!replacement && replacementId !== undefined) throw new Error('No wallet is available to replace.');
    const epoch = this.epoch;
    const check = () => {
      if (this.closed || epoch !== this.epoch || this.session) throw new Error('Wallet creation or replacement was cancelled.');
      if (replacement) this.assertReplacement(replacementId, recover ? undefined : 'switch');
      if (setupId && (this.setup?.setupId !== setupId || this.setup.expires <= Date.now())) throw new Error('Wallet setup expired or was cancelled.');
    };
    check();
    const data = { name, mnemonic, network: this.config.network, passphrase: '', receiveIndex: 0, changeIndex: 0, lastUsedReceive: -1, lastUsedChange: -1, needsRecovery: recover, createdAt: new Date().toISOString() };
    await this.persisting.catch(() => {}); check();
    try {
      if (replacement) await replaceVault(this.vaultFile, data, password, { expectedFingerprint: replacement.expectedFingerprint, check });
      else await createVault(this.vaultFile, data, password, { check });
    } catch (error) {
      if (error.walletPublished === true) {
        this.walletGeneration++; this.claimsReviewRequired = false;
        this.walletExists = true; this.replacement = null; this.setup = null; this.epoch++;
        this.error = error.message; this.emitState();
      }
      throw error;
    }
    this.walletExists = true;
    this.walletGeneration++; this.claimsReviewRequired = false;
    this.replacement = null;
    // Cancellation may arrive after publication while cleanup is still pending.
    // The saved wallet remains available, but that cancelled setup cannot unlock it.
    if (this.closed || this.epoch !== epoch || (setupId && (this.setup?.setupId !== setupId || this.setup.expires <= Date.now()))) {
      this.setup = null; this.emitState(); return;
    }
    await this.openSession(data, password);
  }
  async unlock({ password } = {}) {
    if (this.closed || !this.walletExists || this.session) throw new Error('Wallet is not locked.');
    this.replacement = null; this.setup = null; this.epoch++;
    const epoch = this.epoch;
    await this.walletWrite?.catch(() => {});
    if (this.closed || this.epoch !== epoch) throw new Error('Unlock was cancelled.');
    const data = await unlockVault(this.vaultFile, password);
    if (this.epoch !== epoch) throw new Error('Unlock was cancelled.');
    await this.openSession(data, password); return this.getState();
  }
  async openSession(data, password) {
    if (data.network !== this.config.network) throw new Error('Wallet and RPC configuration belong to different networks.');
    for (const key of ['receiveIndex', 'changeIndex']) if (!Number.isSafeInteger(data[key]) || data[key] < 0 || data[key] > 999) throw new Error('Unsupported wallet address index.');
    walletName(data.name);
    this.replacement = null; this.setup = null;
    this.session = { data, password }; this.epoch++; this.activity(); this.error = null;
    this.buildAccounts(); await this.makeQR(); this.emitState();
    this.liveUpdates.start();
    if (this.session && !this.closed && this.config.claims.enabled) void this.resumeClaims();
    void this.refresh().catch(() => {});
  }
  publicAccount(index, change) {
    this.assertSession();
    const cacheKey = `${change}:${index}`;
    if (this.accountCache.has(cacheKey)) return this.accountCache.get(cacheKey);
    const account = deriveAccount(this.session.data.mnemonic, { network: this.config.network, index, change, passphrase: this.session.data.passphrase });
    const { privateKey, ...publicData } = account; privateKey.fill(0);
    this.accountCache.set(cacheKey, publicData); return publicData;
  }
  buildAccounts() {
    this.accounts = [];
    for (const change of [0,1]) {
      const issued = this.session.data[change ? 'changeIndex' : 'receiveIndex'];
      const used = this.session.data[change ? 'lastUsedChange' : 'lastUsedReceive'] ?? -1;
      const maximum = this.session.data.scanLookahead ? Math.min(999, Math.max(issued, used + 20)) : issued;
      for (let index = 0; index <= maximum; index++) this.accounts.push(this.publicAccount(index, change));
    }
    this.liveUpdates?.updateAddresses();
  }
  async makeQR() {
    const epoch = this.epoch;
    const address = this.accounts.find(a => a.change === 0 && a.index === this.session?.data.receiveIndex)?.address;
    const qrDataUrl = address ? await QRCode.toDataURL(address, { errorCorrectionLevel: 'M', margin: 2, width: 280, color: { dark: '#17211b', light: '#ffffff' } }) : null;
    if (epoch === this.epoch && this.session) this.qrDataUrl = qrDataUrl;
  }
  async persist() {
    this.assertSession();
    const data = structuredClone(this.session.data), password = this.session.password;
    const operation = this.persisting.catch(() => {}).then(() => updateVault(this.vaultFile, data, password));
    this.persisting = operation; await operation;
  }
  async lock() {
    this.stopLiveUpdates(); this.claimRevision++;
    this.cancelSendPreview();
    this.claimToggleGeneration++; this.claimsResumePending = false;
    this.epoch++; this.preview = null; this.setup = null; this.replacement = null;
    const epoch = this.epoch;
    this.session = null; this.accounts = []; this.utxos = []; this.history = []; this.balance = null; this.qrDataUrl = null;
    this.tip = null; this.retiredClaims.clear();
    this.fundingCache.clear(); this.fundingPending.clear(); this.claimBlocks.clear(); this.claimOutpoints?.clear(); this.claimCursor = null; this.reserved.clear(); this.accountCache.clear();
    this.rpc?.close();
    // Hide sensitive renderer state immediately, before waiting for helper shutdown.
    this.emitState();
    await this.engine?.stop('locked'); this.engine?.clear();
    if (epoch !== this.epoch) return this.getState();
    this.connectClient(); this.emitState(); return this.getState();
  }
  async newAddress() {
    this.assertSession();
    const epoch = this.epoch;
    if (this.session.data.needsRecovery) throw new Error('Wait for recovery discovery to finish.');
    if (this.session.data.receiveIndex >= 999 || this.session.data.receiveIndex >= (this.session.data.lastUsedReceive ?? -1) + 20) throw new Error('Use one of your existing receive addresses before creating more. Recovery keeps a 20-address gap.');
    const previousIndex = this.session.data.receiveIndex;
    this.session.data.receiveIndex++;
    try { await this.persist(); }
    catch(error) { if (epoch === this.epoch && this.session) this.session.data.receiveIndex = previousIndex; throw error; }
    this.assertSession(epoch); this.buildAccounts(); await this.makeQR(); this.emitState();
    this.walletUpdateRevision++; this.walletUpdates?.request();
    void this.refresh().catch(() => {});
    return { address: this.getState().wallet.address, qrDataUrl: this.qrDataUrl };
  }
  async getRecoveryPhrase({ password } = {}) {
    this.assertSession(); const epoch = this.epoch;
    const verified = await unlockVault(this.vaultFile, password); this.assertSession(epoch);
    return { mnemonic: verified.mnemonic, path: "m/44'/1'/0'/change/index", network: verified.network };
  }
  async ensureNetwork() {
    const epoch = this.epoch, rpc = this.rpc;
    const tip = validateTip(await rpc.request('getchaintip'), this.config.network);
    this.assertSession(epoch);
    if (rpc !== this.rpc) throw new Error('RPC connection changed.');
    this.network = { ...this.network, status: 'online', height: tip.height, chain: tip.chain };
    this.tip = tip; return tip;
  }
  checkResponse(response) { validateTip(response?.tip, this.config.network); return response; }
  async page(method, address, { firstOnly = false, onTip } = {}) {
    const epoch = this.epoch, rpc = this.rpc; const items = []; let cursor; const seen = new Set();
    do {
      this.assertSession(epoch);
      if (seen.size >= 1000) throw new Error('Address pagination exceeds this release’s local resource limit.');
      const result = this.checkResponse(await rpc.request(method, { address, ...(cursor ? { cursor } : {}) }));
      this.assertSession(epoch);
      if (rpc !== this.rpc) throw new Error('RPC connection changed.');
      if (result.address !== address || result.unit !== 'connects' || !Array.isArray(result.items) || result.items.length > 500) throw new Error('RPC returned an invalid address page.');
      onTip?.(result.tip);
      items.push(...result.items.map(validateRow));
      if (items.length > 20000) throw new Error('Address history exceeds this release’s local resource limit. No partial balance was accepted.');
      cursor = result.next_cursor;
      if (cursor !== null && (typeof cursor !== 'string' || !cursor.length || cursor.length > 4096 || seen.has(cursor))) throw new Error('RPC returned an invalid or repeated cursor.');
      seen.add(cursor);
      // An empty page may still have a continuation; only a positive result or
      // exhaustion proves whether this address contributes to the recovery gap.
      if (firstOnly && items.length) break;
    } while (cursor);
    return items;
  }
  async recoverAddresses(epoch) {
    this.recovering = true; this.emitState();
    try {
      const emptyAddresses = new Set(), rpc = this.rpc, tipHash = this.tip?.hash;
      let stableTip = true;
      const onTip = tip => {
        if (tip.hash !== tipHash || this.tip?.hash !== tipHash || this.rpc !== rpc) {
          stableTip = false; emptyAddresses.clear();
        }
      };
      const lastUsed = [-1,-1];
      for (const change of [0,1]) {
        let gap = 0;
        for (let index = 0; gap < 20; index++) {
          this.assertSession(epoch);
          if (index >= 1000) throw new Error('Recovery reached the 1,000-address safety limit. Contact support before using this wallet.');
          const account = this.publicAccount(index, change);
          if (this.liveUpdates?.started) await this.liveUpdates.watchAddress(account.address);
          this.assertSession(epoch);
          const history = await this.page('getaddresshistory', account.address, { firstOnly: true, onTip });
          if (history.length) { lastUsed[change] = index; gap = 0; } else gap++;
          if (!history.length && stableTip) emptyAddresses.add(account.address);
        }
      }
      this.assertSession(epoch);
      this.session.data.receiveIndex = Math.max(this.session.data.receiveIndex, lastUsed[0] + 1);
      this.session.data.changeIndex = Math.max(this.session.data.changeIndex, lastUsed[1] + 1);
      this.session.data.lastUsedReceive = lastUsed[0]; this.session.data.lastUsedChange = lastUsed[1]; this.session.data.needsRecovery = false;
      this.session.data.scanLookahead = true;
      await this.persist(); this.assertSession(epoch); this.buildAccounts(); await this.makeQR();
      return emptyAddresses;
    } finally { this.recovering = false; this.emitState(); }
  }
  async refresh() {
    if (!this.session) return this.getState();
    if (this.refreshing) return this.refreshing;
    const epoch = this.epoch;
    const started = performance.now();
    const operation = this.refreshInternal(epoch).catch(error => {
      const cancelled = error?.name === 'AbortError' && !error.unknownOutcome;
      this.recordDiagnostic(cancelled ? 'wallet.refresh_cancelled' : 'wallet.refresh_failed', {
        stage: 'refresh', ...(!cancelled ? { error } : {}), durationMs: Math.round(performance.now() - started),
      });
      if (!cancelled && epoch === this.epoch) { this.error = error.message; if (!this.rpc.socket) this.network.status = 'offline'; this.emitState(); }
      throw error;
    }).finally(() => { if (this.refreshing === operation) this.refreshing = null; this.emitState(); });
    this.refreshing = operation;
    this.emitState(); return this.refreshing;
  }
  async refreshInternal(epoch) {
    await this.ensureNetwork(); this.assertSession(epoch);
    const updateRevision = this.walletUpdateRevision;
    const rpc = this.rpc, recoveryTipHash = this.tip.hash;
    const emptyAddresses = this.session.data.needsRecovery ? await this.recoverAddresses(epoch) : null;
    // Reuse only fully exhausted empty discovery results inside this refresh.
    // A new block, same-height fork, or changed connection invalidates them.
    let stableRecoveryTip = true, reusedEmptyHistory = false;
    const onTip = tip => {
      if (tip.hash !== recoveryTipHash || this.tip?.hash !== recoveryTipHash || this.rpc !== rpc) stableRecoveryTip = false;
    };
    if (emptyAddresses?.size) onTip(await this.ensureNetwork());
    this.assertSession(epoch);
    if (rpc !== this.rpc) throw new Error('RPC connection changed.');
    const totals = { confirmed: 0n, available: 0n, pending: 0n, immature: 0n };
    const utxos = [], history = new Map(); let highestReceive = this.session.data.lastUsedReceive ?? -1, highestChange = this.session.data.lastUsedChange ?? -1;
    for (const account of this.accounts) {
      this.assertSession(epoch);
      if (rpc !== this.rpc) throw new Error('RPC connection changed.');
      onTip(this.tip ?? {});
      // Restored wallets must keep watching their unused gap: a payment may arrive
      // later at an address issued by the old installation before restoration.
      const reuseEmpty = stableRecoveryTip && emptyAddresses?.has(account.address);
      if (this.liveUpdates?.started) await this.liveUpdates.watchAddress(account.address);
      this.assertSession(epoch);
      const transactions = reuseEmpty ? [] : await this.page('getaddresshistory', account.address, { onTip });
      reusedEmptyHistory ||= Boolean(reuseEmpty);
      if (transactions.length && account.change === 0) highestReceive = Math.max(highestReceive, account.index);
      if (transactions.length && account.change === 1) highestChange = Math.max(highestChange, account.index);
      const issuedIndex = this.session.data[account.change ? 'changeIndex' : 'receiveIndex'];
      if (!transactions.length && account.index > issuedIndex) continue;
      const balance = this.checkResponse(await this.rpc.request('getaddressbalance', { address: account.address }));
      onTip(balance.tip);
      if (balance.address !== account.address || balance.unit !== 'connects') throw new Error('Invalid RPC balance.');
      totals.confirmed += amount(balance.confirmed); totals.available += amount(balance.available_confirmed);
      totals.pending += amount(balance.pending_delta); totals.immature += amount(balance.immature);
      const rows = await this.page('getaddressutxos', account.address, { onTip });
      for (const row of rows) {
        if (!Number.isInteger(row.vout) || row.vout < 0 || row.vout > 0xffffffff || amount(row.amount) < 0n) throw new Error('Invalid RPC output.');
        utxos.push({ ...row, account });
      }
      for (const row of transactions) {
        const existing = history.get(row.txid) ?? { ...row, net: 0n };
        existing.net += amount(row.balance_delta);
        history.set(row.txid, existing);
      }
    }
    this.assertSession(epoch);
    if (rpc !== this.rpc) throw new Error('RPC connection changed.');
    if (reusedEmptyHistory) {
      onTip(await this.ensureNetwork());
      this.assertSession(epoch);
      // Some addresses may already have been skipped before a later response
      // revealed a changed tip. Re-read all addresses, with no recovery cache.
      if (!stableRecoveryTip) return this.refreshInternal(epoch);
    }
    this.utxos = utxos;
    this.balance = Object.fromEntries(Object.entries(totals).map(([key,value]) => [key, formatSigned(value)]));
    this.history = [...history.values()].sort((a,b) => (b.block_height ?? Number.MAX_SAFE_INTEGER) - (a.block_height ?? Number.MAX_SAFE_INTEGER)).map(row => ({
      txid: row.txid, direction: row.net < 0n ? 'sent' : row.net > 0n ? 'received' : 'self',
      amount: formatCoinAmount(row.net < 0n ? -row.net : row.net), status: row.status, confirmations: row.confirmations, blockHeight: row.block_height,
    }));
    if (highestReceive !== this.session.data.lastUsedReceive || highestChange !== this.session.data.lastUsedChange) {
      const readAddresses = new Set(this.accounts.map(account => account.address));
      this.session.data.lastUsedReceive = highestReceive; this.session.data.lastUsedChange = highestChange;
      await this.persist(); this.assertSession(epoch); this.buildAccounts();
      if (this.accounts.some(account => !readAddresses.has(account.address))) {
        // These new lookahead addresses were not part of this pass's reads.
        this.walletUpdateRevision++; this.walletUpdates?.request();
      }
    }
    this.assertSession(epoch); this.error = null; this.emitState();
    this.walletReadRevision = Math.max(this.walletReadRevision, updateRevision);
    // Bounty discovery has its own event queue; address RPC latency must not gate it.
    this.liveUpdates?.updateAddresses();
    // An explicit refresh can also recover a saved start that failed offline.
    // Normal discovery never waits here; its subscription queue runs independently.
    if (!this.engine.enabled && this.config.claims.enabled && this.claimsResumePending) await this.resumeClaims();
    return this.getState();
  }
  async funding(txid, { signal } = {}) {
    if (!HASH.test(txid)) throw new Error('Invalid transaction ID.');
    const cancelled = () => Object.assign(new Error('Funding lookup cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
    if (signal?.aborted) throw cancelled();
    const wait = promise => {
      if (!signal) return promise;
      // The read is shared by claims/payment preparation. Cancel only this
      // consumer's wait; the remaining consumers still need its reply/cache.
      // Both handlers stay attached so a later shared failure is also observed.
      return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()); };
        promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); },
          error => { signal.removeEventListener('abort', abort); reject(error); });
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    };
    if (this.fundingCache.has(txid)) return this.fundingCache.get(txid);
    const epoch = this.epoch, rpc = this.rpc;
    const existing = this.fundingPending.get(txid);
    if (existing?.epoch === epoch && existing.rpc === rpc) return wait(existing.promise);
    if (this.fundingPending.size >= 256) throw new Error('Too many funding transactions are being prepared; retry shortly.');
    const entry = { epoch, rpc };
    entry.promise = Promise.resolve().then(async () => {
      this.assertSession(epoch);
      if (this.rpc !== rpc) throw new Error('RPC connection changed while preparing funding.');
      const result = await rpc.request('gettransaction', { txid });
      this.assertSession(epoch);
      if (this.rpc !== rpc) throw new Error('RPC connection changed while preparing funding.');
      const raw = this.checkResponse(result).transaction?.hex;
      if (transactionId(parseTransaction(raw)) !== txid) throw new Error('The RPC server supplied transaction bytes that do not match their ID.');
      if (this.fundingCache.size >= 256) this.fundingCache.delete(this.fundingCache.keys().next().value);
      this.fundingCache.set(txid, raw); return raw;
    }).finally(() => { if (this.fundingPending.get(txid) === entry) this.fundingPending.delete(txid); });
    this.fundingPending.set(txid, entry);
    return wait(entry.promise);
  }
  cancelSendPreview() {
    this.sendPreparation?.abort();
    this.sendPreparation = null;
    this.preview = null;
  }
  async previewSend({ address, amount: coins, feeRate = this.config.feeRate, domain, expectedConnections } = {}) {
    this.assertSession(); const epoch = this.epoch;
    if (this.session.data.needsRecovery) throw new Error('Wait for recovery discovery to finish before sending.');
    this.cancelSendPreview();
    const value = parseCoinAmount(coins); if (value <= 0n) throw new Error('Enter an amount greater than zero.');
    const preparation = new AbortController(), rpc = this.rpc;
    this.sendPreparation = preparation;
    const check = () => {
      this.assertSession(epoch);
      if (preparation.signal.aborted || this.sendPreparation !== preparation || this.rpc !== rpc) {
        throw Object.assign(new Error('Payment review cancelled. Review the payment again.'), { name: 'AbortError' });
      }
    };
    const verified = []; const keys = [];
    try {
      await waitForReview(this.refresh(), preparation.signal); check();
      const eligible = this.utxos.filter(u => u.status === 'confirmed' && u.mature === true && !this.reserved.has(`${u.txid}:${u.vout}`)).sort((a,b) => BigInt(a.amount) > BigInt(b.amount) ? -1 : 1);
      let total = 0n;
      for (const utxo of eligible.slice(0,256)) {
        const rawTransaction = await this.funding(utxo.txid, { signal: preparation.signal }); check();
        const key = deriveAccount(this.session.data.mnemonic, { network: this.config.network, index: utxo.account.index, change: utxo.account.change, passphrase: this.session.data.passphrase });
        keys.push(key.privateKey); verified.push({ ...utxo, rawTransaction, privateKey: key.privateKey });
        total += BigInt(utxo.amount);
        if (total > value + 100000000n) break;
      }
      check();
      const change = this.publicAccount(this.session.data.changeIndex, 1);
      const output = domain === undefined ? { address, amount: value.toString() } : { domain, amount: value.toString(), expectedConnections, rootVersion: 1, mask: 7 };
      const build = () => buildPayment({ utxos: verified, outputs: [output], changeAddress: change.address, network: this.config.network, feeRate });
      // Validate funding/fees/domain before opening a connection. No wallet keys
      // or transaction bytes are ever passed to the isolated capability helper.
      let payment = build(), policy = {};
      if (domain !== undefined) {
        output.domain = payment.transaction.outputs[0].domain;
        let result;
        try {
          result = await waitForReview(this.rsaProbe({ domain: output.domain, rootVersion: 1, validationTime: Math.floor(Date.now() / 1000) }, { signal: preparation.signal }), preparation.signal);
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          result = { verified: false, status: 'failed' };
        }
        check();
        const rsaVerified = result?.verified === true && result.status === 'verified';
        output.mask = rsaVerified ? 6 : 7;
        if (rsaVerified) payment = build();
        const status = rsaVerified ? 'verified' : ['unavailable', 'timeout', 'busy'].includes(result?.status) ? result.status : 'failed';
        policy = { signatureAlgorithmsMask: output.mask, rsaProbeStatus: status, expectedConnections: String(expectedConnections ?? '1') };
      }
      check();
      // The selected mask and signed bytes are frozen together for confirmation.
      this.preview = { ...payment, ...policy, previewId: randomUUID(), epoch, expires: Date.now() + 120000, address: domain === undefined ? address : output.domain, amount: formatCoinAmount(value), changeIndex: change.index };
      return { previewId: this.preview.previewId, address: this.preview.address, amount: formatCoinAmount(value), fee: formatCoinAmount(BigInt(payment.fee)), total: formatCoinAmount(value + BigInt(payment.fee)), txid: payment.txid, type: domain === undefined ? 'payment' : 'p2c', ...policy };
    } finally {
      for (const key of keys) key.fill(0);
      if (this.sendPreparation === preparation) this.sendPreparation = null;
    }
  }
  async confirmSend({ previewId } = {}) {
    const preview = this.preview; this.preview = null;
    if (!preview || preview.previewId !== previewId || preview.expires < Date.now()) throw new Error('Payment review expired. Review the payment again.');
    this.assertSession(preview.epoch);
    await this.ensureNetwork(); this.assertSession(preview.epoch);
    // Persist the change path BEFORE broadcast; recovery must never rely on success responses.
    if (BigInt(preview.change) > 0n) {
      if (this.session.data.changeIndex >= 999 || this.session.data.changeIndex >= (this.session.data.lastUsedChange ?? -1) + 20) throw new Error('Too many unused change addresses. Wait for pending payments to appear before sending again.');
      this.session.data.changeIndex = Math.max(this.session.data.changeIndex, preview.changeIndex + 1);
      await this.persist(); this.assertSession(preview.epoch); this.buildAccounts();
    }
    for (const input of preview.selected) this.reserved.add(`${input.txid}:${input.vout}`);
    try {
      const result = await this.rpc.request('sendrawtransaction', { transaction_hex: preview.hex });
      if (result?.txid !== preview.txid) throw new Error('RPC returned an unexpected transaction ID.');
      if (this.session) void this.refresh().catch(() => {});
      return { txid: preview.txid, status: 'submitted' };
    } catch { throw new Error(`Broadcast was not confirmed. Check transaction ${preview.txid} before trying again; selected inputs remain reserved until the wallet is reopened.`); }
  }
  queueSettings(operation, { duringClose = false } = {}) {
    if (this.closed && !duringClose) return Promise.reject(new Error('The wallet is closing.'));
    const pending = this.settingsWrite.catch(() => {}).then(operation);
    this.settingsWrite = pending;
    return pending;
  }
  saveConfig(input = {}) {
    return this.queueSettings(() => this.applyConfig(input));
  }
  async applyConfig(input, { retryClaims = false } = {}) {
    // Merge inside the write queue, not when the action was requested: changing
    // appearance while a limits write is pending must not restore old limits.
    const previous = this.config;
    const config = validateConfig({ ...previous, ...input, network: previous.network,
      rpc: { ...previous.rpc, ...input.rpc }, claims: { ...previous.claims, ...input.claims } }, { allowRegtest: this.allowRegtest });
    if (this.claimsReviewRequired) config.claims.enabled = false;
    const reconnect = config.rpc.host !== previous.rpc.host || config.rpc.port !== previous.rpc.port;
    const claimsChanged = Object.keys(config.claims).some(key => config.claims[key] !== previous.claims[key]);
    // Preferences are durable even if locked, offline, or the helper is absent.
    // A failed disk write must not stop workers or switch to an unsaved server.
    this.config = await writeConfig(this.directory, config, { allowRegtest: this.allowRegtest });
    if (this.closed) return this.getState();
    if (reconnect || claimsChanged || retryClaims) {
      this.claimsResumePending = false;
      const generation = ++this.claimToggleGeneration;
      if (reconnect) {
        this.cancelSendPreview(); this.epoch++; this.replacement = null; this.setup = null;
        this.rpc?.close(); this.refreshing = null;
        this.claimBlocks.clear(); this.claimOutpoints?.clear(); this.claimCursor = null;
        this.retiredClaims.clear(); this.fundingCache.clear(); this.fundingPending.clear();
        this.connectClient();
      }
      await this.engine.stop();
      // A lock/new unlock may have started a newer lifecycle while the old
      // helper was draining. That lifecycle reads the already-saved config.
      if (this.closed || generation !== this.claimToggleGeneration) return this.getState();
      if (reconnect) this.engine.clear();
      if (reconnect && this.session) this.liveUpdates.start();
      this.engine.setOptions({ connectionsPerSecond: config.claims.maxConnectionsPerSecond, concurrency: config.claims.maxConcurrent });
      // Auto-lock, appearance and diagnostics do not interrupt network activity.
      if (this.session && !this.closed && config.claims.enabled) await this.resumeClaims();
      if (reconnect && this.session && !this.closed) void this.refresh().catch(() => {});
    }
    this.emitState(); return this.getState();
  }
  async setTheme({ theme } = {}) {
    validateTheme(theme);
    // Appearance is independent of keys, RPC and claims. Do not reconnect,
    // invalidate payment reviews or change the security epoch for a color change.
    return this.saveConfig({ theme });
  }
  async setDeveloperMode({ enabled } = {}) {
    validateDeveloperMode(enabled);
    // Diagnostic visibility is independent of wallet, RPC and claim execution.
    return this.saveConfig({ developerMode: enabled });
  }
  async setClaims({ enabled, maxConnectionsPerSecond, maxConcurrent, lookbackBlocks } = {}) {
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('Choose whether Automatic Claims should be enabled.');
    const reviewGeneration = this.claimsReviewGeneration;
    const claims = {
      ...(enabled === undefined ? {} : { enabled }),
      ...(maxConnectionsPerSecond === undefined ? {} : { maxConnectionsPerSecond }),
      ...(maxConcurrent === undefined ? {} : { maxConcurrent }),
      ...(lookbackBlocks === undefined ? {} : { lookbackBlocks }),
    };
    return this.queueSettings(() => {
      // An enable click queued before a broadcast warning is not consent to
      // dismiss that later warning. Only a fresh action can resume after review.
      if (enabled === true && reviewGeneration === this.claimsReviewGeneration) this.claimsReviewRequired = false;
      return this.applyConfig({ claims }, { retryClaims: enabled === true && !this.engine.enabled });
    });
  }
  async resumeClaims({ retryErrors = false } = {}) {
    if (this.closed || !this.session || !this.config.claims.enabled || this.claimsReviewRequired) return;
    this.claimsResumePending = false;
    const epoch = this.epoch, rpc = this.rpc, engine = this.engine;
    const generation = ++this.claimToggleGeneration;
    const current = () => !this.closed && Boolean(this.session) && this.epoch === epoch && this.rpc === rpc &&
      this.engine === engine && this.claimToggleGeneration === generation && this.config.claims.enabled && !this.claimsReviewRequired;
    const check = () => {
      if (!current()) throw Object.assign(new Error('Automatic Claims startup cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
    };
    try {
      if (!this.proofRunner && !this.connectionPoolFactory && !getClaimsHelper({ resourcesPath: this.resourcesPath })) throw new Error('Install the Automatic Claims helper first (npm run setup:claims), or use the packaged desktop app.');
      await engine.stop(); check();
      // An old session's scan must settle before this run can publish any work.
      if (this.bountySync) await this.bountySync.catch(() => {});
      check();
      engine.setOptions({ connectionsPerSecond: this.config.claims.maxConnectionsPerSecond, concurrency: this.config.claims.maxConcurrent });
      await this.ensureNetwork(); check();
      // Existing queue entries cannot run before the journal and window catch up.
      await engine.suspend(); check(); engine.start();
      void this.syncBounties().catch(error => {
        if (!current()) return;
        if (error?.name === 'AbortError' && error.code === 'ABORT_ERR' && !error.unknownOutcome) return;
        this.error = error.message; void engine.stop(); this.emitState();
      });
    } catch (error) {
      if (!current()) return;
      this.claimsResumePending = true;
      this.error = error.message;
      engine.notify({ lastError: error.message, status: 'off' });
      this.recordDiagnostic('claims.start_failed', { stage: 'lifecycle', error });
      // No periodic poll remains to rescue a transient startup failure. The
      // event queue owns bounded failure retries, including the initial unlock.
      if (retryErrors) { this.emitState(); throw error; }
      this.bountyUpdates?.request();
    }
    this.emitState();
  }
  stopClaimsForReview(message) {
    this.claimsReviewGeneration++;
    this.claimsReviewRequired = true; this.claimsResumePending = false; this.claimToggleGeneration++;
    this.error = message;
    this.config = { ...this.config, claims: { ...this.config.claims, enabled: false } };
    void this.engine.stop(); this.emitState();
    // A sent request can become uncertain while lock/close drains its worker.
    // Persist that safety stop even then; it is not a new user action.
    void this.queueSettings(() => this.applyConfig({ claims: { enabled: false } }), { duringClose: true }).catch(error => {
      this.error = `${message} The safety setting could not be saved; keep Automatic Claims off until you have checked this transaction.`;
      this.recordDiagnostic('claims.safety_save_failed', { stage: 'lifecycle', error }); this.emitState();
    });
  }
  async blockBounties(hash, { rpc = this.rpc, epoch = this.epoch, height, check: parentCheck = () => {}, budget } = {}) {
    const check = () => {
      if (!this.session || epoch !== this.epoch || this.rpc !== rpc) {
        throw Object.assign(new Error('Bounty discovery cancelled after the wallet or connection changed.'), { name: 'AbortError', code: 'ABORT_ERR' });
      }
      parentCheck();
    };
    return readBountyBlock({ rpc, network: this.config.network, hash, height, check, budget });
  }
  async syncBounties() {
    if (!this.engine.enabled) return;
    if (this.bountySync) return this.bountySync;
    const epoch = this.epoch, rpc = this.rpc, engine = this.engine;
    const started = performance.now();
    const pending = this.syncBountiesInternal(epoch).catch(error => {
      const cancelled = error?.name === 'AbortError' && error.code === 'ABORT_ERR' && !error.unknownOutcome;
      this.recordDiagnostic(cancelled ? 'wallet.discovery_cancelled' : 'wallet.discovery_failed', {
        stage: 'discovery', ...(!cancelled ? { error } : {}), durationMs: Math.round(performance.now() - started),
      });
      if (!cancelled && epoch === this.epoch && this.rpc === rpc && this.engine === engine && engine.enabled) {
        this.error = error.message;
        this.claimsResumePending = [-32001, -32011, -32029].includes(error?.code) || !rpc.socket || rpc.socket.destroyed;
        // Never continue queued work after a partial/invalid discovery.
        void engine.stop();
      }
      throw error;
    }).finally(() => {
      if (this.bountySync === pending) {
        this.bountySync = null; this.scanningBounties = false; this.emitState();
      }
    });
    this.bountySync = pending; return pending;
  }
  async syncBountiesInternal(epoch) {
    const rpc = this.rpc, engine = this.engine, revision = this.claimRevision;
    const check = () => {
      if (!this.session || epoch !== this.epoch || this.rpc !== rpc || this.engine !== engine || !engine.enabled || revision !== this.claimRevision) {
        throw Object.assign(new Error('Automatic Claims stopped or its connection changed.'), { name: 'AbortError', code: 'ABORT_ERR' });
      }
    };
    check(); this.scanningBounties = true; this.emitState();
    const result = await discoverBounties({
      rpc, network: this.config.network, lookback: this.config.claims.lookbackBlocks,
      previous: this.claimBlocks, cursor: this.claimCursor, check,
      onInvalidate: (row, reason) => reason === 'window_exit' ? engine.retire(row.txid, row.vout) : engine.remove(row.txid, row.vout),
      onWindow: snapshot => {
        // A retained in-flight row is no longer in the discovery block cache.
        // Still cancel it if a subsequent window reveals its block was replaced.
        const canonical = new Map(snapshot.blocks.map(block => [block.height, block.hash]));
        for (const key of engine.activeKeys()) {
          const row = this.claimOutpoints?.get(key);
          if (!row) continue;
          const blockHash = canonical.get(row.block_height);
          if (row.block_height > snapshot.tip.height || (blockHash && blockHash !== row.block_hash)) engine.remove(row.txid, row.vout);
        }
      },
      onReset: async () => { await engine.suspend(); check(); engine.clear({ preserveSelection: true }); },
      readBlock: (hash, options) => this.blockBounties(hash, { ...options, rpc, epoch }),
    });
    check();
    const available = [], outpoints = new Map();
    for (const rows of result.blocks.values()) for (const row of rows) {
      const key = bountyKey(row); outpoints.set(key, row);
      if (row.status === 'available' && row.root_certificates_version === 1 && !this.reserved.has(key)) available.push(row);
      else engine.remove(row.txid, row.vout);
    }
    // Only already-running, normally aged-out work can outlive discovery.
    // Preserve each outpoint until all its captures/submission have settled.
    for (const [key, row] of this.claimOutpoints ?? []) if (!outpoints.has(key)) {
      if (engine.hasActive(key) && engine.queue.get(key)?.retired) {
        outpoints.set(key, row); this.retiredClaims.set(key, row);
      } else engine.remove(row.txid, row.vout);
    }
    check(); this.claimBlocks = result.blocks; this.claimOutpoints = outpoints; this.claimCursor = result.cursor;
    this.tip = validateTip(result.tip, this.config.network);
    engine.retainCatalog(outpoints.values());
    engine.enqueue(available);
    check(); engine.resume();
  }
  async prepareAutomaticClaim(bounty, { signal, previous } = {}) {
    this.assertSession();
    const epoch = this.epoch, rpc = this.rpc, engine = this.engine;
    const check = () => {
      this.assertSession(epoch);
      if (signal?.aborted || !engine.enabled || this.engine !== engine || this.rpc !== rpc) throw Object.assign(new Error('Automatic Claims stopped.'), { name: 'AbortError' });
    };
    check();
    const current = this.claimOutpoints?.get(bountyKey(bounty));
    if (!current || current.status !== 'available' || this.reserved.has(bountyKey(current))) throw new Error('This bounty is no longer eligible for claiming.');
    // The validated tip is refreshed by wallet/discovery sync, not twice per
    // claim. MTP is a certificate-checking reference, not a bounty expiry rule.
    const tip = validateTip(this.tip, this.config.network);
    const rawTransaction = await this.funding(current.txid, { signal }); check();
    if (this.claimOutpoints?.get(bountyKey(current))?.status !== 'available') throw new Error('Bounty availability changed while preparing its claim.');
    // Preserve the fixed challenge and actual payout on retries, as Core does.
    // Reauthenticate funding and availability each time; never reuse a proposal
    // across a wallet/security epoch or RPC connection change.
    const reusable = previous?.epoch === epoch && previous.rpc === rpc && bountyKey(previous.bounty) === bountyKey(current);
    const rewardAddress = reusable ? previous.rewardAddress : this.getState().wallet.address;
    const prepared = prepareClaim({ bounty: current, rawTransaction, rewardAddress, fee: reusable ? previous.fee : estimateClaimFee(this.config.feeRate), network: this.config.network });
    check();
    return { ...prepared, epoch, rpc, walletGeneration: this.walletGeneration, rewardAddress, context: {
      domain: prepared.bounty.domain, txid: prepared.txid, input_index: 0,
      connection_work_target: prepared.bounty.target, root_certificates_version: prepared.bounty.rootVersion,
      signature_algorithms_mask: prepared.bounty.mask, validation_time: tip.mediantime,
    } };
  }
  async submitAutomaticClaim(prepared, proof, { signal } = {}) {
    const engine = this.engine;
    const check = () => {
      this.assertSession(prepared.epoch);
      if (signal?.aborted || !engine.enabled || this.engine !== engine || this.rpc !== prepared.rpc) throw Object.assign(new Error('Automatic Claims stopped.'), { name: 'AbortError' });
    };
    check();
    const key = bountyKey(prepared.bounty), current = this.claimOutpoints?.get(key);
    if (!current || current.status !== 'available' || this.reserved.has(key)) throw new Error('This bounty is no longer eligible for claiming.');
    const signed = attachClaimProof(prepared, proof); check();
    this.reserved.add(key);
    try {
      const result = await prepared.rpc.request('sendrawtransaction', { transaction_hex: signed.hex }, { signal });
      if (result?.txid !== signed.txid) throw new Error('RPC returned an unexpected claim transaction ID.');
      return { txid: signed.txid };
    } catch (error) {
      if (error?.name === 'AbortError' && error.notSent === true && !error.unknownOutcome) {
        // The transport proves no bytes were submitted. STOP during pacing or
        // connection setup must neither reserve an unspent bounty indefinitely
        // nor report an uncertain broadcast. Sent requests keep their outcome.
        if (this.epoch === prepared.epoch && this.rpc === prepared.rpc) this.reserved.delete(key);
        throw error;
      }
      if (isKnownClaimRejection(error)) {
        if (this.epoch === prepared.epoch && this.rpc === prepared.rpc) this.reserved.delete(key);
        // Keep numeric rejection codes for local diagnostics without retaining
        // backend text, transaction bytes or arbitrary response data.
        throw Object.assign(new Error('The node rejected this claim. Its bounty or proof may no longer be valid.'), {
          code: error.code, data: { node_code: error.data?.node_code },
        });
      }
      // A timeout, disconnect, mismatched reply or already-known TX can follow a
      // successful broadcast. Stop instead of producing and retrying another claim.
      const message = `Claim broadcast was not confirmed. Check transaction ${signed.txid} before enabling Automatic Claims again.`;
      // Close the global dispatch gate immediately, before another proof can
      // broadcast. Never await stop from one of the tasks it must drain.
      // Locking changes the session, not the wallet that sent the transaction.
      // A replaced wallet, however, must not inherit another wallet's response.
      if (prepared.walletGeneration === this.walletGeneration) this.stopClaimsForReview(message);
      throw Object.assign(new Error(message), { code: error.code, data: { node_code: error.data?.node_code }, unknownOutcome: true });
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    const refreshing = this.refreshing;
    const liveWork = [this.liveUpdates?.running, this.walletUpdates?.running, this.bountyUpdates?.running, this.bountySync].filter(Boolean);
    // lock() publishes cleared sensitive state synchronously before its first await.
    const locking = this.lock();
    this.statePublisher.close();
    await locking; this.rpc?.close();
    // The interrupted refresh must publish its terminal diagnostic before the
    // lifecycle marker is flushed and Electron exits.
    await refreshing?.catch(() => {});
    await Promise.allSettled(liveWork);
    // Finish any already-started atomic encrypted write before Electron exits.
    await this.persisting.catch(() => {});
    await this.walletWrite?.catch(() => {});
    await this.settingsWrite.catch(() => {});
    this.recordDiagnostic('wallet.closed', { stage: 'lifecycle' });
    await this.diagnostics?.flush();
  }
}
