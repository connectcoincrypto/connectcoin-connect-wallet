import { EventEmitter } from 'node:events';
import { randomUUID, randomInt } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { buildPaymentUri, parsePaymentUri, parseClipboardPaymentText, validatePaymentDetails } from './payment-uri.mjs';
import { paymentQrDataUrl } from './payment-qr.mjs';
import { RpcClient } from './rpc.mjs';
import { readConfig, writeConfig, validateConfig, validateTheme, validateDeveloperMode, validateTip } from './config.mjs';
import { createPublicAccountDeriver, generateMnemonic, normalizeMnemonic, validateMnemonic, decodeAddress, networkParameters, MAX_ADDRESS_INDEX } from './crypto.mjs';
import { createVault, unlockVault, updateVault, validatePassword, replaceVault, vaultFingerprint } from './vault.mjs';
import { MAX_PAYMENT_INPUTS, MAX_PAYMENT_PARENT_HEX_BYTES, selectPaymentFunding, FundingTransactionCache, attachClaimProof, parseTransaction, parseCoinAmount, formatCoinAmount, estimateClaimFee, transactionIdFromRaw, normalizeDomain, workTargetForExpectedConnections } from './transaction.mjs';
import { FundingBytesCache } from './funding-cache.mjs';
import { validateIndexedClaimStatus } from './claim-receipt.mjs';
import { buildPaymentInWorker } from './payment-builder.mjs';
import { ClaimsEngine, getClaimsHelper, isKnownClaimRejection } from './claims.mjs';
import { bountyKey, discoverBounties, readBountyBlock, BountyDiscoveryBusy } from './bounty-discovery.mjs';
import { DiagnosticLog } from './diagnostics.mjs';
import { StatePublisher } from './state-publisher.mjs';
import { performance } from 'node:perf_hooks';
import { selectVaultFile, VAULT_NAME } from './profile-paths.mjs';
import { createRsaProbe } from './rsa-probe.mjs';
import { LiveUpdates, confirmTipChange } from './live-updates.mjs';
import { EventRefresh } from './event-refresh.mjs';
import { addressSetKey, beginAddressSync, setAddressBaseline, updateAddressSync, addressSyncSnapshot } from './address-sync.mjs';
import { setImmediate as yieldTask } from 'node:timers/promises';

const HASH = /^[0-9a-f]{64}$/;
const MONEY = /^-?\d{1,19}$/;
const ADDRESS_GAP = 20;
const ADDRESS_BUILD_BATCH = 32;
// Pipeline round trips, not unbounded address fan-out. Each worker sends only
// one page at a time through RpcClient's shared capacity and per-method quota.
const ADDRESS_BASELINE_CONCURRENCY = 4;
// Internal callers need the completed read, not an extra full UI snapshot.
// A private marker keeps renderer-supplied refresh parameters unchanged.
const REFRESH_WITHOUT_SNAPSHOT = Symbol('refresh-without-snapshot');
// vault.mjs permits 131072 ciphertext hex characters, or 65536 plaintext bytes.
// Keep every saved annotation; when full, the user can send without new notes.
const WALLET_PLAINTEXT_LIMIT = 65536;
const PAYMENT_DETAILS_HEADROOM = 512; // Future derivation indexes and recovery flags.
function validateStoredPaymentDetails(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The saved payment details are invalid.');
  const result = {};
  for (const [txid, details] of Object.entries(value)) {
    if (!HASH.test(txid) || !details || typeof details !== 'object' || Array.isArray(details)) throw new Error('The saved payment details are invalid.');
    try { result[txid] = validatePaymentDetails(details); }
    catch { throw new Error('The saved payment details are invalid.'); }
  }
  return result;
}
function amount(value) {
  if (typeof value !== 'string' || !MONEY.test(value)) throw new Error('RPC returned an invalid monetary amount.');
  const parsed = BigInt(value);
  if (parsed > 1000000000000000000n || parsed < -1000000000000000000n) throw new Error('RPC returned an invalid monetary amount.');
  return parsed;
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
  #claimFunding = new FundingTransactionCache();
  #claimFundingContext = null;
  #fundingGeneration = 0;
  #signedClaims = new WeakMap();
  #confirmedClaims = new WeakSet();
  #claimConfirmations = new Map();
  #countedClaimConfirmations = new Set();
  constructor({ directory, resourcesPath, network = 'main', allowRegtest = false, clientFactory = options => new RpcClient(options), proofRunner, connectionPoolFactory, rsaProbe } = {}) {
    super(); Object.assign(this, { directory, resourcesPath, allowRegtest, clientFactory, proofRunner, connectionPoolFactory });
    this.configOptions = { allowRegtest, network };
    this.vaultFile = join(directory, VAULT_NAME);
    this.diagnostics = null;
    this.session = null; this.epoch = 0; this.setup = null; this.preview = null;
    this.rsaProbe = rsaProbe ?? createRsaProbe({ resourcesPath });
    this.sendPreparation = null; this.sendConfirmation = null;
    this.replacement = null; this.walletWrite = null; this.closed = false;
    this.walletExists = false; this.accounts = []; this.accountCache = new Map(); this.utxos = []; this.history = [];
    this.accountDerivation = null;
    this.balance = null; this.qrDataUrl = null; this.error = null; this.rpc = null;
    this.network = { status: 'offline', chain: network, height: null };
    this.claimBlocks = new Map(); this.claimCursor = null; this.claimWindow = null; this.claimInfo = {}; this.retiredClaims = new Map(); this.tip = null;
    this.reserved = new Set(); this.fundingCache = new FundingBytesCache(); this.fundingPending = new Map(); this.lastActivity = Date.now(); this.persisting = Promise.resolve();
    this.statePublisher = new StatePublisher({ publish: () => this.emit('state', this.getState()) });
    this.statePriority = null;
    this.settingsWrite = Promise.resolve(); this.claimToggleGeneration = 0; this.claimsResumePending = false;
    this.walletGeneration = 0; this.claimsReviewRequired = false; this.claimsReviewGeneration = 0;
    this.claimRevision = 0; this.claimCatalogGate = null;
    this.bountyCapabilities = {};
  }
  async initialize() {
    this.vaultFile = selectVaultFile(this.directory);
    this.config = await readConfig(this.directory, this.configOptions);
    this.walletExists = await access(this.vaultFile).then(() => true, () => false);
    this.diagnostics = new DiagnosticLog({ directory: this.directory });
    this.recordDiagnostic('wallet.started', { stage: 'lifecycle' });
    await this.diagnostics.flush();
    this.connectClient(); this.createEngine();
    this.timer = setInterval(() => {
      if (this.setup && Date.now() > this.setup.expires) { this.setup = null; this.emitState(); }
      if (this.replacement && Date.now() > this.replacement.expires) this.cancelWalletReplacement();
      if (this.session && this.config.autoLockMinutes > 0 && Date.now() - this.lastActivity >= this.config.autoLockMinutes * 60000) void this.lock();
      // Local security housekeeping only. Network updates arrive via RPC subscriptions.
    }, 1000);
    this.timer.unref?.();
    return this.getState();
  }
  connectClient() {
    this.stopLiveUpdates();
    this.cancelSendPreview();
    this.batchFundingSupported = undefined;
    this.bountyCapabilities = {};
    this.rpc?.close(); this.refreshing = null; this.clearFundingCache(); this.fundingPending.clear();
    const rpc = this.clientFactory({ ...this.config.rpc, onDiagnostic: (event, details) => this.recordDiagnostic(event, details) }); this.rpc = rpc;
    this.releaseClaimCatalog();
    this.tip = null; this.claimWindow = null;
    this.confirmationTip = null; this.confirmationsStale = false; this.walletChainRevision = 0;
    this.liveUpdateWarning = null;
    this.network = { status: 'offline', chain: this.config.network, height: null };
    this.walletUpdateRevision = 0; this.walletReadRevision = -1;
    this.addressSync = null; this.addressSyncPending = null; this.addressChangesSupported = undefined;
    const active = () => !this.closed && Boolean(this.session) && this.rpc === rpc;
    this.walletUpdates = new EventRefresh({ isActive: active, delayMs: 150, run: async () => {
      // An event during an existing read needs a fresh pass, not its old promise.
      if (this.refreshing) await this.refreshing.catch(() => {});
      if (active() && this.walletReadRevision < this.walletUpdateRevision) await this.refresh(REFRESH_WITHOUT_SNAPSHOT);
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
    let noticeRevision = 0, tipCheckPending = false;
    const applyChange = ({ wallet, bounties, reset, catchup, tip }) => {
        if (!active()) return;
        if (reset) {
          wallet = true; bounties = true;
          this.walletChainRevision++;
          this.confirmationTip = tip ? { ...tip } : null; this.tip = tip ? { ...tip } : null;
          this.confirmationsStale = true;
          this.addressSync = null; this.addressSyncPending = null;
          // Reject an in-flight pre-reorg snapshot before it can resume workers.
          this.claimRevision++; this.claimCursor = null; this.claimBlocks.clear();
          // Keep only the immutable hash anchor. With no cursor, discovery
          // must fetch a fresh prefix and reload the complete bounty catalog.
          // A journal reset invalidates the snapshot, not the cryptographic
          // work already in flight. Reorg removals are applied by the fenced
          // replacement discovery; disconnect/lock still stop the whole run.
          this.blockClaimCatalog();
        } else if (tip) {
          this.observeConfirmationTip(tip);
          this.emitState();
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
    };
    this.tipUpdates = new EventRefresh({ isActive: active, run: async () => {
      if (!tipCheckPending) return;
      const previous = this.confirmationTip ?? this.tip;
      if (!previous) { tipCheckPending = false; return; }
      const watch = this.liveUpdates, generation = watch.generation, epoch = this.epoch;
      const revision = noticeRevision, chainRevision = this.walletChainRevision;
      const current = () => active() && this.liveUpdates === watch && !watch.closed &&
        watch.generation === generation && this.epoch === epoch;
      const check = () => {
        if (!current()) throw Object.assign(new Error('Live tip confirmation cancelled.'), { name: 'AbortError' });
      };
      const result = await confirmTipChange({ rpc, network: this.config.network, previous,
        signal: watch.abort.signal, check });
      if (!current()) return;
      const latest = this.confirmationTip ?? this.tip;
      if (revision !== noticeRevision || chainRevision !== this.walletChainRevision ||
          latest?.hash !== previous.hash || latest?.height !== previous.height || latest?.mediantime !== previous.mediantime) {
        this.tipUpdates.request(); return;
      }
      tipCheckPending = false;
      applyChange({ ...result, bounties: true, wallet: result.reset });
    } });
    this.liveUpdates = new LiveUpdates({ rpc, network: this.config.network, isActive: active,
      getAddresses: () => {
        // Watch the currently displayed receive/change addresses first when a
        // large recovered wallet reaches the shared server subscription limit.
        const addresses = new Set();
        for (const account of this.accounts) {
          if (account.index === this.session?.data[account.change ? 'changeIndex' : 'receiveIndex']) addresses.add(account.address);
        }
        for (const account of this.accounts) addresses.add(account.address);
        for (const account of this.accountCache.values()) addresses.add(account.address);
        return [...addresses];
      },
      onChange: flags => {
        if (!active()) return;
        const { reset, tip } = flags, previous = this.confirmationTip ?? this.tip;
        if (reset || tip) noticeRevision++;
        if (reset) {
          // Explicit journal/reorg invalidations remain immediate and supersede
          // any older asynchronous check, including on the same connection.
          tipCheckPending = false;
          applyChange(flags); return;
        }
        if (tip && previous && (tip.height < previous.height ||
            tip.height === previous.height && tip.hash !== previous.hash)) {
          tipCheckPending = true; this.tipUpdates.request();
          applyChange({ ...flags, tip: undefined }); return;
        }
        applyChange(flags);
        if (tipCheckPending && tip) this.tipUpdates.request();
      },
      onError: error => {
        if (!active()) return;
        if (['LIVE_UPDATE_ADDRESS_CAPACITY', 'LIVE_UPDATE_ADDRESS_UNSUPPORTED'].includes(error.code)) this.liveUpdateWarning = error.message;
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
      this.bountyCapabilities = {};
      this.claimsResumePending = Boolean(this.session && this.config.claims.enabled && !this.claimsReviewRequired);
      this.claimRevision++; this.claimToggleGeneration++;
      this.walletUpdateRevision++;
      this.walletChainRevision++; this.confirmationsStale = true;
      this.tip = null; this.claimWindow = null;
      this.clearFundingCache();
      this.confirmationTip = null;
      this.network.status = 'offline';
      this.cancelSendPreview();
      this.claimSuspending = this.engine?.stop(); this.releaseClaimCatalog(); this.emitState();
    });
  }
  stopLiveUpdates() {
    clearTimeout(this.claimReceiptTimer); this.claimReceiptTimer = null;
    this.liveUpdates?.close(); this.walletUpdates?.close(); this.bountyUpdates?.close(); this.tipUpdates?.close();
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
      getValidationTime: context => {
        // A reset may temporarily clear the current tip, but not the validated
        // hash anchor. Prefer its MTP over a long-lived proposal's older time.
        // The proposal fallback is only for preserved work behind the write
        // barrier, never a substitute for validating a new RPC tip.
        const tip = this.tip ?? (this.claimCatalogGate ? this.claimWindow?.tip : null);
        if (!tip && this.claimCatalogGate && context) return context.validation_time;
        return validateTip(tip, this.config.network).mediantime;
      },
      options: { connectionsPerSecond: this.config.claims.maxConnectionsPerSecond, concurrency: this.config.claims.maxConcurrent },
      onState: state => {
        this.claimInfo = state;
        for (const [key, row] of this.retiredClaims) if (!this.engine?.hasActive(key) && !this.engine?.pendingProofs?.has(key)) {
          if (this.claimOutpoints?.get(key) === row) this.claimOutpoints.delete(key);
          this.retiredClaims.delete(key);
        }
        if (this.engine) this.scheduleClaimReceipts();
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
      network: { ...this.network, ...(this.confirmationTip ? { height: this.confirmationTip.height } : {}), host: this.config.rpc.host, port: this.config.rpc.port },
      config: structuredClone(this.config), history: this.session ? this.history.map(row => {
        const projected = { ...row };
        // This is a display projection, not an address-cache/cursor update and
        // never evidence that a pending transaction was mined or funds changed.
        if (this.confirmationTip && !this.confirmationsStale && row.status === 'confirmed' &&
            Number.isSafeInteger(row.blockHeight) && row.blockHeight >= 0 && row.blockHeight <= this.confirmationTip.height) {
          projected.confirmations = this.confirmationTip.height - row.blockHeight + 1;
        }
        const details = this.session.data.paymentDetails?.[row.txid];
        return details ? { ...projected, ...details } : projected;
      }) : [],
      claims: { ...this.claimInfo, enabled: Boolean(this.engine?.enabled), available: this.claimInfo.queued ?? 0,
        lastErrorDiagnostic: this.claimInfo.lastErrorDiagnostic === true,
        sent: this.claimInfo.completed ?? 0, successful: this.claimInfo.completed ?? 0,
        helperAvailable: Boolean(this.proofRunner || this.connectionPoolFactory || getClaimsHelper({ resourcesPath: this.resourcesPath })), scanning: Boolean(this.scanningBounties) },
      busy: Boolean(this.refreshing), error: this.error ?? this.liveUpdateWarning,
      paymentPreparation: this.session && this.paymentPreparation ? { ...this.paymentPreparation } : null,
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
  observeConfirmationTip(value) {
    const tip = validateTip(value, this.config.network);
    // A read begun before a newer push must not move the displayed height back.
    if (!this.confirmationTip || tip.height > this.confirmationTip.height || tip.hash === this.confirmationTip.hash) {
      this.confirmationTip = { ...tip };
    }
  }
  checkWalletChain(revision) {
    if (revision !== this.walletChainRevision) throw Object.assign(new Error('Wallet snapshot invalidated by a chain reorganization.'), { name: 'AbortError', code: 'ABORT_ERR' });
  }
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
    // A lock can interrupt confirmation while its pre-broadcast encrypted save
    // drains. Do not reopen an older snapshot before that save has settled.
    await this.persisting.catch(() => {});
    if (this.closed || this.epoch !== epoch) throw new Error('Unlock was cancelled.');
    const data = await unlockVault(this.vaultFile, password);
    if (this.epoch !== epoch) throw new Error('Unlock was cancelled.');
    await this.openSession(data, password); return this.getState();
  }
  async openSession(data, password) {
    if (data.network !== this.config.network) throw new Error('Wallet and RPC configuration belong to different networks.');
    for (const key of ['receiveIndex', 'changeIndex']) if (!Number.isSafeInteger(data[key]) || data[key] < 0 || data[key] > MAX_ADDRESS_INDEX) throw new Error('Unsupported wallet address index.');
    for (const key of ['lastUsedReceive', 'lastUsedChange']) {
      const index = data[key] === undefined ? -1 : data[key];
      if (!Number.isSafeInteger(index) || index < -1 || index > MAX_ADDRESS_INDEX) throw new Error('Unsupported last-used wallet address index.');
    }
    walletName(data.name);
    if (data.paymentDetails !== undefined) data.paymentDetails = validateStoredPaymentDetails(data.paymentDetails);
    this.replacement = null; this.setup = null;
    this.clearAccountDerivation();
    this.session = { data, password }; this.epoch++; this.activity(); this.error = null;
    const epoch = this.epoch;
    await this.buildAccounts(); this.assertSession(epoch); await this.makeQR(); this.assertSession(epoch); this.emitState();
    this.liveUpdates.start();
    if (this.session && !this.closed && this.config.claims.enabled) void this.resumeClaims();
    void this.refresh(REFRESH_WITHOUT_SNAPSHOT).catch(() => {});
  }
  clearAccountDerivation() {
    const previous = this.accountDerivation;
    this.accountDerivation = null; this.accountCache.clear();
    previous?.deriver.destroy();
  }
  publicAccount(index, change) {
    this.assertSession();
    if (!Number.isSafeInteger(index) || index < 0 || index > MAX_ADDRESS_INDEX || ![0, 1].includes(change)) throw new Error('Invalid derivation index');
    const context = this.accountDerivation;
    // Check ownership before even a cache hit. Only public derivation branches
    // are retained; seed/private nodes are disposed before the helper returns.
    if (!context || context.epoch !== this.epoch || context.session !== this.session || context.network !== this.config.network) {
      this.clearAccountDerivation();
      this.accountDerivation = { epoch: this.epoch, session: this.session, network: this.config.network,
        deriver: createPublicAccountDeriver(this.session.data.mnemonic, { network: this.config.network, passphrase: this.session.data.passphrase }) };
    }
    const cacheKey = `${change}:${index}`;
    if (this.accountCache.has(cacheKey)) return this.accountCache.get(cacheKey);
    const publicData = this.accountDerivation.deriver.derive(index, change);
    this.accountCache.set(cacheKey, publicData); return publicData;
  }
  async buildAccounts() {
    this.assertSession();
    const epoch = this.epoch;
    for (;;) {
      let build = this.accountBuild;
      if (build?.epoch !== epoch) {
        build = { epoch };
        build.promise = this.buildAccountsInternal(epoch).finally(() => {
          if (this.accountBuild === build) this.accountBuild = null;
        });
        this.accountBuild = build;
      }
      const limits = await build.promise;
      this.assertSession(epoch);
      // A small build can finish synchronously before another caller extends
      // the range in the same turn. Recheck even when joining a finished build.
      if (this.accountRangeMaxima().every((maximum, change) => maximum === limits[change])) return;
    }
  }
  accountRangeMaxima() {
    return [0, 1].map(change => {
      const issued = this.session.data[change ? 'changeIndex' : 'receiveIndex'];
      const used = this.session.data[change ? 'lastUsedChange' : 'lastUsedReceive'] ?? -1;
      return this.session.data.scanLookahead ? Math.min(MAX_ADDRESS_INDEX, Math.max(issued, used + ADDRESS_GAP)) : issued;
    });
  }
  async buildAccountsInternal(epoch) {
    const chains = [[], []];
    let prepared = 0;
    for (;;) {
      this.assertSession(epoch);
      const limits = this.accountRangeMaxima();
      for (const change of [0, 1]) {
        if (chains[change].length > limits[change] + 1) chains[change].length = limits[change] + 1;
        for (let index = chains[change].length; index <= limits[change]; index++) {
          chains[change].push(this.publicAccount(index, change));
          // Large address ranges must not block lock/suspend or the UI. Only
          // public accounts are retained; never publish a cancelled partial list.
          if (++prepared % ADDRESS_BUILD_BATCH === 0) {
            await yieldTask(); this.assertSession(epoch);
          }
        }
      }
      // A refresh or new-address action may extend the range while we yield.
      // Share this build and include the latest range before publishing it.
      if (this.accountRangeMaxima().some((maximum, change) => maximum !== limits[change])) continue;
      this.accounts = chains[0].concat(chains[1]);
      this.liveUpdates?.updateAddresses();
      return limits;
    }
  }
  async makeQR() {
    const epoch = this.epoch;
    const address = this.accounts.find(a => a.change === 0 && a.index === this.session?.data.receiveIndex)?.address;
    const qrDataUrl = address ? await paymentQrDataUrl(buildPaymentUri({ address })) : null;
    if (epoch === this.epoch && this.session && address === this.accounts.find(a => a.change === 0 && a.index === this.session.data.receiveIndex)?.address) this.qrDataUrl = qrDataUrl;
  }
  paymentRequestUri({ amount, label, message } = {}) {
    this.assertSession();
    const address = this.accounts.find(a => a.change === 0 && a.index === this.session.data.receiveIndex)?.address;
    return { address, uri: buildPaymentUri({ address, amount, label, message }) };
  }
  async paymentRequest(payload = {}) {
    const epoch = this.epoch;
    const { address, uri } = this.paymentRequestUri(payload);
    const qrDataUrl = await paymentQrDataUrl(uri);
    this.assertSession(epoch);
    if (address !== this.paymentRequestUri().address) throw new Error('The receive address changed. Create the payment request again.');
    return { address, uri, qrDataUrl };
  }
  paymentRequestForCopy({ amount, label, message, expectedUri, expectedAddress } = {}) {
    const request = this.paymentRequestUri({ amount, label, message });
    // Clipboard writes must match exactly what the user reviewed. Do not yield
    // between this validation and starting the asynchronous write in main.mjs.
    if (expectedUri !== request.uri || expectedAddress !== request.address) throw new Error('The payment request changed. Review it before copying again.');
    return request;
  }
  parsePaymentRequest({ uri } = {}) {
    this.assertSession();
    const request = parsePaymentUri(uri);
    // Bech32 parsing libraries can quote their input in errors. Only return a
    // fixed message to the renderer, never an untrusted URI or address fragment.
    try { decodeAddress(request.address, this.config.network); }
    catch { throw new Error('The payment address is invalid or belongs to a different network.'); }
    return request;
  }
  parseClipboardPaymentRequest({ text } = {}) {
    this.assertSession();
    const request = parseClipboardPaymentText(text);
    // Keep the same local checksum/network checks and fixed errors as URI-only
    // imports. Neither successful parsing nor rejection may perform RPC calls.
    try { decodeAddress(request.address, this.config.network); }
    catch { throw new Error('The payment address is invalid or belongs to a different network.'); }
    return request;
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
    this.clearFundingCache(); this.fundingPending.clear(); this.claimBlocks.clear(); this.claimOutpoints?.clear(); this.claimCursor = null; this.claimWindow = null; this.reserved.clear(); this.#claimConfirmations.clear(); this.#countedClaimConfirmations.clear(); this.clearAccountDerivation();
    // Install an idle client while still locked. Password entry can finish
    // before a slow claims helper drains; that newer session must not inherit
    // the permanently closed RPC/live-update objects from the previous one.
    // Construction does not connect or subscribe until the wallet unlocks.
    this.connectClient();
    // Hide sensitive renderer state immediately, before waiting for helper shutdown.
    this.emitState();
    await this.engine?.stop('locked'); this.engine?.clear();
    if (epoch !== this.epoch) return this.getState();
    this.emitState(); return this.getState();
  }
  async newAddress() {
    this.assertSession();
    const epoch = this.epoch;
    if (this.session.data.needsRecovery) throw new Error('Wait for recovery discovery to finish.');
    if (this.session.data.receiveIndex >= MAX_ADDRESS_INDEX) throw new Error('The BIP32 receive-address index range is exhausted.');
    if (this.session.data.receiveIndex >= (this.session.data.lastUsedReceive ?? -1) + ADDRESS_GAP) throw new Error('Use one of your existing receive addresses before creating more. Recovery keeps a 20-address gap.');
    const previousIndex = this.session.data.receiveIndex;
    this.session.data.receiveIndex++;
    try { await this.persist(); }
    catch(error) { if (epoch === this.epoch && this.session) this.session.data.receiveIndex = previousIndex; throw error; }
    this.assertSession(epoch); await this.buildAccounts(); this.assertSession(epoch); await this.makeQR(); this.assertSession(epoch); this.emitState();
    this.walletUpdateRevision++; this.walletUpdates?.request();
    void this.refresh(REFRESH_WITHOUT_SNAPSHOT).catch(() => {});
    this.assertSession(epoch);
    const current = this.accounts.find(account => account.change === 0 && account.index === this.session.data.receiveIndex);
    return { address: current?.address ?? '', qrDataUrl: this.qrDataUrl };
  }
  async getRecoveryPhrase({ password } = {}) {
    this.assertSession(); const epoch = this.epoch;
    const verified = await unlockVault(this.vaultFile, password); this.assertSession(epoch);
    return { mnemonic: verified.mnemonic, path: `m/44'/${networkParameters(verified.network).coin}'/0'/change/index`, network: verified.network };
  }
  async ensureNetwork({ signal } = {}) {
    const epoch = this.epoch, rpc = this.rpc;
    const tip = validateTip(await rpc.request('getchaintip', {}, { signal }), this.config.network);
    this.assertSession(epoch);
    if (rpc !== this.rpc) throw new Error('RPC connection changed.');
    this.network = { ...this.network, status: 'online', height: tip.height, chain: tip.chain };
    this.tip = tip; return tip;
  }
  checkResponse(response) { validateTip(response?.tip, this.config.network); return response; }
  async page(method, address, { firstOnly = false, onTip, onPage, signal, includePendingSpent = false } = {}) {
    const epoch = this.epoch, rpc = this.rpc; const items = []; let cursor; const seen = new Set();
    do {
      this.assertSession(epoch);
      if (seen.size >= 1000) throw new Error('Address pagination exceeds this release’s local resource limit.');
      if (signal?.aborted) throw Object.assign(new Error('Address query cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
      const result = this.checkResponse(await rpc.request(method, { address, ...(cursor ? { cursor } : {}),
        ...(method === 'getaddressutxos' && includePendingSpent ? { include_pending_spent: true } : {}),
      }, { signal }));
      this.assertSession(epoch);
      if (rpc !== this.rpc) throw new Error('RPC connection changed.');
      if (signal?.aborted) throw Object.assign(new Error('Address query cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
      if (result.address !== address || result.unit !== 'connects' || !Array.isArray(result.items) || result.items.length > 500) throw new Error('RPC returned an invalid address page.');
      onTip?.(result.tip);
      items.push(...result.items.map(validateRow));
      if (items.length > 20000) throw new Error('Address history exceeds this release’s local resource limit. No partial balance was accepted.');
      cursor = result.next_cursor;
      if (cursor !== null && (typeof cursor !== 'string' || !cursor.length || cursor.length > 4096 || seen.has(cursor))) throw new Error('RPC returned an invalid or repeated cursor.');
      seen.add(cursor);
      onPage?.(seen.size);
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
        for (let index = 0; index <= MAX_ADDRESS_INDEX && gap < ADDRESS_GAP; index++) {
          this.assertSession(epoch);
          const account = this.publicAccount(index, change);
          if (this.liveUpdates?.started) await this.liveUpdates.watchAddress(account.address);
          this.assertSession(epoch);
          const history = await this.page('getaddresshistory', account.address, { firstOnly: true, onTip });
          if (history.length) { lastUsed[change] = index; gap = 0; } else gap++;
          if (!history.length && stableTip) emptyAddresses.add(account.address);
          if ((index + 1) % ADDRESS_BUILD_BATCH === 0) { await yieldTask(); this.assertSession(epoch); }
        }
      }
      this.assertSession(epoch);
      this.session.data.receiveIndex = Math.min(MAX_ADDRESS_INDEX, Math.max(this.session.data.receiveIndex, lastUsed[0] + 1));
      this.session.data.changeIndex = Math.min(MAX_ADDRESS_INDEX, Math.max(this.session.data.changeIndex, lastUsed[1] + 1));
      this.session.data.lastUsedReceive = lastUsed[0]; this.session.data.lastUsedChange = lastUsed[1]; this.session.data.needsRecovery = false;
      this.session.data.scanLookahead = true;
      await this.persist(); this.assertSession(epoch); await this.buildAccounts(); this.assertSession(epoch); await this.makeQR(); this.assertSession(epoch);
      return emptyAddresses;
    } finally { this.recovering = false; this.emitState(); }
  }
  async refresh(mode) {
    const returnState = mode !== REFRESH_WITHOUT_SNAPSHOT;
    if (!this.session) return returnState ? this.getState() : undefined;
    let operation = this.refreshing;
    if (!operation) {
      const epoch = this.epoch;
      const started = performance.now();
      operation = this.refreshInternal(epoch).catch(error => {
        const cancelled = error?.name === 'AbortError' && !error.unknownOutcome;
        this.recordDiagnostic(cancelled ? 'wallet.refresh_cancelled' : 'wallet.refresh_failed', {
          stage: 'refresh', ...(!cancelled ? { error } : {}), durationMs: Math.round(performance.now() - started),
        });
        if (!cancelled && epoch === this.epoch) { this.error = error.message; if (!this.rpc.socket) this.network.status = 'offline'; this.emitState(); }
        throw error;
      }).finally(() => { if (this.refreshing === operation) this.refreshing = null; this.emitState(); });
      this.refreshing = operation;
      this.emitState();
    }
    // All callers share the validated read, but only the public action builds
    // a return snapshot. Do so after finally, using the current lifecycle and
    // busy flag rather than a snapshot captured before a lock or reconnect.
    await operation;
    return returnState ? this.getState() : undefined;
  }
  async refreshInternal(epoch) {
    const chainRevision = this.walletChainRevision;
    this.assertSession(epoch); this.checkWalletChain(chainRevision);
    const updateRevision = this.walletUpdateRevision;
    // The address journal already validates the network and fences its complete
    // snapshot with a tip. A separate preflight tip cannot strengthen that
    // snapshot and would add a request to every notification-driven refresh.
    if (!this.session.data.needsRecovery && this.addressChangesSupported !== false && await this.refreshAddressChanges(epoch, updateRevision, chainRevision)) return;
    await this.ensureNetwork(); this.assertSession(epoch); this.checkWalletChain(chainRevision);
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
    this.checkWalletChain(chainRevision);
    if (highestReceive !== this.session.data.lastUsedReceive || highestChange !== this.session.data.lastUsedChange) {
      const readAddresses = new Set(this.accounts.map(account => account.address));
      this.session.data.lastUsedReceive = highestReceive; this.session.data.lastUsedChange = highestChange;
      await this.persist(); this.assertSession(epoch); await this.buildAccounts(); this.assertSession(epoch);
      if (this.accounts.some(account => !readAddresses.has(account.address))) {
        // These new lookahead addresses were not part of this pass's reads.
        this.walletUpdateRevision++; this.walletUpdates?.request();
      }
    }
    this.assertSession(epoch); this.checkWalletChain(chainRevision);
    this.utxos = utxos;
    this.balance = Object.fromEntries(Object.entries(totals).map(([key,value]) => [key, formatSigned(value)]));
    this.history = [...history.values()].sort((a,b) => (b.block_height ?? Number.MAX_SAFE_INTEGER) - (a.block_height ?? Number.MAX_SAFE_INTEGER)).map(row => ({
      txid: row.txid, direction: row.net < 0n ? 'sent' : row.net > 0n ? 'received' : 'self',
      amount: formatCoinAmount(row.net < 0n ? -row.net : row.net), status: row.status, confirmations: row.confirmations, blockHeight: row.block_height,
    }));
    this.observeConfirmationTip(this.tip); this.confirmationsStale = false;
    this.error = null; this.emitState();
    this.walletReadRevision = Math.max(this.walletReadRevision, updateRevision);
    // Bounty discovery has its own event queue; address RPC latency must not gate it.
    this.liveUpdates?.updateAddresses();
    // An explicit refresh can also recover a saved start that failed offline.
    // Normal discovery never waits here; its subscription queue runs independently.
    if (!this.engine.enabled && this.config.claims.enabled && this.claimsResumePending) await this.resumeClaims();
    return;
  }
  async refreshAddressChanges(epoch, updateRevision, chainRevision = this.walletChainRevision) {
    const rpc = this.rpc, accounts = [...this.accounts], addresses = accounts.map(account => account.address), key = addressSetKey(addresses);
    const check = () => {
      this.assertSession(epoch);
      this.checkWalletChain(chainRevision);
      if (rpc !== this.rpc) throw Object.assign(new Error('Address synchronization cancelled after the RPC connection changed.'), { name: 'AbortError', code: 'ABORT_ERR' });
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let candidate = this.addressSyncPending?.key === key ? this.addressSyncPending : this.addressSync?.key === key ? this.addressSync : null;
        if (!candidate) {
          // Capture the journal watermark BEFORE the legacy baseline. Replay
          // closes races with mining, mempool changes and keyset insertion.
          candidate = await beginAddressSync({ rpc, network: this.config.network, addresses, check });
          this.addressChangesSupported = true;
          const baseline = new AbortController();
          let nextAccount = 0, failure;
          const worker = async () => {
            while (!baseline.signal.aborted && nextAccount < accounts.length) {
              const account = accounts[nextAccount++];
              try {
                check();
                if (this.liveUpdates?.started) await this.liveUpdates.watchAddress(account.address, { signal: baseline.signal });
                check();
                if (baseline.signal.aborted) return;
                const history = await this.page('getaddresshistory', account.address, { signal: baseline.signal });
                check();
                const issued = this.session.data[account.change ? 'changeIndex' : 'receiveIndex'];
                const utxos = history.length || account.index <= issued
                  ? await this.page('getaddressutxos', account.address, { includePendingSpent: true, signal: baseline.signal }) : [];
                check();
                if (baseline.signal.aborted) return;
                setAddressBaseline(candidate, account.address, { history, utxos });
              } catch (error) {
                // Keep the original failure, stop queued work, and observe all
                // already-sent replies before retrying or discarding this snapshot.
                if (!baseline.signal.aborted) { failure = error; baseline.abort(); }
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(ADDRESS_BASELINE_CONCURRENCY, accounts.length) }, worker));
          if (baseline.signal.aborted) throw failure;
        }
        candidate = await updateAddressSync(candidate, { rpc, check }); check();
        // Copy-on-write journal maps retain identity only when no row changed.
        // The exact tip must also match: a new block can mature coinbase outputs
        // even without any address events. Never reuse a partial/busy candidate's
        // projection or skip the validated journal replay above.
        const published = this.addressSync;
        const unchanged = published && published.key === key && published.addresses === candidate.addresses &&
          published.tip.hash === candidate.tip.hash && published.tip.height === candidate.tip.height &&
          published.tip.mediantime === candidate.tip.mediantime && this.balance !== null;
        const snapshot = unchanged ? null : addressSyncSnapshot(candidate, accounts);
        const highestReceive = Math.max(this.session.data.lastUsedReceive ?? -1, snapshot?.highestReceive ?? -1);
        const highestChange = Math.max(this.session.data.lastUsedChange ?? -1, snapshot?.highestChange ?? -1);
        if (highestReceive !== this.session.data.lastUsedReceive || highestChange !== this.session.data.lastUsedChange) {
          this.session.data.lastUsedReceive = highestReceive; this.session.data.lastUsedChange = highestChange;
          await this.persist(); check(); await this.buildAccounts(); check();
          if (addressSetKey(this.accounts.map(account => account.address)) !== key) {
            this.walletUpdateRevision++; this.walletUpdates?.request();
          }
        }
        check();
        this.addressSync = candidate;
        this.addressSyncPending = null;
        this.tip = candidate.tip; this.network = { ...this.network, status: 'online', height: candidate.tip.height, chain: candidate.tip.chain };
        if (snapshot) {
          this.utxos = snapshot.utxos;
          this.balance = Object.fromEntries(Object.entries(snapshot.totals).map(([name, value]) => [name, formatSigned(value)]));
          this.history = [...snapshot.history.values()].sort((a, b) => (b.block_height ?? Number.MAX_SAFE_INTEGER) - (a.block_height ?? Number.MAX_SAFE_INTEGER)).map(row => ({
            txid: row.txid, direction: row.net < 0n ? 'sent' : row.net > 0n ? 'received' : 'self',
            amount: formatCoinAmount(row.net < 0n ? -row.net : row.net), status: row.status, confirmations: row.confirmations, blockHeight: row.block_height,
          }));
        }
        this.observeConfirmationTip(candidate.tip); this.confirmationsStale = false;
        this.walletReadRevision = Math.max(this.walletReadRevision, updateRevision);
        this.error = null; this.emitState(); this.liveUpdates?.updateAddresses();
        if (!this.engine.enabled && this.config.claims.enabled && this.claimsResumePending) await this.resumeClaims();
        return true;
      } catch (error) {
        check();
        if (error?.code === -32601) {
          this.addressChangesSupported = false; this.addressSync = null; this.addressSyncPending = null; return false;
        }
        if (error?.code === 'ADDRESS_SYNC_BUSY') { this.addressSyncPending = error.candidate; throw error; }
        if (error?.code !== -32011) throw error;
        this.addressSync = null; this.addressSyncPending = null;
        if (attempt === 1) throw error;
      }
    }
    return false;
  }
  clearFundingCache() {
    this.#fundingGeneration++;
    this.fundingCache.clear(); this.#claimFunding.clear(); this.#claimFundingContext = null;
    this.fundingPending.clear();
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
    const epoch = this.epoch, rpc = this.rpc, generation = this.#fundingGeneration;
    const check = () => {
      this.assertSession(epoch);
      if (this.rpc !== rpc || generation !== this.#fundingGeneration) throw Object.assign(new Error('RPC funding context changed while preparing funding.'), { name: 'AbortError', code: 'ABORT_ERR' });
    };
    const existing = this.fundingPending.get(txid);
    if (existing?.epoch === epoch && existing.rpc === rpc && existing.generation === generation) return wait(existing.promise);
    if (this.fundingPending.size >= 256) throw new Error('Too many funding transactions are being prepared; retry shortly.');
    const entry = { epoch, rpc, generation };
    entry.promise = Promise.resolve().then(async () => {
      check();
      const capabilities = this.bountyCapabilities, rawOnly = capabilities.rawFunding !== false;
      let result;
      try { result = await rpc.request('gettransaction', { txid, ...(rawOnly ? { raw_only: true } : {}) }); }
      catch (error) {
        // Only an explicit unsupported option permits an expanded retry. A
        // timeout, malformed success or missing parent never downgrades checks.
        if (!rawOnly || error.code !== -32602) throw error;
        check(); capabilities.rawFunding = false;
        result = await rpc.request('gettransaction', { txid });
      }
      check();
      const raw = this.checkResponse(result).transaction?.hex;
      if (transactionIdFromRaw(raw) !== txid) throw new Error('The RPC server supplied transaction bytes that do not match their ID.');
      this.fundingCache.set(txid, raw); return raw;
    }).finally(() => { if (this.fundingPending.get(txid) === entry) this.fundingPending.delete(txid); });
    this.fundingPending.set(txid, entry);
    return wait(entry.promise);
  }
  async paymentParents(selected, signal, onProgress) {
    const epoch = this.epoch, rpc = this.rpc, generation = this.#fundingGeneration, parents = new Map();
    let parentHexLength = 0, completed = 0;
    const check = () => {
      this.assertSession(epoch);
      if (signal.aborted || rpc !== this.rpc || generation !== this.#fundingGeneration) throw Object.assign(new Error('Payment review cancelled.'), { name: 'AbortError' });
    };
    // Progress counts selected inputs, not distinct parent transactions. Keep
    // each parent's multiplicity once instead of rescanning every input after
    // every fetched parent (including individual legacy responses).
    const selectedCounts = new Map();
    for (const { txid } of selected) selectedCounts.set(txid, (selectedCounts.get(txid) ?? 0) + 1);
    const progress = () => onProgress(completed);
    const retain = (txid, hex) => {
      if (parents.has(txid)) return;
      if (parentHexLength + hex.length > MAX_PAYMENT_PARENT_HEX_BYTES) throw new Error('Payment funding data exceeds the wallet memory safety limit. Send a smaller amount in separate payments.');
      parentHexLength += hex.length;
      parents.set(txid, hex);
      completed += selectedCounts.get(txid);
    };
    const remember = (txid, hex) => {
      retain(txid, hex);
      this.fundingCache.set(txid, hex);
    };
    const missing = [...selectedCounts.keys()].filter(txid => {
      if (!this.fundingCache.has(txid)) return true;
      retain(txid, this.fundingCache.get(txid)); return false;
    });
    progress();
    while (missing.length) {
      check();
      if (this.batchFundingSupported === false) {
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
          for (;;) {
            check(); const index = next++;
            if (index >= missing.length) return;
            const txid = missing[index];
            const hex = await this.funding(txid, { signal }); check();
            retain(txid, hex); progress();
          }
        }));
        break;
      }
      const txids = missing.slice(0, 32);
      let response;
      try { response = this.checkResponse(await waitForReview(rpc.request('gettransactions', { txids }, { signal }), signal)); }
      catch (error) {
        check();
        if (error?.code === -32601) { this.batchFundingSupported = false; continue; }
        // A parent too large for the bounded batch uses the existing individual
        // method, never a larger frame or an unverified metadata-only shortcut.
        if (error?.code === -32021 && error.data?.txid === txids[0]) {
          const hex = await this.funding(txids[0], { signal }); check();
          retain(txids[0], hex); missing.shift(); progress(); continue;
        }
        throw error;
      }
      check();
      const rows = response.transactions;
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > txids.length || !Array.isArray(response.remaining) ||
          response.remaining.length !== txids.length - rows.length || response.remaining.some((id, index) => id !== txids[rows.length + index])) {
        throw new Error('Invalid RPC funding batch.');
      }
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (row?.txid !== txids[index] || transactionIdFromRaw(row.hex) !== txids[index]) throw new Error('RPC funding transaction bytes do not match their ID.');
        remember(row.txid, row.hex);
        if (index % 4 === 3) { await yieldTask(); check(); }
      }
      this.batchFundingSupported = true;
      missing.splice(0, rows.length); progress();
    }
    check(); return parents;
  }
  cancelSendPreview() {
    this.sendPreparation?.abort();
    this.sendPreparation = null;
    this.sendConfirmation?.abort();
    this.sendConfirmation = null;
    this.preview = null;
    this.paymentPreparation = null;
  }
  async paymentFunding(options, signal, onProgress) {
    const epoch = this.epoch, rpc = this.rpc;
    const report = (stage, completed, total, pages = 0) => {
      this.assertSession(epoch);
      if (signal?.aborted || rpc !== this.rpc) throw Object.assign(new Error('Payment review cancelled.'), { name: 'AbortError' });
      onProgress?.({ stage, completed, total, pages });
    };
    // History is for display/recovery, not a prerequisite for spending. Query
    // fresh UTXOs only, prioritizing accounts known to have large outputs. The
    // cached amounts influence order, never validation of a selected input.
    report('network', 0, 0);
    await waitForReview(this.ensureNetwork({ signal }), signal);
    this.assertSession(epoch);
    const largest = new Map();
    for (const utxo of this.utxos) {
      const path = `${utxo.account.change}:${utxo.account.index}`;
      const value = amount(utxo.amount);
      if (value > (largest.get(path) ?? 0n)) largest.set(path, value);
    }
    const accounts = [...this.accounts].sort((a, b) => {
      const first = largest.get(`${a.change}:${a.index}`) ?? 0n;
      const second = largest.get(`${b.change}:${b.index}`) ?? 0n;
      return first > second ? -1 : first < second ? 1 : 0;
    });
    const utxos = [], pendingCandidates = [], seen = new Set();
    const exactAmount = options.subtractFeeFromAmount === true && options.outputs?.length === 1
      ? amount(options.outputs[0].amount) : null;
    let insufficient, exceedsInputLimit = false;
    let completed = 0, pages = 0;
    report('outputs', completed, accounts.length, pages);
    for (const account of accounts) {
      let addedFreeInput = false;
      const rows = await waitForReview(this.page('getaddressutxos', account.address, { signal, includePendingSpent: options.allowPendingSpent === true,
        onPage: () => report('outputs', completed, accounts.length, ++pages),
      }), signal);
      this.assertSession(epoch);
      for (const row of rows) {
        if (!Number.isInteger(row.vout) || row.vout < 0 || row.vout > 0xffffffff || amount(row.amount) < 0n) throw new Error('Invalid RPC output.');
        const outpoint = `${row.txid}:${row.vout}`;
        if (seen.has(outpoint)) throw new Error('Duplicate RPC funding output.');
        seen.add(outpoint);
        const pendingSpender = row.pending_spent_by ?? null;
        if (pendingSpender !== null && (typeof pendingSpender !== 'string' || !HASH.test(pendingSpender))) throw new Error('Invalid RPC pending spender.');
        const mature = row.mature === true && (row.coinbase !== true ||
          (Number.isSafeInteger(row.block_height) && row.block_height >= 0 && this.tip.height - row.block_height + 1 >= 100));
        if (row.status !== 'confirmed' || !mature) continue;
        if (pendingSpender !== null) {
          // Only a fresh identified mempool conflict can override a local
          // reservation. A checkbox alone never unlocks uncertain broadcasts.
          if (options.allowPendingSpent === true) pendingCandidates.push({ ...row, account });
        } else if (!this.reserved.has(outpoint)) {
          utxos.push({ ...row, account }); addedFreeInput = true;
        }
      }
      if (pendingCandidates.length > MAX_PAYMENT_INPUTS) {
        pendingCandidates.sort((a, b) => {
          const first = BigInt(a.amount), second = BigInt(b.amount);
          if (exactAmount !== null && (first === exactAmount) !== (second === exactAmount)) return first === exactAmount ? -1 : 1;
          return first > second ? -1 : first < second ? 1 : 0;
        });
        pendingCandidates.length = MAX_PAYMENT_INPUTS; exceedsInputLimit = true;
      }
      report('outputs', ++completed, accounts.length, pages);
      // The previous private candidate set has already failed a recoverable
      // plan. An empty/ineligible account cannot change that result. Still
      // validate every row and report every page/account above; pending inputs
      // keep their separate final plan below. Track additions before the cap,
      // since a newly added larger coin can replace one at the same final size.
      if (!addedFreeInput) continue;
      // Match the planner's exact-coin preference for fee deduction before
      // applying the input cap; otherwise a large wallet could discard its
      // only viable no-change input. Keep the largest remaining candidates.
      // Never silently call a truncated set the wallet's entire balance.
      // Otherwise the planner already sorts its own copy with this priority.
      if (utxos.length > MAX_PAYMENT_INPUTS) {
        utxos.sort((a, b) => {
          const first = BigInt(a.amount), second = BigInt(b.amount);
          if (exactAmount !== null && (first === exactAmount) !== (second === exactAmount)) return first === exactAmount ? -1 : 1;
          return first > second ? -1 : first < second ? 1 : 0;
        });
        exceedsInputLimit = true; utxos.length = MAX_PAYMENT_INPUTS;
      }
      if (!utxos.length) continue;
      try { return selectPaymentFunding({ ...options, utxos }).selected; }
      catch (error) {
        // Fees/weight depend on the candidate set too. A later account may
        // contain a single larger coin that makes the same payment viable.
        if (!/^(?:Insufficient|Payment exceeds (?:relay|the standard transaction weight)|Recipient amount after deducting the fee|Transaction fee exceeds the wallet safety limit)/.test(error.message)) throw error;
        insufficient = error;
      }
    }
    if (options.allowPendingSpent === true && pendingCandidates.length) {
      // Prefer an ordinary payment when free coins suffice. Only use pending
      // inputs after checking all accounts, and disclose selected conflicts.
      utxos.push(...pendingCandidates);
      if (utxos.length > MAX_PAYMENT_INPUTS) {
        utxos.sort((a, b) => {
          const first = BigInt(a.amount), second = BigInt(b.amount);
          if (exactAmount !== null && (first === exactAmount) !== (second === exactAmount)) return first === exactAmount ? -1 : 1;
          return first > second ? -1 : first < second ? 1 : 0;
        });
        exceedsInputLimit = true; utxos.length = MAX_PAYMENT_INPUTS;
      }
      try { return selectPaymentFunding({ ...options, utxos }).selected; }
      catch (error) { insufficient = error; }
    }
    if (exceedsInputLimit) throw new Error('This amount needs too many inputs for one standard transaction. Send smaller amounts in separate payments.');
    throw insufficient ?? new Error('Insufficient verified funds for this payment and its fee');
  }
  async previewSend({ address, amount: coins, feeRate = this.config.feeRate, domain, expectedConnections, label = '', message = '', subtractFeeFromAmount = false, allowPendingSpent = false } = {}) {
    this.assertSession(); const epoch = this.epoch;
    if (this.session.data.needsRecovery) throw new Error('Wait for recovery discovery to finish before sending.');
    this.cancelSendPreview();
    if (typeof subtractFeeFromAmount !== 'boolean') throw new Error('Choose whether to deduct fees from the payment.');
    if (typeof allowPendingSpent !== 'boolean') throw new Error('Choose whether to allow replacing pending transactions.');
    const details = validatePaymentDetails({ label, message });
    if (domain === undefined) {
      try { decodeAddress(address, this.config.network); }
      catch { throw new Error('The payment address is invalid or belongs to a different network.'); }
    } else {
      // Report invalid local bounty details before waiting for network/funding.
      domain = normalizeDomain(domain);
      workTargetForExpectedConnections(expectedConnections ?? '1');
    }
    const value = parseCoinAmount(coins); if (value <= 0n) throw new Error('Enter an amount greater than zero.');
    const preparation = new AbortController(), rpc = this.rpc;
    this.sendPreparation = preparation;
    const check = () => {
      this.assertSession(epoch);
      if (preparation.signal.aborted || this.sendPreparation !== preparation || this.rpc !== rpc) {
        throw Object.assign(new Error('Payment review cancelled. Review the payment again.'), { name: 'AbortError' });
      }
    };
    const verified = [];
    const started = performance.now();
    let stage = 'prepare';
    const progress = (completed = 0, total = 0, pages) => {
      check();
      this.paymentPreparation = { stage, completed, total, ...(pages === undefined ? {} : { pages }) };
      this.emitState();
    };
    progress();
    this.recordDiagnostic('payment.prepare_started', { stage });
    try {
      const change = this.publicAccount(this.session.data.changeIndex, 1);
      const output = domain === undefined ? { address, amount: value.toString() } : { domain, amount: value.toString(), expectedConnections, rootVersion: 1, mask: 7 };
      const options = { outputs: [output], changeAddress: change.address, network: this.config.network, feeRate, subtractFeeFromAmount, allowPendingSpent };
      const selected = await this.paymentFunding(options, preparation.signal, update => {
        stage = update.stage; progress(update.completed, update.total, update.pages);
      }); check();
      stage = 'funding';
      let completed = 0;
      progress(completed, selected.length);
      const parents = await this.paymentParents(selected, preparation.signal, count => { completed = count; progress(count, selected.length); });
      for (const utxo of selected) verified.push({ txid: utxo.txid, vout: utxo.vout, amount: utxo.amount,
        account: { index: utxo.account.index, change: utxo.account.change } });
      check();
      const build = () => buildPaymentInWorker({ ...options, utxos: verified,
        parents: [...parents].map(([txid, hex]) => ({ txid, hex })),
        mnemonic: this.session.data.mnemonic, passphrase: this.session.data.passphrase,
      }, { signal: preparation.signal });
      stage = 'signing';
      progress(completed, selected.length);
      // Validate funding/fees/domain before opening a connection. No wallet keys
      // or transaction bytes are ever passed to the isolated capability helper.
      let payment = await build(), policy = {};
      check();
      if (domain !== undefined) {
        stage = 'proof';
        progress(completed, selected.length);
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
        if (rsaVerified) { stage = 'signing'; progress(completed, selected.length); payment = await build(); }
        const status = rsaVerified ? 'verified' : ['unavailable', 'timeout', 'busy'].includes(result?.status) ? result.status : 'failed';
        policy = { signatureAlgorithmsMask: output.mask, rsaProbeStatus: status, expectedConnections: String(expectedConnections ?? '1') };
      }
      check();
      // The selected mask and signed bytes are frozen together for confirmation.
      const received = formatCoinAmount(BigInt(payment.total));
      const changeAdjustment = subtractFeeFromAmount ? formatCoinAmount(value - BigInt(payment.total) - BigInt(payment.fee)) : '0';
      const selectedOutpoints = new Set(payment.selected.map(row => `${row.txid}:${row.vout}`));
      const replacingTxids = Object.freeze([...new Set(selected.filter(row => selectedOutpoints.has(`${row.txid}:${row.vout}`) && row.pending_spent_by).map(row => row.pending_spent_by))]);
      this.preview = Object.freeze({ ...payment, ...policy, ...details, replacingTxids, previewId: randomUUID(), epoch, expires: Date.now() + 120000, address: domain === undefined ? address : output.domain, amount: received, requestedAmount: formatCoinAmount(value), changeAdjustment, changeIndex: change.index });
      this.recordDiagnostic('payment.prepared', { stage, inputCount: payment.selected.length, durationMs: performance.now() - started });
      return { previewId: this.preview.previewId, address: this.preview.address, amount: received, requestedAmount: formatCoinAmount(value), subtractFeeFromAmount, changeAdjustment, replacingTxids: [...replacingTxids], fee: formatCoinAmount(BigInt(payment.fee)), total: formatCoinAmount(BigInt(payment.total) + BigInt(payment.fee)), txid: payment.txid, type: domain === undefined ? 'payment' : 'p2c', ...policy, ...details };
    } catch (error) {
      const cancelled = error?.name === 'AbortError';
      this.recordDiagnostic(cancelled ? 'payment.prepare_cancelled' : 'payment.prepare_failed', { stage, ...(!cancelled ? { error } : {}), durationMs: performance.now() - started });
      throw error;
    } finally {
      preparation.abort();
      if (this.sendPreparation === preparation) {
        this.sendPreparation = null;
        this.paymentPreparation = null;
        this.emitState();
      }
    }
  }
  async confirmSend({ previewId } = {}) {
    const preview = this.preview; this.preview = null;
    if (!preview || preview.previewId !== previewId || preview.expires < Date.now()) throw new Error('Payment review expired. Review the payment again.');
    this.assertSession(preview.epoch);
    const confirmation = new AbortController(), rpc = this.rpc;
    this.sendConfirmation = confirmation;
    const check = () => {
      this.assertSession(preview.epoch);
      if (confirmation.signal.aborted || this.sendConfirmation !== confirmation || this.rpc !== rpc) {
        throw Object.assign(new Error('Payment confirmation cancelled. Review the payment again. No transaction was sent.'), { name: 'AbortError' });
      }
    };
    try {
      await waitForReview(this.ensureNetwork({ signal: confirmation.signal }), confirmation.signal); check();
      // Save the review's local notes and change path BEFORE broadcast. A timeout,
      // lock or lost reply must not discard metadata for a submitted transaction.
      const session = this.session, previousChangeIndex = session.data.changeIndex, previousDetails = session.data.paymentDetails;
      const hasDetails = Boolean(preview.label || preview.message);
      let nextChangeIndex = previousChangeIndex;
      if (BigInt(preview.change) > 0n) {
        if (this.session.data.changeIndex >= MAX_ADDRESS_INDEX) throw new Error('The BIP32 change-address index range is exhausted.');
        if (this.session.data.changeIndex >= (this.session.data.lastUsedChange ?? -1) + ADDRESS_GAP) throw new Error('Too many unused change addresses. Wait for pending payments to appear before sending again.');
        nextChangeIndex = Math.max(previousChangeIndex, preview.changeIndex + 1);
      }
      const nextDetails = hasDetails ? { ...previousDetails, [preview.txid]: { label: preview.label, message: preview.message } } : previousDetails;
      if (hasDetails && Buffer.byteLength(JSON.stringify({ ...session.data, changeIndex: nextChangeIndex, paymentDetails: nextDetails }), 'utf8') > WALLET_PLAINTEXT_LIMIT - PAYMENT_DETAILS_HEADROOM) {
        throw new Error('Local payment details storage is full. Clear Label and Message and review again to send without saving new details. No transaction was sent.');
      }
      if (nextChangeIndex !== previousChangeIndex || hasDetails) {
        session.data.changeIndex = nextChangeIndex;
        if (hasDetails) session.data.paymentDetails = nextDetails;
        try { await this.persist(); }
        catch (error) {
          if (this.session === session) {
            session.data.changeIndex = previousChangeIndex;
            if (previousDetails === undefined) delete session.data.paymentDetails;
            else session.data.paymentDetails = previousDetails;
          }
          throw error;
        }
        check();
        if (nextChangeIndex !== previousChangeIndex) { await this.buildAccounts(); check(); }
      }
      check();
      // Keep cancellation active through RPC quota/connection waits. RpcClient
      // stops honoring an individual abort once bytes have been handed to the
      // socket, preserving the actual reply or uncertain broadcast outcome.
      const newlyReserved = preview.selected.map(input => `${input.txid}:${input.vout}`).filter(outpoint => !this.reserved.has(outpoint));
      for (const outpoint of newlyReserved) this.reserved.add(outpoint);
      try {
        const result = await rpc.request('sendrawtransaction', { transaction_hex: preview.hex }, { signal: confirmation.signal });
        if (result?.txid !== preview.txid) throw new Error('RPC returned an unexpected transaction ID.');
        if (this.session) void this.refresh(REFRESH_WITHOUT_SNAPSHOT).catch(() => {});
        return { txid: preview.txid, status: 'submitted' };
      } catch (error) {
        // Only the local transport's explicit pre-transmission cancellation is
        // proof that no bytes were sent. Never release inputs on a lost reply.
        if (error?.name === 'AbortError' && error.notSent === true && !error.unknownOutcome) {
          if (this.epoch === preview.epoch && this.rpc === rpc) {
            // A cancelled replacement must preserve reservations belonging to
            // its original payment, including an earlier uncertain broadcast.
            for (const outpoint of newlyReserved) this.reserved.delete(outpoint);
          }
          throw Object.assign(new Error('Payment confirmation cancelled. Review the payment again. No transaction was sent.'), { name: 'AbortError' });
        }
        throw Object.assign(new Error(`Broadcast was not confirmed. Check transaction ${preview.txid} before trying again; selected inputs remain reserved until the wallet is reopened.`), { unknownOutcome: true, txid: preview.txid });
      }
    } finally {
      if (this.sendConfirmation === confirmation) this.sendConfirmation = null;
    }
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
      rpc: { ...previous.rpc, ...input.rpc }, claims: { ...previous.claims, ...input.claims } }, this.configOptions);
    if (this.claimsReviewRequired) config.claims.enabled = false;
    const reconnect = config.rpc.host !== previous.rpc.host || config.rpc.port !== previous.rpc.port;
    const claimsChanged = Object.keys(config.claims).some(key => config.claims[key] !== previous.claims[key]);
    // Preferences are durable even if locked, offline, or the helper is absent.
    // A failed disk write must not stop workers or switch to an unsaved server.
    this.config = await writeConfig(this.directory, config, this.configOptions);
    if (this.closed) return this.getState();
    if (reconnect || claimsChanged || retryClaims) {
      this.claimsResumePending = false;
      const generation = ++this.claimToggleGeneration;
      const context = { epoch: this.epoch, rpc: this.rpc, engine: this.engine, session: this.session };
      // Resolve the old transport's sent/not-sent outcome before changing its
      // epoch. In particular, cancellation during quota owns no broadcast and
      // must release that reservation while its original context is current.
      await this.engine.stop();
      if (this.closed || context.epoch !== this.epoch || context.rpc !== this.rpc || context.engine !== this.engine || context.session !== this.session ||
          generation !== this.claimToggleGeneration && !this.claimsReviewRequired) return this.getState();
      if (reconnect) {
        this.cancelSendPreview(); this.epoch++; this.replacement = null; this.setup = null;
        this.rpc?.close(); this.refreshing = null;
        this.claimBlocks = new Map(); this.claimCursor = null; this.claimWindow = null;
        this.retiredClaims.clear(); this.clearFundingCache(); this.fundingPending.clear();
        this.connectClient();
        // Retain verified winners and ACK witnesses across an endpoint edit.
        // Unverified proposals must prepare again against the new backend.
        for (const [key, job] of this.engine.queue) if (!this.engine.pendingProofs.has(key)) {
          job.prepared = undefined; this.engine.proposals.delete(key);
        }
        for (const accepted of this.engine.acceptedProofs?.values() ?? []) accepted.due = 0;
        if (this.session) {
          this.liveUpdates.start();
          void this.refresh(REFRESH_WITHOUT_SNAPSHOT).catch(() => {});
        }
      }
      // A lock/new unlock may have started a newer lifecycle while the old
      // helper was draining. That lifecycle reads the already-saved config.
      if (this.closed || generation !== this.claimToggleGeneration) return this.getState();
      this.engine.setOptions({ connectionsPerSecond: config.claims.maxConnectionsPerSecond, concurrency: config.claims.maxConcurrent });
      // Auto-lock, appearance and diagnostics do not interrupt network activity.
      if (this.session && !this.closed && config.claims.enabled) await this.resumeClaims();
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
        this.error = error.message;
        if (!this.claimCatalogGate) void engine.stop();
        this.emitState();
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
        // Admission is already closed by onReset. Do not reread the old backlog
        // on the next bounded retry or expose an intermediate journal cursor.
        if (error instanceof BountyDiscoveryBusy) this.claimCursor = null;
        // Cancelled consumers can leave shared funding reads draining behind
        // the transport's bounded queue. Its local capacity refusal is not a
        // malformed catalog and must retry once capacity becomes available.
        const transientRead = error instanceof BountyDiscoveryBusy || error?.code === 'RPC_QUEUE_FULL' || [-32001, -32011, -32029, -32030].includes(error?.code);
        if (this.claimCatalogGate && transientRead && !error.unknownOutcome && !rpc.socket?.destroyed) {
          // Read-only backend/rate-limit failures do not invalidate completed
          // cryptographic work. Keep admission and writes gated until a complete
          // retry publishes; the event queue provides bounded backoff.
          this.claimsResumePending = false;
          this.bountyUpdates?.request();
        } else {
          this.claimsResumePending = transientRead || !rpc.socket || rpc.socket.destroyed;
          // Malformed catalogs and connection/lifecycle loss remain fail-closed.
          void engine.stop(); this.releaseClaimCatalog();
          // An initial/manual read may not belong to EventRefresh yet. Keep a
          // retry queued without depending on another block or notification.
          if (this.claimsResumePending) this.bountyUpdates?.request();
        }
      }
      throw error;
    }).finally(() => {
      if (this.bountySync === pending) {
        this.bountySync = null; this.scanningBounties = false; this.emitState();
      }
    });
    this.bountySync = pending; return pending;
  }
  invalidateClaim(key, ownPendingTxid = null) {
    const accepted = this.engine.acceptedProofs?.get(key);
    if (accepted && accepted.txid !== ownPendingTxid) accepted.invalidated = true;
    // A first broadcast may not own an accepted record until its ACK arrives.
    // Keep catalog evidence on that bounded in-flight job in the meantime.
    for (const job of this.engine.submitting) if (bountyKey(job.bounty) === key && job.prepared?.txid !== ownPendingTxid) {
      job.retainedInvalidated = true;
    }
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
      previous: this.claimBlocks, previousWindow: this.claimWindow, cursor: this.claimCursor, check,
      capabilities: this.bountyCapabilities,
      onInvalidate: (row, reason) => {
        if (reason === 'pending_spend' || reason === undefined && row.status === 'pending_spend') engine.preservePendingWinner(bountyKey(row));
        if (reason !== 'window_exit') this.invalidateClaim(bountyKey(row),
          reason === 'pending_spend' || row.status === 'pending_spend' ? row.spending_txid : null);
        if (reason === 'window_exit') engine.retire(row.txid, row.vout);
        else engine.remove(row.txid, row.vout);
      },
      onWindow: snapshot => {
        // A retained in-flight row is no longer in the discovery block cache.
        // Still cancel it if a subsequent window reveals its block was replaced.
        const canonical = new Map(snapshot.blocks.map(block => [block.height, block.hash]));
        for (const key of new Set([...engine.activeKeys(), ...engine.pendingProofs?.keys() ?? [], ...engine.acceptedProofs?.keys() ?? []])) {
          const accepted = engine.acceptedProofs?.get(key);
          const row = this.claimOutpoints?.get(key) ?? accepted?.bounty;
          if (!row) continue;
          const blockHash = canonical.get(row.block_height);
          if (row.block_height > snapshot.tip.height || (blockHash && blockHash !== row.block_hash)) {
            this.invalidateClaim(key);
            engine.remove(row.txid, row.vout);
          }
        }
      },
      onReset: ({ reason }) => { check(); this.blockClaimCatalog(reason); },
      readBlock: (hash, options) => this.blockBounties(hash, { ...options, rpc, epoch }),
    });
    check();
    const available = [], outpoints = new Map();
    // An outpoint's program/value are immutable, even across a catalog reset.
    // Validate the complete replacement before applying removals or publishing.
    for (const rows of result.blocks.values()) for (const row of rows) {
      const previous = this.claimOutpoints?.get(bountyKey(row)) ?? engine.acceptedProofs?.get(bountyKey(row))?.bounty;
      if (previous && ['domain', 'amount', 'connection_work_target', 'root_certificates_version', 'signature_algorithms_mask', 'coinbase']
        .some(field => previous[field] !== row[field])) throw new Error('Bounty metadata changed for an existing outpoint.');
    }
    // Confirmation permits witness compaction, not an eternal reservation.
    // Only a coherent replacement can establish that its confirming block was
    // removed. A block merely aging outside this bounded window proves nothing.
    const canonical = new Map(result.window.blocks.map(block => [block.height, block.hash]));
    for (const confirmation of this.#claimConfirmations.values()) {
      const hash = canonical.get(confirmation.height);
      if (confirmation.height > result.tip.height || hash && hash !== confirmation.hash) confirmation.orphaned = true;
      else if (hash === confirmation.hash) confirmation.orphaned = false;
    }
    for (const rows of result.blocks.values()) for (const row of rows) {
      const key = bountyKey(row); outpoints.set(key, row);
      if (row.status === 'pending_spend') engine.preservePendingWinner(key);
      const accepted = engine.acceptedProofs?.get(key);
      if (accepted) {
        accepted.invalidated = row.status !== 'available' && !(row.status === 'pending_spend' && row.spending_txid === accepted.txid);
        accepted.bounty = { ...row, status: 'available', spending_txid: null };
      }
      // Only a fully validated replacement may clear earlier invalidation,
      // including available_again while the original ACK is still pending.
      for (const job of engine.submitting) if (bountyKey(job.bounty) === key) {
        job.retainedInvalidated = row.status !== 'available' && !(row.status === 'pending_spend' && row.spending_txid === job.prepared?.txid);
        // Funding may have been mined again in another block while the reply
        // was in flight. Keep discovery metadata separate from signed bytes.
        job.retainedBounty = { ...row, status: 'available', spending_txid: null };
      }
      if (row.status === 'available' && row.root_certificates_version === 1) {
        const confirmation = this.#claimConfirmations.get(key);
        if (confirmation?.orphaned && !confirmation.reopened && !accepted && !engine.hasActive(key) && !engine.pendingProofs.has(key)) {
          // The old proof was already compacted after confirmation. Permit a
          // fresh capture, retaining only the txid's once-counted ACK marker.
          this.reserved.delete(key); engine.completed.delete(key); confirmation.reopened = true;
        }
        this.retiredClaims.delete(key); engine.restoreAvailable(row);
        if (!this.reserved.has(key)) available.push(row);
        // An automatic submission reserves its own outpoint before waiting for
        // RPC quota/capacity. That local lock is not evidence of an unavailable
        // bounty: keep its verified winner, but never admit duplicate work.
        else if (!(engine.queue.get(key)?.submitting && engine.pendingProofs.has(key))) engine.remove(row.txid, row.vout);
      } else engine.remove(row.txid, row.vout);
    }
    // Only already-running, normally aged-out work can outlive discovery.
    // Preserve each outpoint until all its captures/submission have settled.
    // A reset reloads block streams from an empty cache, so its discovery pass
    // cannot emit window_exit for the former oldest block. Preserve admitted
    // work by age after the coherent replacement; known reorg/spend events have
    // already removed its job. A gap over 600 blocks is not evidence of a reorg.
    // This retained metadata does not assert current unspentness: the original
    // proof binds the outpoint/program, and Core validates it on submission.
    const normallyAged = row => row.status === 'available' && row.block_height < result.tip.height - this.config.claims.lookbackBlocks + 1;
    for (const [key, row] of this.claimOutpoints ?? []) if (!outpoints.has(key)) {
      if ((engine.hasActive(key) || engine.pendingProofs?.has(key)) && engine.queue.has(key) && normallyAged(row)) engine.retire(row.txid, row.vout);
      if ((engine.hasActive(key) || engine.pendingProofs?.has(key)) && engine.queue.get(key)?.retired) {
        outpoints.set(key, row); this.retiredClaims.set(key, row);
      } else engine.remove(row.txid, row.vout);
    }
    // Hashes, bounty rows and cursor are one committed discovery snapshot.
    // A failed/cancelled cycle must never publish its intermediate prefix.
    check(); this.claimBlocks = result.blocks; this.claimOutpoints = outpoints; this.claimCursor = result.cursor; this.claimWindow = result.window;
    this.tip = validateTip(result.tip, this.config.network);
    engine.retainCatalog(outpoints.values(), { oldestHeight: Math.max(0, result.tip.height - this.config.claims.lookbackBlocks + 1) });
    engine.enqueue(available);
    check(); this.releaseClaimCatalog(); engine.resume();
    await this.reconcileAcceptedClaims(check);
  }
  scheduleClaimReceipts() {
    if (this.closed || !this.session || !this.engine.enabled || !this.engine.acceptedProofs?.size) {
      clearTimeout(this.claimReceiptTimer); this.claimReceiptTimer = null; return;
    }
    if (this.claimReceiptTimer) return;
    const due = Math.max(this.claimReceiptNext ?? 0, Math.min(...[...this.engine.acceptedProofs.values()].map(record => record.due)));
    this.claimReceiptTimer = setTimeout(() => {
      this.claimReceiptTimer = null;
      if (!this.closed && this.session && this.engine.enabled) this.bountyUpdates?.request();
    }, Math.max(1000, due - Date.now()));
    this.claimReceiptTimer.unref?.();
  }
  async reconcileAcceptedClaims(check) {
    const engine = this.engine;
    if (!engine.acceptedProofs?.size) return;
    if ((this.claimReceiptNext ?? 0) > Date.now()) { this.scheduleClaimReceipts(); return; }
    const due = [...engine.acceptedProofs].filter(([, record]) => record.due <= Date.now()).sort((a, b) => a[1].due - b[1].due).slice(0, 4);
    if (due.length) this.claimReceiptNext = Date.now() + 15000;
    // Bounded read work shares the ordinary RPC quotas. A failed receipt query
    // never erases a winner or changes catalog availability.
    for (const [key, record] of due) {
      check(); record.due = Date.now() + 30000;
      try {
        const response = await this.readClaimReceipt(record, check); check();
        // A replay may have received a newer ACK while this read was queued.
        // Its older missing/pending result cannot reopen that new acceptance,
        // release its reservation or compact its replacement witness owner.
        if (engine.acceptedProofs.get(key) !== record) continue;
        if (response.status === 'confirmed') {
          if (!Number.isSafeInteger(response.block_height) || response.block_height < 0 || response.block_height > response.tip.height ||
              typeof response.block_hash !== 'string' || !HASH.test(response.block_hash) ||
              response.block_height === 0 && response.block_hash !== response.tip.genesis_hash ||
              response.block_height === response.tip.height && response.block_hash !== response.tip.hash ||
              response.transaction?.blockhash !== undefined && response.transaction.blockhash !== response.block_hash ||
              response.transaction?.confirmations !== undefined && (!Number.isSafeInteger(response.transaction.confirmations) || response.transaction.confirmations <= 0)) throw new Error('Invalid confirmed claim receipt.');
          // Receipt indexing can advance before discovery. Keep the witness
          // until our coherent window catches up, otherwise its merely lower
          // cached tip could be mistaken for a later rollback of this block.
          if (!this.claimWindow || response.block_height > this.claimWindow.tip.height) throw new Error('Claim confirmation awaits a current validated discovery window.');
          const canonical = this.claimWindow?.blocks?.find(block => block.height === response.block_height);
          if (canonical && canonical.hash !== response.block_hash) throw new Error('Claim receipt conflicts with the validated chain window.');
          if (!this.#claimConfirmations.has(key) && this.#claimConfirmations.size >= engine.maxQueue ||
              !this.#countedClaimConfirmations.has(record.txid) && this.#countedClaimConfirmations.size >= engine.maxQueue) {
            throw new Error('Confirmed claim history reached its bounded capacity; retaining the existing proof.');
          }
          this.#claimConfirmations.delete(key);
          this.#claimConfirmations.set(key, { txid: record.txid, height: response.block_height, hash: response.block_hash,
            orphaned: false, reopened: false });
          // Compact metadata follows the existing bounded completed history;
          // capacity exhaustion retains the existing proof rather than evicting
          // the only reorg/count-once marker for an older transaction.
          this.#confirmedClaims.add(record.prepared);
          for (const active of engine.submitting) if (bountyKey(active.bounty) === key && active.prepared?.txid === record.txid) this.#confirmedClaims.add(active.prepared);
          this.reserved.add(key);
          const job = engine.queue.get(key);
          engine.confirmAccepted(key, record);
          // One outpoint can alternate between several transaction IDs across
          // reorgs/fee changes. Keep count-once history independent of its most
          // recent confirmation marker, within the same bounded session budget.
          this.#countedClaimConfirmations.add(record.txid);
          if (job?.prepared?.txid === record.txid) {
            this.#confirmedClaims.add(job.prepared);
            engine.remove(job.bounty.txid, job.bounty.vout);
          }
        } else if (response.status !== 'pending') throw new Error('Invalid claim receipt state.');
      } catch (error) {
        check();
        if (engine.acceptedProofs.get(key) !== record) continue;
        if (error.code === -32004 && !error.unknownOutcome) {
          let row = this.claimOutpoints?.get(key);
          const aged = !row && !record.invalidated && record.bounty.block_height < this.tip.height - this.config.claims.lookbackBlocks + 1;
          if (aged) row = record.bounty;
          if (row?.status === 'available' && !record.invalidated && engine.reopenAccepted(key, row)) {
            this.reserved.delete(key);
            if (aged) {
              this.claimOutpoints.set(key, row); this.retiredClaims.set(key, row);
              engine.queue.get(key).retired = true;
            }
          }
        }
      }
    }
    clearTimeout(this.claimReceiptTimer); this.claimReceiptTimer = null; this.scheduleClaimReceipts();
  }
  async readClaimReceipt(record, check) {
    check();
    // The original verified proof stays local. A receipt describes the same
    // input/payout (txid), not a replacement witness supplied by the server.
    const signed = attachClaimProof(record.prepared, record.pending.proof);
    const saved = this.#signedClaims.get(record.prepared);
    if (signed.txid !== record.txid || saved &&
        (saved.proof !== record.pending.proof || saved.signed.hex !== signed.hex || saved.signed.txid !== signed.txid)) {
      throw new Error('Preserved claim transaction or proof changed before reconciliation.');
    }
    const rpc = this.rpc, capabilities = this.bountyCapabilities;
    const checkOwner = () => {
      check();
      if (this.rpc !== rpc || this.bountyCapabilities !== capabilities ||
          attachClaimProof(record.prepared, record.pending.proof).hex !== signed.hex) {
        throw new Error('Claim receipt context or preserved proof changed during reconciliation.');
      }
    };
    if (capabilities.claimStatus !== false) {
      let result, unsupported = false;
      try { result = await rpc.request('gettransactionstatus', { txid: record.txid }); }
      catch (error) {
        if (error.code !== -32601) throw error;
        checkOwner(); capabilities.claimStatus = false; unsupported = true;
      }
      checkOwner();
      if (!unsupported) {
        validateIndexedClaimStatus(result, record.txid, this.config.network, this.claimWindow);
        return result;
      }
    }
    // Legacy servers explicitly lacking the status method keep their full
    // receipt validation. Successful malformed status replies never get here.
    const response = this.checkResponse(await rpc.request('gettransaction', { txid: record.txid })); checkOwner();
    const raw = response.transaction?.hex;
    if (transactionIdFromRaw(raw) !== record.txid || response.transaction.txid !== undefined && response.transaction.txid !== record.txid) {
      throw new Error('Claim receipt transaction does not match its preserved identity.');
    }
    const observed = parseTransaction(raw);
    if (observed.inputs.length !== 1 || observed.inputs[0].witness.length !== 1 ||
        attachClaimProof(record.prepared, observed.inputs[0].witness[0]).hex !== raw) {
      throw new Error('Claim receipt witness is not bound to its preserved proposal.');
    }
    return response;
  }
  blockClaimCatalog(catalogReason = 'notification-reset') {
    if (!this.claimCatalogGate) {
      this.claimCatalogGate = { ...Promise.withResolvers(), started: performance.now(), catalogReason };
      this.recordDiagnostic('claims.catalog_blocked', { stage: 'discovery', catalogReason, preparedCapturesAllowed: true });
    }
    // Catalog uncertainty blocks preparation and submission, not cryptographic
    // work on already authenticated proposals. A winner waits for the complete
    // replacement snapshot; known spends/reorgs still invalidate its job.
    this.engine?.setCatalogBlocked?.(true, { allowPreparedCaptures: true });
  }
  releaseClaimCatalog() {
    const gate = this.claimCatalogGate; this.claimCatalogGate = null;
    gate?.resolve(); this.engine?.setCatalogBlocked?.(false);
    if (gate) this.recordDiagnostic('claims.catalog_released', { stage: 'discovery', catalogReason: gate.catalogReason,
      durationMs: Math.round(performance.now() - gate.started) });
  }
  async waitForClaimCatalog(check, signal) {
    const cancelled = () => Object.assign(new Error('Automatic Claims preparation or submission cancelled.'), { name: 'AbortError', code: 'ABORT_ERR', notSent: true });
    check(); if (signal?.aborted) throw cancelled();
    while (this.claimCatalogGate) {
      const gate = this.claimCatalogGate;
      await new Promise((resolve, reject) => {
        const abort = () => { signal?.removeEventListener('abort', abort); reject(cancelled()); };
        gate.promise.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      });
      check(); if (signal?.aborted) throw cancelled();
    }
  }
  async prepareAutomaticClaim(bounty, { signal, previous } = {}) {
    this.assertSession();
    const epoch = this.epoch, rpc = this.rpc, engine = this.engine, generation = this.#fundingGeneration;
    const check = () => {
      this.assertSession(epoch);
      if (signal?.aborted || !engine.enabled || this.engine !== engine || this.rpc !== rpc || generation !== this.#fundingGeneration) throw Object.assign(new Error('Automatic Claims stopped.'), { name: 'AbortError' });
    };
    await this.waitForClaimCatalog(check, signal);
    const current = this.claimOutpoints?.get(bountyKey(bounty));
    if (!current || current.status !== 'available' || this.reserved.has(bountyKey(current))) throw new Error('This bounty is no longer eligible for claiming.');
    validateTip(this.tip, this.config.network);
    this.requireClaimDiscovery(current);
    // The validated tip is refreshed by wallet/discovery sync, not twice per
    // claim. MTP is a certificate-checking reference, not a bounty expiry rule.
    const rawTransaction = await this.funding(current.txid, { signal });
    await this.waitForClaimCatalog(check, signal);
    const tip = validateTip(this.tip, this.config.network);
    if (this.claimOutpoints?.get(bountyKey(current))?.status !== 'available') throw new Error('Bounty availability changed while preparing its claim.');
    this.requireClaimDiscovery(this.claimOutpoints.get(bountyKey(current)));
    // Preserve the fixed challenge and actual payout on retries, as Core does.
    // Reauthenticate funding and availability each time; never reuse a proposal
    // across a wallet/security epoch or RPC connection change.
    const reusable = previous?.epoch === epoch && previous.rpc === rpc && bountyKey(previous.bounty) === bountyKey(current);
    const rewardAddress = reusable ? previous.rewardAddress : this.getState().wallet.address;
    const cachedContext = this.#claimFundingContext;
    if (!cachedContext || cachedContext.epoch !== epoch || cachedContext.rpc !== rpc || cachedContext.walletGeneration !== this.walletGeneration) {
      this.#claimFunding.clear();
      this.#claimFundingContext = { epoch, rpc, walletGeneration: this.walletGeneration };
    }
    // Only exact immutable parent bytes are memoized. Every output, payout,
    // availability and epoch check remains fresh. Payment signing keeps its
    // independent worker validation and never moves curve work onto the UI.
    const prepared = this.#claimFunding.prepareClaim({ bounty: current, rawTransaction, rewardAddress, fee: reusable ? previous.fee : estimateClaimFee(this.config.feeRate), network: this.config.network });
    check();
    return { ...prepared, epoch, rpc, walletGeneration: this.walletGeneration, rewardAddress,
      acceptanceCounted: this.#countedClaimConfirmations.has(prepared.txid), context: {
      domain: prepared.bounty.domain, txid: prepared.txid, input_index: 0,
      connection_work_target: prepared.bounty.target, root_certificates_version: prepared.bounty.rootVersion,
      signature_algorithms_mask: prepared.bounty.mask, validation_time: tip.mediantime,
    } };
  }
  async submitAutomaticClaim(prepared, proof, { signal } = {}) {
    const engine = this.engine;
    const retainedKey = bountyKey(prepared.bounty);
    if (prepared.epoch !== this.epoch || prepared.rpc !== this.rpc || engine.queue?.get(retainedKey)?.revalidateClaim) {
      this.assertSession();
      const epoch = this.epoch, rpc = this.rpc, walletGeneration = this.walletGeneration;
      const stale = () => signal?.aborted || !this.session || this.epoch !== epoch || this.rpc !== rpc || this.engine !== engine || !engine.enabled;
      const ownsReward = prepared.rewardAddress === this.getState().wallet.address || this.accounts.some(account => account.address === prepared.rewardAddress);
      if (prepared.walletGeneration !== walletGeneration || !ownsReward || stale()) {
        throw Object.assign(new Error('Retained claim belongs to another wallet context.'), { name: 'AbortError', notSent: true });
      }
      await this.waitForClaimCatalog(() => {
        if (stale()) throw Object.assign(new Error('Claim context changed before revalidation.'), { name: 'AbortError', notSent: true });
      }, signal);
      const key = bountyKey(prepared.bounty), row = this.claimOutpoints?.get(key);
      if (!row || row.status !== 'available') throw new Error('This bounty is no longer eligible for claiming.');
      const rawTransaction = await this.funding(row.txid, { signal });
      if (stale()) throw Object.assign(new Error('Claim context changed during revalidation.'), { name: 'AbortError', notSent: true });
      const checked = this.#claimFunding.prepareClaim({ bounty: row, rawTransaction, rewardAddress: prepared.rewardAddress,
        fee: prepared.fee, network: this.config.network });
      if (checked.hex !== prepared.hex || checked.txid !== prepared.txid || checked.challenge !== prepared.challenge) throw new Error('Retained claim changed during endpoint revalidation.');
      const previous = prepared;
      prepared = { ...prepared, epoch, rpc };
      const signed = this.#signedClaims.get(previous);
      if (signed) this.#signedClaims.set(prepared, signed);
      engine.proposals.set(key, prepared);
      const job = engine.queue.get(key); if (job?.prepared === previous) { job.prepared = prepared; job.revalidateClaim = false; }
    }
    const check = () => {
      this.assertSession(prepared.epoch);
      if (signal?.aborted || !engine.enabled || this.engine !== engine || this.rpc !== prepared.rpc) throw Object.assign(new Error('Automatic Claims stopped.'), { name: 'AbortError' });
    };
    await this.waitForClaimCatalog(check, signal);
    const key = bountyKey(prepared.bounty), current = this.claimOutpoints?.get(key);
    if (!current || current.status !== 'available' || this.reserved.has(key)) throw new Error('This bounty is no longer eligible for claiming.');
    // Normal discovery-window aging does not expire a bounty. A retained row
    // authenticates the original proposal; it is not a fresh unspentness claim.
    // The node rechecks the input and full proof when receiving the transaction.
    const checked = attachClaimProof(prepared, proof); check();
    // Revalidate framing/challenge/work on every retry, but resend exactly the
    // first verified witness bytes, never a replacement transaction. Weak keys
    // release this public payload when its retained proposal is discarded.
    let saved = this.#signedClaims.get(prepared);
    if (saved && (saved.proof !== proof || saved.signed.hex !== checked.hex || saved.signed.txid !== checked.txid)) {
      throw new Error('A retained claim transaction or proof was changed before retrying.');
    }
    if (!saved) {
      saved = Object.freeze({ proof, signed: Object.freeze({ hex: checked.hex, txid: checked.txid }) });
      this.#signedClaims.set(prepared, saved);
    }
    const signed = saved.signed;
    this.reserved.add(key);
    try {
      const result = await prepared.rpc.request('sendrawtransaction', { transaction_hex: signed.hex }, {
        signal, beforeSend: () => {
          check();
          if (this.claimCatalogGate) throw Object.assign(new Error('Bounty catalog is being resynchronized.'), { name: 'AbortError', code: 'ABORT_ERR', notSent: true });
          const latest = this.claimOutpoints?.get(key);
          if (!latest || latest.status !== 'available') throw new Error('Bounty availability changed before submitting its claim.');
        },
      });
      if (result?.txid !== signed.txid) throw new Error('RPC returned an unexpected claim transaction ID.');
      // Endpoint revalidation may have replaced the proposal object. Retention
      // follows that effective owner, not the caller's stale pre-reconnect one:
      // a confirmation received while awaiting the ACK already compacted it.
      return { txid: signed.txid, retainProof: !this.#confirmedClaims.has(prepared) };
    } catch (error) {
      // A receipt read can confirm this exact transaction while its earlier
      // written request is still waiting for a reply. That stronger outcome
      // must not be downgraded by a late rejection/timeout, re-create a saved
      // winner or stop unrelated claims as an indeterminate broadcast.
      if (this.#confirmedClaims.has(prepared)) return { txid: signed.txid, retainProof: false };
      if (error?.notSent === true && !error.unknownOutcome) {
        // The transport proves no bytes were submitted. STOP during pacing or
        // connection setup must neither reserve an unspent bounty indefinitely
        // nor report an uncertain broadcast. Sent requests keep their outcome.
        if (!this.#confirmedClaims.has(prepared) && this.epoch === prepared.epoch && this.rpc === prepared.rpc) this.reserved.delete(key);
        throw error;
      }
      if (error.notForwarded === true && !error.unknownOutcome && !error.helperFatal &&
          [-32001, -32029, -32030].includes(error.code)) {
        // These explicit RPC errors are emitted before forwarding to Core:
        // network readiness, rate quota and server capacity respectively. The
        // RPC request was sent, but the claim was not submitted. Retain the
        // verified winner for the engine's bounded retry, not a new capture.
        // -32002 is deliberately excluded: it can also follow an uncertain write.
        if (!this.#confirmedClaims.has(prepared) && this.epoch === prepared.epoch && this.rpc === prepared.rpc) this.reserved.delete(key);
        const retryAfterMs = Number.isSafeInteger(error.data?.retry_after_ms) && error.data.retry_after_ms > 0
          ? error.data.retry_after_ms : 0;
        throw Object.assign(new Error('RPC temporarily refused this claim before submission; its verified proof will be retried.'), {
          code: error.code, retryAfterMs,
        });
      }
      if (isKnownClaimRejection(error)) {
        if (!this.#confirmedClaims.has(prepared) && this.epoch === prepared.epoch && this.rpc === prepared.rpc) this.reserved.delete(key);
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
  claimDiscoveryCurrent(row) {
    return Boolean(row && row.status === 'available' && this.tip && row.block_height > this.tip.height - 600 &&
      !this.retiredClaims.has(bountyKey(row)) && !this.engine?.queue?.get(bountyKey(row))?.retired);
  }
  requireClaimDiscovery(row) {
    // Only admission of new capture work depends on discovery membership.
    // Already-started work and verified retained winners may finish after aging.
    if (!this.claimDiscoveryCurrent(row)) throw Object.assign(new Error('This bounty is outside the discovery window; no new capture will be started.'),
      { name: 'AbortError', code: 'ABORT_ERR', notSent: true });
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    const refreshing = this.refreshing;
    const liveWork = [this.liveUpdates?.running, this.walletUpdates?.running, this.bountyUpdates?.running, this.tipUpdates?.running, this.bountySync].filter(Boolean);
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
