import { Capacitor, registerPlugin } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import QRCode from 'qrcode';
import icon from '../../assets/icon-512.png';
import { installAmountInputRestrictions } from '../../src/ui/amount-input.mjs';
import { installTextInputRestrictions } from '../../src/ui/text-input.mjs';
import { parseClipboardPaymentText } from '../../src/core/payment-uri.mjs';
import { formatConn, parseMainnetAddress } from './model.mjs';
import { createReceiveRequest, RECEIVE_METADATA_NOTICE } from './receive-request.mjs';
import { parsePaymentIntake } from './payment-intake.mjs';
import { createP2CRequest } from './p2c-request.mjs';
import { availableSendAmount, createSendRequest } from './send-request.mjs';
import { DEFAULT_CLAIMS_POLICY, DEFAULT_CLAIMS_LIMITS, evaluateClaimsPolicy, parseClaimsLimits } from './claims-policy.mjs';
import { HdWalletSession, nativeHdAccounts } from './hd-session.mjs';
import { hdRecoveryStatus } from './hd-recovery-status.mjs';
import { LiveBalance } from './live-balance.mjs';
import { nativeActionState, nativeControlState } from './native-controls.mjs';
import { paymentProgressText } from './payment-progress.mjs';
import { parsePaymentBatch, parsePaymentBatchResponse, parsePaymentBatchDismissal, paymentBatchTotals } from './payment-batch.mjs';
import { claimsErrorText } from './claims-diagnostics.mjs';
import { createTransactionDetails } from './transaction-details.mjs';
import { DEFAULT_SETTINGS, parseSettings, rpcEndpoint, resolvedTheme } from './settings.mjs';
import { nativeCapabilities } from './platform.mjs';
import './styles.css';

const $ = id => document.getElementById(id);
const platform = Capacitor.getPlatform();
const capabilities = nativeCapabilities(platform);
const native = capabilities.wallet;
const wallet = registerPlugin('NativeWallet');
const paymentInput = registerPlugin('NativePaymentInput');
const explorer = registerPlugin('NativeExplorer');
let environment = { active: true, connected: false, connectionType: 'unknown' };
let policy = { ...DEFAULT_CLAIMS_POLICY };
let page = 'overview', ready = false;
let receiveAddress = '', receiveKey = '', receiveRevision = 0, receiveTimer;
let receiveRequest = null;
let vault = { exists: false, locked: true, account: null };
let claims = null, polling = false, nativeBusy = false, nativeRevision = 0, nativeOperation = '';
let nativeStateRevision = 0;
let preparationProgress = '';
let paymentBatch = null, paymentBatchKnown = !native, paymentBatchLoading = false, paymentBatchError = '';
let paymentBatchRevision = 0, paymentBatchAcknowledging = false, paymentBatchExplorer = '', paymentBatchRendered = null;
let claimsLimits = { ...DEFAULT_CLAIMS_LIMITS }, limitsKnown = false, limitsDirty = false, limitsApplying = false;
let useAllBalance = false, useAllFundingAddresses = null, sendAccount = '';
let watchedAccount = '', watchingAccount = null, watchRevision = 0;
let paymentPasteErrorTimer, paymentPasteRevision = 0;
let scanningPayment = false, scanRevision = 0, pendingPayment = null;
let readingPaymentLink = false, paymentLinkDirty = false, paymentInputErrorTimer;
let nativeAccountKey = '', watchCoverage = null;
let settings = { ...DEFAULT_SETTINGS }, settingsKnown = false, settingsOpen = false, settingsDirty = false, settingsApplying = false;
let walletSecurityStatusTimer;
let endpointSwitching = false, activeRpcEndpoint = rpcEndpoint(DEFAULT_SETTINGS);
const themePreference = matchMedia('(prefers-color-scheme: dark)');
const PREVIEW_SETTINGS_KEY = 'connectwallet.mobile.preview-settings.v1';
const walletId = info => info.accountScope === 'hd-wallet' ? info.walletId : info.account?.address;
const currentReceive = () => session.state.receiveAddress || session.state.address;
const PUBLIC_SNAPSHOT_PREFIX = 'connectwallet.mobile.public-snapshot.mainnet.v2.';
const MAX_PUBLIC_SNAPSHOT_BYTES = 2 * 1024 * 1024;

async function readPublicSnapshot(identity) {
  if (!native || walletId(vault) !== identity) return null;
  const endpoint = activeRpcEndpoint;
  const { value } = await Preferences.get({ key: PUBLIC_SNAPSHOT_PREFIX + encodeURIComponent(endpoint) + '.' + identity });
  if (endpoint !== activeRpcEndpoint || walletId(vault) !== identity || typeof value !== 'string' || value.length > MAX_PUBLIC_SNAPSHOT_BYTES ||
      new TextEncoder().encode(value).length > MAX_PUBLIC_SNAPSHOT_BYTES) return null;
  try { return JSON.parse(value); } catch { return null; }
}

async function writePublicSnapshot(identity, snapshot) {
  if (!native || walletId(vault) !== identity) return;
  // The session supplies only its validated public display snapshot. Native
  // wallet state, recovery material and private keys never enter Preferences.
  const value = JSON.stringify(snapshot);
  if (value.length > MAX_PUBLIC_SNAPSHOT_BYTES || new TextEncoder().encode(value).length > MAX_PUBLIC_SNAPSHOT_BYTES) return;
  await Preferences.set({ key: PUBLIC_SNAPSHOT_PREFIX + encodeURIComponent(activeRpcEndpoint) + '.' + identity, value });
}

function applyTheme() {
  const theme = resolvedTheme(settings.theme, themePreference.matches);
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#faf8fd' : '#15121d';
}
themePreference.addEventListener('change', applyTheme);
applyTheme();

function renderSettings() {
  if (settingsKnown && !settingsDirty && !settingsApplying) {
    $('settings-theme').value = settings.theme;
    $('settings-lock-mode').value = settings.autoLockMinutes === 0 ? 'never' : 'timer';
    $('settings-lock-minutes').value = String(settings.autoLockMinutes || 5);
    $('settings-rpc-host').value = settings.rpcHost;
    $('settings-rpc-port').value = String(settings.rpcPort);
  }
  $('settings-lock-minutes-row').hidden = $('settings-lock-mode').value !== 'timer';
  for (const id of ['settings-theme', 'settings-lock-mode', 'settings-lock-minutes', 'settings-rpc-host', 'settings-rpc-port', 'settings-default-server']) {
    $(id).disabled = !settingsKnown || settingsApplying;
  }
  $('save-settings').disabled = !ready || !settingsKnown || !settingsDirty || settingsApplying || nativeBusy || scanningPayment || !environment.active;
  $('save-settings').textContent = settingsApplying ? endpointSwitching ? 'Confirm in the native dialog…' : 'Saving…' : 'Save settings';
  $('retry-settings').hidden = settingsKnown;
  $('retry-settings').disabled = settingsApplying;
  const securityDisabled = !native || !ready || vault.exists !== true || nativeBusy || scanningPayment || settingsApplying || !environment.active;
  $('change-wallet-password').disabled = securityDisabled;
  $('view-recovery-phrase').disabled = securityDisabled;
  $('change-wallet-password').textContent = nativeOperation === 'changePassword' ? 'Confirm in the native dialog…' : 'Change wallet password';
  $('view-recovery-phrase').textContent = nativeOperation === 'viewRecoveryPhrase' ? 'Open in the native dialog…' : 'View recovery phrase';
  $('wallet-security-help').textContent = !native ? 'Security and backup actions are available in the mobile app.'
    : !vault.exists ? 'Create or import a wallet to manage its password and recovery phrase.'
      : 'Authenticate in the native dialog to change your password or view your recovery phrase.';
}

function clearWalletSecurityStatus() {
  clearTimeout(walletSecurityStatusTimer);
  walletSecurityStatusTimer = undefined;
  $('wallet-security-status').textContent = '';
}

async function loadSettings() {
  $('settings-error').textContent = '';
  $('settings-status').textContent = 'Loading saved settings…';
  try {
    let result;
    if (native) result = await wallet.getSettings();
    else {
      try { result = JSON.parse(localStorage.getItem(PREVIEW_SETTINGS_KEY)); } catch { /* Preview preferences are optional. */ }
      try { result = parseSettings(result); } catch { result = DEFAULT_SETTINGS; }
    }
    settings = parseSettings(result); settingsKnown = true;
    if (activeRpcEndpoint !== rpcEndpoint(settings)) invalidateEndpoint(rpcEndpoint(settings));
    applyTheme();
    $('settings-status').textContent = native ? 'Settings are saved on this device.' : 'Browser preview only. Preferences stay in this browser; locking and RPC require the mobile app.';
  } catch {
    $('settings-error').textContent = 'Could not load saved settings. Reload to try again.';
    $('settings-status').textContent = '';
  }
  renderSettings();
}

function invalidateEndpoint(endpoint) {
  // Drop every display cursor, watch acknowledgement and funding selection
  // before adopting the new native account, even if the wallet ID is identical.
  activeRpcEndpoint = endpoint;
  ++nativeStateRevision; ++watchRevision;
  watchedAccount = ''; watchingAccount = null; watchCoverage = null; nativeAccountKey = '';
  liveBalance.pause();
  pendingPayment = null; useAllBalance = false; useAllFundingAddresses = null;
  transactionDetails.close({ restoreFocus: false });
  session.clearAccount();
}

function showSettings(open) {
  if (!open) clearWalletSecurityStatus();
  settingsOpen = open;
  $('settings-panel').hidden = !open;
  $('open-settings').setAttribute('aria-expanded', String(open));
  transactionDetails.close({ restoreFocus: false });
  render(session.state); renderSettings();
  (open ? $('settings-title') : $('open-settings')).focus({ preventScroll: true });
  if (open) window.scrollTo({ top: 0 });
}

function clearPaymentInputError() {
  clearTimeout(paymentInputErrorTimer);
  $('payment-input-error').textContent = '';
  $('payment-input-error').classList.remove('is-fading');
}

function showPaymentInputError() {
  clearPaymentInputError();
  $('payment-input-error').textContent = 'Use a valid mainnet ConnectCoin address or "connectcoin:" payment link.';
  paymentInputErrorTimer = setTimeout(() => {
    $('payment-input-error').classList.add('is-fading');
    paymentInputErrorTimer = setTimeout(clearPaymentInputError, 1000);
  }, 3000);
}

function paymentDetails(request) {
  return [request.label && `Label: ${request.label}`, request.message && `Message: ${request.message}`].filter(Boolean).join('\n');
}

function clearRequestDetails() {
  $('send-request-details').textContent = '';
  $('send-request-details').hidden = true;
}

function canFillPaymentRequest() {
  return native && ready && environment.active && !nativeBusy && !scanningPayment && !paymentBatchBlocksPayment() &&
    Boolean(session.state.address) && walletId(vault) === session.state.address;
}

function fillPendingPaymentRequest() {
  if (!pendingPayment || !canFillPaymentRequest()) return;
  if (pendingPayment.owner && pendingPayment.owner !== session.state.address) {
    pendingPayment = null;
    return;
  }
  applyPaymentRequest(pendingPayment.request);
}

function applyPaymentRequest(request) {
  ++scanRevision;
  clearPaymentPasteError(); clearPaymentInputError();
  $('send-address').value = request.address;
  $('send-amount').value = request.amount || '';
  $('send-deduct-fees').checked = false; useAllBalance = false;
  $('send-fee-rate').value = '1500';
  $('send-request-details').textContent = paymentDetails(request);
  $('send-request-details').hidden = !$('send-request-details').textContent;
  // Do not clear any previous submission receipt: a new request is not proof
  // that an earlier uncertain transaction failed.
  pendingPayment = null;
  amountGuard.sync(); showPage('send'); renderVault();
}

function acceptPaymentRequest(request) {
  clearPaymentInputError();
  // Replace the form automatically, including an existing draft. Keep only the
  // latest request while the app/account is unavailable or a native operation
  // is in progress; fill it as soon as the form becomes available again.
  // Never change the transaction currently displayed in native confirmation.
  pendingPayment = { request, owner: session.state.address };
  fillPendingPaymentRequest();
}

async function drainPaymentLinks() {
  if (!native || !ready) return;
  paymentLinkDirty = true;
  if (readingPaymentLink) return;
  readingPaymentLink = true;
  try {
    do {
      paymentLinkDirty = false;
      const result = await paymentInput.takePaymentLink();
      if (!result?.text && !result?.error) continue;
      try {
        if (result.error) throw new Error('Invalid payment link');
        const request = parsePaymentIntake(result.text, { source: 'external' });
        ++scanRevision; // A later link wins over a still-open camera result.
        clearPaymentInputError();
        acceptPaymentRequest(request);
      } catch { showPaymentInputError(); }
    } while (paymentLinkDirty);
  } catch { /* A missing/temporarily unavailable bridge must not block the wallet. */ }
  finally { readingPaymentLink = false; }
}

function clearPaymentPasteError() {
  ++paymentPasteRevision;
  clearTimeout(paymentPasteErrorTimer);
  paymentPasteErrorTimer = undefined;
  const target = $('payment-paste-error');
  target.textContent = ''; target.classList.remove('is-fading');
}

function showPaymentPasteError(message = 'Copy a valid ConnectCoin address or "connectcoin:" payment link.') {
  clearPaymentPasteError();
  const target = $('payment-paste-error');
  target.textContent = message;
  // Match desktop feedback without touching persistent payment errors/receipts.
  paymentPasteErrorTimer = setTimeout(() => {
    target.classList.add('is-fading');
    paymentPasteErrorTimer = setTimeout(clearPaymentPasteError, 1000);
  }, 3000);
}

$('brand-icon').src = icon;
$('preview-notice').hidden = native;
$('receive-metadata-notice').textContent = RECEIVE_METADATA_NOTICE;
const amountGuard = installAmountInputRestrictions(document, { onReject: ({ input }) => {
  const status = input.id.startsWith('p2c-') ? 'p2c-status' : input.id.startsWith('send-') ? 'send-status' : 'receive-error';
  $(status).textContent = input.dataset.numeric === 'integer' ? 'Use a positive whole number. Nothing was pasted.'
    : 'Use digits and one decimal separator, with up to 10 decimal places. Nothing was pasted.';
} });
const textGuard = installTextInputRestrictions(document, { onReject: ({ limit }) => {
  $('receive-error').textContent = `Keep this field within ${limit} characters. Nothing was pasted.`;
} });

const session = new HdWalletSession({
  readCache: readPublicSnapshot,
  writeCache: writePublicSnapshot,
  readRecoverySnapshots: async () => native && !endpointSwitching ? wallet.getRecoverySnapshots() : null,
  query: async (method, params) => {
    if (!native) throw Object.assign(new Error('Native mobile app required'), { code: 'UNAVAILABLE' });
    if (endpointSwitching) throw Object.assign(new Error('Server is changing'), { code: 'RPC_INACTIVE' });
    const endpoint = activeRpcEndpoint;
    const owned = new Set((vault.accountScope === 'hd-wallet' ? vault.accounts : [vault.account])?.map(item => item.address));
    const requested = method === 'getaddresschanges' ? params.addresses : [params.address];
    if (!vault.exists || !vault.account?.address ||
        (method !== 'getchaintip' && (!Array.isArray(requested) || !requested.length || requested.some(address => !owned.has(address))))) {
      throw Object.assign(new Error('Native wallet account required'), { code: 'RPC_INACTIVE' });
    }
    const response = await wallet.queryPublic({ method, params });
    if (endpoint !== activeRpcEndpoint) throw Object.assign(new Error('Server changed'), { code: 'RPC_CANCELLED' });
    return response.result;
  },
  // Results are generation-guarded by WalletSession. Do not cancel the shared
  // native transport here: an explicitly enabled claims session also uses it.
  cancelAll: async () => {},
  onChange: render,
});

const liveBalance = new LiveBalance({ session,
  allowed: () => native && ready && session.state.hdComplete !== false && !nativeBusy && !limitsApplying && !endpointSwitching && environment.active && environment.connected,
});

const transactionDetails = createTransactionDetails({ document,
  readState: () => ({ ...session.getState(), confirmationsStale: session.confirmationsStale }),
  canOpenExplorer: () => native && ready && environment.active,
  openExplorer: txid => explorer.openTransaction({ txid }),
});

async function ensureAccountWatch() {
  const address = session.state.address;
  if (!native || !address || endpointSwitching || !environment.active || !environment.connected || watchedAccount === address || watchingAccount) return;
  const revision = watchRevision;
  const request = { revision };
  watchingAccount = request;
  try {
    // No renderer-supplied address: native code selects its own wallet account.
    const result = await wallet.watchAccount();
    if (revision !== watchRevision || !environment.active || !environment.connected ||
        session.state.address !== address || result.address !== address) return;
    watchedAccount = address;
    watchCoverage = result;
    renderVault();
    if (result.connected === true) liveBalance.notify({ address, reason: 'connected' });
  } catch { /* Native reconnects its channel; a later state poll can retry setup. */ }
  finally {
    if (watchingAccount !== request) return;
    watchingAccount = null;
    // A setup response from before pause/account change cannot suppress setup
    // for the current foreground generation, even for the same address.
    if (revision !== watchRevision) void ensureAccountWatch();
  }
}

function updateEnvironment(changes) {
  const previous = environment;
  environment = { ...environment, ...changes };
  if (!environment.active) {
    clearPaymentPasteError();
    clearWalletSecurityStatus();
    ++nativeStateRevision;
    // NativeWallet locks on pause. Do not let an older getState snapshot
    // re-enable review after camera/app switching; resume verifies it again.
    vault = { ...vault, locked: true };
  }
  session.setEnvironment(environment);
  if (!environment.active || !environment.connected) {
    watchedAccount = ''; ++watchRevision; liveBalance.pause();
  } else if (!previous.active || !previous.connected) {
    watchedAccount = ''; ++watchRevision; void ensureAccountWatch();
    liveBalance.request({ full: true });
  }
  liveBalance.wake();
  renderVault();
  if (ready && environment.active && !previous.active) {
    void pollNative(); void loadPaymentBatch(); void drainPaymentLinks();
  }
}

function paymentBatchBlocksPayment() {
  return native && (!paymentBatchKnown || paymentBatchLoading || paymentBatchAcknowledging || Boolean(paymentBatch));
}

function clearSendDraft() {
  ++scanRevision; clearRequestDetails(); clearPaymentPasteError();
  pendingPayment = null; useAllBalance = false; useAllFundingAddresses = null;
  $('send-address').value = ''; $('send-amount').value = '';
  $('send-deduct-fees').checked = false;
  amountGuard.sync();
}

function adoptPaymentBatch(batch) {
  paymentBatch = batch;
  if (batch?.transactions.some(part => part.status !== 'not-sent')) clearSendDraft();
}

async function loadPaymentBatch() {
  if (!native) return;
  const revision = ++paymentBatchRevision;
  paymentBatchLoading = true;
  renderVault();
  try {
    // Read only the durable local native journal; this never checks RPC or retries a payment.
    const result = await wallet.getPaymentBatch({});
    if (revision !== paymentBatchRevision) return;
    adoptPaymentBatch(parsePaymentBatchResponse(result));
    paymentBatchKnown = true; paymentBatchError = '';
  } catch {
    if (revision !== paymentBatchRevision) return;
    paymentBatchKnown = false;
    paymentBatchError = 'Could not load a valid saved payment result. Reload it before starting another payment.';
  } finally {
    if (revision === paymentBatchRevision) { paymentBatchLoading = false; render(session.state); }
  }
}

function renderPaymentBatch() {
  $('payment-batch-loading').hidden = !paymentBatchLoading;
  $('payment-batch-load-error').hidden = !paymentBatchError;
  $('payment-batch-load-error-text').textContent = paymentBatchError;
  $('payment-batch-reload').disabled = paymentBatchLoading || nativeBusy || !environment.active;
  $('payment-batch').hidden = !paymentBatch;
  if (!paymentBatch) { paymentBatchRendered = null; return; }
  const batch = paymentBatch;
  $('payment-batch-refresh').disabled = paymentBatchLoading || paymentBatchAcknowledging || nativeBusy || !environment.active;
  if (paymentBatchRendered !== batch) {
    paymentBatchRendered = batch;
    $('payment-batch-action-error').textContent = '';
    $('payment-batch-title').textContent = `Payment result · ${batch.transactionCount} transactions`;
    $('payment-batch-wallet').textContent = batch.walletId;
    $('payment-batch-address').textContent = batch.address;
    for (const [id, value] of [['requested', batch.requestedTotal], ['total', batch.total], ['fee', batch.fee]])
      $('payment-batch-' + id).textContent = `${formatConn(value)} CONN`;
    const kept = BigInt(batch.requestedTotal) - BigInt(batch.total) - BigInt(batch.fee);
    $('payment-batch-kept-row').hidden = kept <= 0n;
    $('payment-batch-kept').textContent = kept > 0n ? `${formatConn(kept.toString())} CONN` : '';
    $('payment-batch-status').textContent = batch.status === 'submitted'
      ? `All ${batch.transactionCount} transactions were submitted. Confirmation is pending.`
      : batch.status === 'not-sent' ? 'No transactions were sent. Review this result before preparing a new payment.'
        : batch.status === 'partial' ? 'Only part of this payment was submitted. Do not resend the whole payment. Check the listed transactions before making another payment.'
          : 'Some transactions may have been sent, but their result is unknown. Do not resend the whole payment. Check each transaction before making another payment.';
    const totals = paymentBatchTotals(batch);
    const labels = { submitted: 'Submitted', 'check-required': 'Check required', 'not-sent': 'Not sent' };
    $('payment-batch-outcome').textContent = Object.entries(totals).map(([status, group]) =>
      `${labels[status]}: ${group.count} · ${formatConn(group.amount)} CONN to recipient · ${formatConn(group.fee)} CONN ${status === 'not-sent' ? 'planned fees (not spent)' : status === 'check-required' ? 'possible fees' : 'network fees'}.`).join(' ');
    $('payment-batch-transactions').replaceChildren(...batch.transactions.map((part, index) => {
      const row = document.createElement('li');
      const title = document.createElement('strong'); title.textContent = `Transaction ${index + 1} · ${labels[part.status]}`;
      const amount = document.createElement('p'); amount.className = 'hint';
      amount.textContent = `${formatConn(part.amount)} CONN to recipient · ${formatConn(part.fee)} CONN ${part.status === 'not-sent' ? 'planned fee (not spent)' : part.status === 'check-required' ? 'possible fee' : 'network fee'}`;
      const id = document.createElement('p'); id.className = 'batch-identifier'; id.textContent = part.txid;
      const open = document.createElement('button'); open.type = 'button'; open.className = 'text-button';
      open.dataset.batchTxid = part.txid; open.textContent = 'Check in explorer ↗';
      open.setAttribute('aria-label', `Check transaction ${index + 1} in explorer`);
      row.append(title, amount, id, open); return row;
    }));
    $('payment-batch-acknowledge-help').textContent = ['partial', 'check-required'].includes(batch.status)
      ? 'Acknowledge only after checking these transactions. This closes the receipt; it does not retry any payment or release funds reserved for an uncertain transaction.'
      : 'Closing this result does not send or retry a payment.';
  }
  $('payment-batch-dismiss').disabled = !native || nativeBusy || paymentBatchLoading || paymentBatchAcknowledging || !paymentBatchKnown || !environment.active;
  $('payment-batch-dismiss').textContent = paymentBatchAcknowledging ? 'Closing payment result…'
    : ['partial', 'check-required'].includes(batch.status) ? 'I have checked these transactions' : 'Close batch result';
  for (const button of $('payment-batch-transactions').querySelectorAll('button')) {
    button.disabled = !native || !ready || !environment.active || nativeBusy || Boolean(paymentBatchExplorer);
    button.textContent = paymentBatchExplorer === button.dataset.batchTxid ? 'Opening explorer…' : 'Check in explorer ↗';
  }
}

function adoptNativeAccount(info) {
  // The native vault is the sole account authority. Never restore an address
  // from the removed public-profile preference or accept one from a form.
  const address = native && info.exists === true && typeof info.account?.address === 'string'
    ? parseMainnetAddress(info.account.address) : '';
  if (address && address !== info.account.address) throw new Error('Invalid native wallet account.');
  if (typeof info.rpcEndpoint === 'string' && info.rpcEndpoint !== activeRpcEndpoint) invalidateEndpoint(info.rpcEndpoint);
  vault = info;
  const identity = address ? walletId(info) : '';
  if (identity !== session.state.address) {
    $('wallet-file-status').textContent = ''; $('wallet-file-error').textContent = '';
    clearWalletSecurityStatus(); $('wallet-security-error').textContent = '';
  }
  // getState is polled for native lock/claims UI. Revalidate curve points only
  // when the public HD descriptor set changes, not once per second per address.
  const key = JSON.stringify([info.accountScope, identity, info.account, info.accounts, info.hd?.complete, info.hd?.recovering]);
  if (key === nativeAccountKey) { void ensureAccountWatch(); return; }
  if (address) nativeHdAccounts(info);
  nativeAccountKey = key;
  if (identity !== session.state.address) watchCoverage = null;
  watchedAccount = ''; ++watchRevision;
  if (!address) session.clearAccount();
  else {
    // Network refresh must not keep local unlock and Stop/Lock controls busy.
    void session.loadWallet(info)
      .catch(() => { if (session.state.address === identity) $('global-error').textContent = 'Could not load your wallet account.'; })
      .finally(() => {
        // Initial history/tip failures resolve false rather than throwing. A
        // balance-only catch-up must not depend on the separate watch ACK.
        if (session.state.address === identity) liveBalance.request();
      });
  }
  void ensureAccountWatch();
}

function adoptClaimsLimits(state) {
  // Do not write default values over native preferences before reading them.
  try { claimsLimits = parseClaimsLimits(state); limitsKnown = true; }
  catch { /* An older/unavailable bridge cannot safely apply these settings. */ }
}

function renderClaimsLimits() {
  if (!limitsDirty && !limitsApplying) {
    $('claims-rate-limit').value = String(claimsLimits.connectionsPerSecondLimit);
    $('claims-concurrency').value = String(claimsLimits.concurrency);
  }
  for (const id of ['claims-rate-limit', 'claims-concurrency']) $(id).disabled = !native || !limitsKnown || limitsApplying;
  $('apply-claims-limits').disabled = !native || !limitsKnown || !limitsDirty || limitsApplying;
  $('apply-claims-limits').textContent = limitsApplying ? 'Applying…' : 'Apply limits';
  $('claims-limits-status').textContent = !native ? 'Preview · native settings not available'
    : !limitsKnown ? 'Waiting for saved connection limits…'
    : limitsApplying ? 'Saving connection limits…'
    : limitsDirty ? 'Unsaved changes. Apply limits to use them.'
    : `Saved ceilings: ${claimsLimits.connectionsPerSecondLimit}/second · ${claimsLimits.concurrency} simultaneous. Applies to new attempts; claims are not started automatically.`;
}

function renderClaims() {
  const controls = nativeControlState({ native, address: session.state.address, claims, locked: vault.locked, busy: nativeBusy });
  const status = evaluateClaimsPolicy({ enabled: claims?.enabled === true, ...policy, connected: environment.connected,
    connectionType: environment.connectionType, appActive: environment.active,
    nativeClaimsAvailable: capabilities.claims, nativeBackgroundAvailable: capabilities.backgroundClaims, platform });
  $('mobile-data').checked = policy.allowMobileData;
  $('background').checked = policy.allowBackground;
  $('background').disabled = !capabilities.backgroundClaims;
  $('background').closest('label').hidden = platform === 'ios';
  $('claims-status').textContent = !native ? 'Preview · native claims not available' : claims ? `${claims.policyStatus} · ${claims.status}` : status.reason;
  $('start-claims').disabled = controls.startDisabled;
  $('stop-claims').disabled = controls.stopDisabled;
  $('background-claims').hidden = settingsOpen || !native || Boolean(session.state.address) || !(claims?.enabled || claims?.requested);
  $('background-claims-status').textContent = claims ? `${claims.policyStatus} · ${claims.status}` : '';
  $('stop-background-claims').disabled = controls.stopDisabled;
  for (const key of ['attempts', 'valid', 'invalid', 'targetHits', 'submitted', 'unknown', 'connectionsPerSecond', 'activeConnections', 'eligible']) {
    const value = claims?.[key]; $('claims-' + key).textContent = Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '0';
  }
  $('claims-domain').textContent = claims?.currentDomain ? `Current domain: ${claims.currentDomain}` : '';
  $('claims-discovery').textContent = claims?.totalBlocks ? `Discovery: ${claims.discoveredBlocks}/${claims.totalBlocks} blocks${claims.discoveryComplete ? ' · complete' : ' · claims can run during discovery'}` : '';
  $('claims-error').textContent = claimsErrorText(claims);
  $('claims-receipt').hidden = !claims?.receiptTxid;
  $('claims-receipt').textContent = claims?.receiptTxid ? `${claims.receiptStatus}: ${claims.receiptTxid}` : '';
  $('check-claim').hidden = !claims || !['pending', 'unknown'].includes(claims.receiptStatus);
  renderClaimsLimits();
}

function renderWalletFiles() {
  const existing = native && vault.exists === true;
  $('wallet-files').hidden = settingsOpen || !existing || Boolean(session.state.address) && page !== 'overview';
  $('export-wallet').disabled = !existing || !ready || nativeBusy || scanningPayment || !environment.active;
  $('export-wallet').textContent = nativeBusy && nativeOperation === 'exportWallet' ? 'Exporting wallet…' : 'Export wallet file';
  $('manage-import-wallet').hidden = !session.state.address;
  $('manage-import-wallet').disabled = !existing || !ready || nativeBusy || scanningPayment || !environment.active;
}

// Only a live, reconciled subset can fund a partial payment. This is merely a
// source restriction: the native signer still authenticates every funding coin.
function partialFundingAddresses() {
  const state = session.state;
  if (state.partial !== true || state.cached || state.stale || !state.updatedAt || state.hdComplete !== true ||
      !Array.isArray(state.verifiedAddresses) || !state.verifiedAddresses.length ||
      !Array.isArray(state.fundingAddresses) || !state.fundingAddresses.length) return null;
  const owned = new Set(vault.accounts?.map(account => account.address));
  const verified = new Set(state.verifiedAddresses), addresses = [...state.fundingAddresses];
  return verified.size === state.verifiedAddresses.length && state.verifiedAddresses.every(address => owned.has(address)) &&
    new Set(addresses).size === addresses.length && addresses.every(address => verified.has(address)) ? addresses : null;
}

function canReviewBalance() {
  const state = session.state;
  if (state.cached || state.hdComplete === false) return false;
  if (state.partial) return partialFundingAddresses() !== null;
  return !(state.scope === 'hd' && state.busy && !state.updatedAt);
}

function paymentFundingScope({ sweep = false } = {}) {
  const partial = partialFundingAddresses();
  const selected = sweep && useAllFundingAddresses ? [...useAllFundingAddresses] : partial;
  if (session.state.partial && (!partial || selected?.some(address => !partial.includes(address)))) {
    throw new Error('Wait for the selected funds to be verified, then use the available balance again.');
  }
  return selected ? { fundingAddresses: selected } : {};
}

function renderVault() {
  renderWalletFiles();
  renderSettings();
  renderPaymentBatch();
  const owns = Boolean(session.state.address) && walletId(vault) === session.state.address;
  const hd = vault.accountScope === 'hd-wallet', recovering = hd && session.state.hdComplete !== true;
  $('account-kind').textContent = hd ? 'NATIVE HD WALLET · RECEIVING ADDRESS' : 'NATIVE WALLET · FIRST ADDRESS';
  $('vault-status').textContent = !vault.exists ? 'Create or import a native wallet first.' : vault.locked ? 'Wallet locked. Unlock to review a payment.' : recovering ? 'Unlocked · discovering wallet addresses…' : hd ? 'Unlocked' : 'Unlocked · first receiving address only';
  $('hd-panel').hidden = !hd;
  const recoveryDisplay = hdRecoveryStatus(vault, environment);
  $('hd-status').textContent = recoveryDisplay.status;
  const progress = session.state.progress;
  $('wallet-load-progress').hidden = !hd || !progress;
  if (progress) {
    const phase = { history: 'Loading history', snapshot: 'Verifying balance', changes: 'Checking latest changes' }[progress.phase] || 'Updating wallet';
    $('wallet-load-progress-text').textContent = `${phase} · ${progress.completed} / ${progress.total} addresses`;
    $('wallet-load-progress-bar').max = Math.max(1, progress.total);
    $('wallet-load-progress-bar').value = progress.completed;
  } else $('wallet-load-progress-text').textContent = '';
  $('hd-error').textContent = recoveryDisplay.error;
  $('recover-addresses').disabled = !native || nativeBusy || vault.locked || vault.hd?.recovering === true || !environment.active || !environment.connected;
  $('recover-addresses').textContent = recoveryDisplay.retryLabel;
  $('new-receive-address').hidden = !hd;
  $('new-receive-address').disabled = !native || nativeBusy || vault.locked || recovering || !environment.active;
  $('receive-path').textContent = hd ? vault.account?.path || '' : '';
  const coverage = vault.watch ?? watchCoverage;
  $('watch-coverage').hidden = coverage?.coverageLimited !== true;
  $('watch-coverage').textContent = coverage?.coverageLimited ? `Live notifications cover ${coverage.watched ?? 0} of ${coverage.total ?? vault.accounts?.length ?? 0} addresses. Use Refresh to check addresses outside that coverage.` : '';
  $('p2c-vault-status').textContent = $('vault-status').textContent;
  $('open-native-wallet').hidden = !vault.exists;
  // Native setup requires an explicit verified backup before replacing a vault.
  for (const id of ['create-wallet', 'import-recovery', 'import-wallet']) {
    $(id).disabled = !ready || !native || nativeBusy || scanningPayment || !environment.active;
  }
  $('open-native-wallet').disabled = !ready || !native || !vault.exists || nativeBusy;
  $('unlock-wallet').disabled = !native || !vault.exists || !vault.locked || nativeBusy;
  $('unlock-wallet').hidden = !vault.exists || !vault.locked;
  $('lock-wallet').disabled = nativeControlState({ native, locked: vault.locked, busy: nativeBusy }).lockDisabled;
  // Keep interruption available while an unlock/setup is in flight, without
  // labelling an already locked vault as something that still needs locking.
  $('lock-wallet').hidden = vault.locked && !nativeBusy;
  $('lock-wallet').textContent = vault.locked ? 'Cancel' : 'Lock';
  $('p2c-unlock-wallet').disabled = $('unlock-wallet').disabled;
  $('p2c-unlock-wallet').hidden = $('unlock-wallet').hidden;
  $('p2c-lock-wallet').disabled = $('lock-wallet').disabled;
  $('p2c-lock-wallet').hidden = $('lock-wallet').hidden;
  $('p2c-lock-wallet').textContent = $('lock-wallet').textContent;
  const partialFunds = partialFundingAddresses();
  if (useAllFundingAddresses && (vault.locked || !owns || session.state.stale || session.state.cached ||
      session.state.partial && (!partialFunds || useAllFundingAddresses.some(address => !partialFunds.includes(address))))) useAllBalance = false;
  if (!useAllBalance) useAllFundingAddresses = null;
  $('review-payment').disabled = !native || vault.locked || !owns || nativeBusy || recovering || !canReviewBalance() || paymentBatchBlocksPayment();
  if (scanningPayment) $('review-payment').disabled = true;
  $('review-payment').textContent = nativeBusy && nativeOperation === 'reviewPayment' ? 'Preparing payment…' : 'Review payment';
  $('send-progress').hidden = !nativeBusy || nativeOperation !== 'reviewPayment';
  $('send-progress').textContent = nativeOperation === 'reviewPayment' && preparationProgress || 'Verifying funds and preparing the native confirmation… No funds are sent until you confirm.';
  for (const id of ['send-address', 'send-amount', 'send-fee-rate', 'send-deduct-fees']) $(id).disabled = nativeBusy || scanningPayment || paymentBatchBlocksPayment();
  $('paste-payment').disabled = !native || nativeBusy || scanningPayment || vault.locked || paymentBatchBlocksPayment();
  $('scan-payment').disabled = !native || !ready || nativeBusy || scanningPayment || !environment.active || paymentBatchBlocksPayment();
  $('scan-payment').textContent = scanningPayment ? 'Scanning…' : 'Scan payment QR';
  const available = session.state.cached || session.state.partial && !partialFunds ? null : availableSendAmount(session.state);
  $('send-refresh-balance').disabled = !native || !owns || nativeBusy || recovering || session.state.busy || !environment.active || !environment.connected;
  $('send-refresh-balance').textContent = session.state.busy ? 'Refreshing…' : 'Refresh balance';
  // Filling a public amount needs no private keys. Review/signing still require
  // an unlocked native vault and freshly verified funding.
  $('send-use-all').disabled = !native || !owns || nativeBusy || scanningPayment || available === null || !environment.active || !environment.connected || paymentBatchBlocksPayment();
  $('send-use-all').textContent = session.state.partial ? 'Use all verified balance' : 'Use all balance';
  const availableLabel = session.state.partial ? 'Verified available balance' : 'Available';
  $('send-available').textContent = available !== null ? `${availableLabel}: ${available} CONN` : session.state.balance?.available_confirmed === '0' && !session.state.stale ? `${availableLabel}: 0 CONN` : 'Refresh to check available balance.';
  $('send-balance-status').textContent = !native ? '' : session.state.cached
    ? 'Previously saved balance. Payments become available after the latest balance is verified.' : session.state.error
    ? 'Could not update the balance. Automatic retry is pending; you can also refresh.'
    : partialFunds ? `${session.state.verifiedAddresses.length} / ${session.state.addressCount} addresses verified. You can spend these funds while the remaining addresses are checked.`
    : session.state.busy ? 'Updating balance…' : session.state.stale ? 'Waiting to verify the latest balance…' : '';
  $('send-all-hint').hidden = !useAllBalance;
  $('send-all-hint').textContent = useAllFundingAddresses
    ? `Using the verified balance from ${useAllFundingAddresses.length} selected addresses, with fees deducted. Addresses verified later are not added to this payment. Immature and pending funds are excluded.`
    : 'Using the displayed available balance, with fees deducted. Immature and pending funds are excluded. If available funds change or are reserved, refresh and review again.';
  $('send-funding-hint').textContent = session.state.partial || useAllFundingAddresses
    ? 'Funds use only the selected verified addresses. Change uses a separate native change address. Pending conflicts require explicit native confirmation.'
    : 'Funds can use all recovered wallet addresses. Change uses a separate native change address. Pending conflicts require explicit native confirmation.';
  $('review-p2c').disabled = !native || vault.locked || !owns || nativeBusy || recovering || !canReviewBalance() || paymentBatchBlocksPayment();
  $('p2c-batch-notice').hidden = !paymentBatch && !paymentBatchError;
  $('p2c-balance-status').hidden = !session.state.partial;
  $('p2c-balance-status').textContent = !session.state.partial ? '' : partialFunds
    ? `Verified available balance: ${formatConn(session.state.balance.available_confirmed)} CONN · ${session.state.verifiedAddresses.length} / ${session.state.addressCount} addresses. This reward uses only those verified addresses.`
    : 'Waiting to verify the latest funding state…';
  $('review-p2c').textContent = nativeBusy ? 'Native operation in progress…' : 'Review P2C reward';
  $('p2c-progress').hidden = !nativeBusy || nativeOperation !== 'reviewP2C';
  $('p2c-progress').textContent = nativeOperation === 'reviewP2C' && preparationProgress || 'Verifying funds and checking the domain’s RSA-PSS support before native confirmation… No funds are sent until you confirm.';
  for (const id of ['p2c-domain', 'p2c-amount', 'p2c-expected']) $(id).disabled = nativeBusy;
  fillPendingPaymentRequest();
}

async function nativeAction(action, options = {}, errorTarget = 'global-error') {
  const control = nativeActionState(action, native, nativeBusy);
  if (!control.allowed) return;
  ++scanRevision;
  clearPaymentPasteError();
  const expected = ++nativeRevision;
  if (control.ownsBusy) { nativeBusy = true; nativeOperation = action; preparationProgress = ''; }
  renderVault(); renderClaims(); $('global-error').textContent = ''; $(errorTarget).textContent = '';
  try {
    const result = await wallet[action](options);
    if (result?.cancelled === true) return;
    if (action === 'reviewPayment' && result?.batch === true) {
      try { adoptPaymentBatch(parsePaymentBatch(result)); paymentBatchKnown = true; }
      catch {
        clearSendDraft(); paymentBatchKnown = false;
        paymentBatchError = 'Could not validate the payment result. Reload the saved result before starting another payment.';
      }
    }
    if (expected === nativeRevision && ['create', 'importRecovery', 'importWallet'].includes(action)) {
      clearPaymentDrafts();
      for (const id of ['receive-amount', 'receive-label', 'receive-message']) $(id).value = '';
      amountGuard.sync(); textGuard.sync(); updateReceive();
      $('wallet-file-status').textContent = ''; $('wallet-file-error').textContent = '';
    }
    try {
      const info = await wallet.getState();
      if (expected === nativeRevision) adoptNativeAccount(info);
    } catch {
      // A receipt must survive a subsequent state-refresh failure. Losing a
      // successful/uncertain result here could invite a duplicate payment.
      $('global-error').textContent = 'Could not refresh wallet state. Keep any transaction ID shown and check its status before retrying.';
    }
    return result;
  } catch (error) {
    // Only explicit native Cancel/back is a normal dismissal. Interruptions,
    // failed verification and uncertain submissions must remain visible.
    const importing = action === 'importWallet' || action === 'importRecovery';
    if (error?.code !== 'CANCELLED' && (!importing || expected === nativeRevision)) $(errorTarget).textContent = importing
      ? error?.code === 'STORAGE_UNCERTAIN'
        ? 'Wallet storage could not be verified. Keep your saved encrypted backup and recovery phrase safe. Reopen the app before trying another import.'
        : action === 'importWallet' ? 'Could not import the wallet file. Check the file and its password and try again.'
          : 'Could not import the recovery phrase. Check the words and new wallet password and try again.'
      : error.message || 'Native operation could not complete.';
  }
  finally {
    if (action === 'reviewPayment') await loadPaymentBatch();
    if (control.ownsBusy) { nativeBusy = false; nativeOperation = ''; preparationProgress = ''; }
    renderVault(); renderClaims(); await pollNative();
    if (action === 'reviewPayment' || action === 'reviewP2C') liveBalance.request({ full: true });
    else liveBalance.wake();
  }
}

async function exportWalletFile() {
  if ($('export-wallet').disabled) return;
  const expected = ++nativeRevision, stateRevision = nativeStateRevision, owner = walletId(vault) || '';
  const current = () => expected === nativeRevision && vault.exists === true && (walletId(vault) || '') === owner;
  nativeBusy = true; nativeOperation = 'exportWallet';
  $('wallet-file-status').textContent = ''; $('wallet-file-error').textContent = '';
  renderVault(); renderClaims();
  try {
    // Android chooses the destination and copies the encrypted bytes. Neither
    // file contents, file paths nor passwords cross this bridge.
    const result = await wallet.exportWallet();
    if (!current() || result?.cancelled === true) return;
    if (result?.exported !== true) throw new Error('Export was not confirmed');
    $('wallet-file-status').textContent = 'Encrypted wallet file exported.';
  } catch (error) {
    if (current() && error?.code !== 'CANCELLED') {
      $('wallet-file-error').textContent = 'Could not export the wallet file. Choose a destination and try again.';
    }
  } finally {
    if (nativeOperation === 'exportWallet') { nativeBusy = false; nativeOperation = ''; }
    renderVault(); renderClaims();
    // Export itself does not reload the account or refresh balances. A system
    // picker pause still requires the usual native lock-state reconciliation.
    if (stateRevision !== nativeStateRevision) await pollNative();
    liveBalance.wake();
  }
}

async function walletSecurityAction(action) {
  const button = action === 'changePassword' ? 'change-wallet-password' : 'view-recovery-phrase';
  const control = nativeActionState(action, native, nativeBusy);
  if (!control.allowed || $(button).disabled) return;
  const expected = ++nativeRevision, owner = walletId(vault) || '';
  const current = () => expected === nativeRevision && vault.exists === true && (walletId(vault) || '') === owner;
  ++scanRevision; clearPaymentPasteError(); clearWalletSecurityStatus();
  $('wallet-security-error').textContent = '';
  nativeBusy = true; nativeOperation = action;
  renderVault(); renderClaims();
  try {
    // Native code owns authentication and every password/recovery dialog.
    // Only an empty request and public state/completion cross the bridge.
    const result = await wallet[action]({});
    if (!current()) return;
    if (action === 'changePassword') {
      if (result?.exists !== true || result.locked !== true) throw new Error('Password change was not confirmed');
      adoptNativeAccount({ ...result, locked: true });
      $('wallet-security-status').textContent = 'Password changed. Unlock with your new password. Export a new backup; older backups keep their old password.';
    } else if (settingsOpen && environment.active) {
      // A native dismissal rejects with CANCELLED. Never receive or inspect
      // recovery material, and do not retain completion feedback after leaving.
      $('wallet-security-status').textContent = 'Recovery phrase view closed.';
      walletSecurityStatusTimer = setTimeout(clearWalletSecurityStatus, 5000);
    }
  } catch (error) {
    if (current() && error?.code !== 'CANCELLED') {
      $('wallet-security-error').textContent = ['BUSY', 'NATIVE_BUSY', 'RECOVERY_ACTIVE', 'RECOVERY_BUSY'].includes(error?.code)
        ? 'Wait for the current wallet operation to finish and try again.'
        : error?.code === 'STORAGE_UNCERTAIN'
          ? action === 'changePassword'
            ? 'Wallet storage could not be verified. Keep both your old and new passwords and your existing encrypted backups. The wallet file may use either password. Reopen the app before unlocking. Do not replace the wallet.'
            : 'Wallet storage could not be verified. Keep your saved backups and recovery phrase safe. Reopen the app before trying again.'
          : action === 'changePassword' ? 'Could not change the wallet password. Check your current password and try again.'
            : 'Could not view the recovery phrase. Check your wallet password and try again.';
    }
  } finally {
    if (nativeOperation === action) { nativeBusy = false; nativeOperation = ''; }
    renderVault(); renderClaims();
    // Password authentication, cancellation and backgrounding can lock the
    // native vault. Reconcile public state without discarding drafts or funds.
    await pollNative(); liveBalance.wake();
  }
}

async function pollNative() {
  if (!native || polling || nativeBusy || limitsApplying || settingsApplying || !environment.active) return;
  polling = true;
  const expected = nativeRevision, stateRevision = nativeStateRevision;
  try {
    const [info, counters] = await Promise.all([wallet.getState(), wallet.claimsState()]);
    if (expected !== nativeRevision || stateRevision !== nativeStateRevision || !environment.active) return;
    adoptNativeAccount(info); claims = counters.state;
    adoptClaimsLimits(claims);
    policy = { allowMobileData: claims.allowMobileData === true, allowBackground: claims.allowBackground === true };
    renderVault(); renderClaims();
  } catch { /* Keep the last snapshot; never fake counters or restart a session. */ }
  finally { polling = false; }
}

function render(state) {
  state = session.getState();
  liveBalance.sync();
  const hasBatchResult = Boolean(paymentBatch || paymentBatchError);
  $('setup-panel').hidden = settingsOpen || Boolean(state.address) || hasBatchResult;
  $('wallet-panel').hidden = settingsOpen || !state.address && !hasBatchResult;
  const receiving = state.receiveAddress || state.address;
  $('current-address').textContent = receiving;
  $('receive-address').textContent = receiving;
  $('connection-status').textContent = !native ? 'Preview · no live RPC' : !environment.active ? 'Paused · app is in the background'
    : !environment.connected ? 'Offline · reconnecting automatically when available' : `${environment.connectionType === 'cellular' ? 'Mobile data' : environment.connectionType === 'wifi' ? 'Wi-Fi' : 'Network connected'} · foreground only`;
  $('refresh').disabled = state.busy || state.hdComplete === false || !environment.active || !environment.connected;
  $('refresh').textContent = state.busy ? 'Loading…' : 'Refresh';
  $('balance').textContent = state.balance ? formatConn(state.balance.confirmed) : '—';
  $('balance-label').textContent = state.partial ? 'Confirmed balance · verified addresses only' : 'Confirmed balance';
  $('partial-state-status').hidden = !state.partial;
  $('partial-state-status').textContent = state.partial
    ? `${state.verifiedAddresses?.length ?? 0} / ${state.addressCount} addresses ${state.stale ? 'previously verified. Waiting to recheck their funds before spending.' : 'verified. Balance and activity include only these addresses; the rest is still syncing.'}` : '';
  $('pending').textContent = state.balance
    ? `Pending in: ${formatConn(state.balance.pending_received)} · Pending out: ${formatConn(state.balance.pending_spent)} · Immature: ${formatConn(state.balance.immature)} CONN`
    : 'Refresh to load balances';
  const displayTip = state.displayTip ?? state.tip;
  $('block-height').textContent = displayTip ? `Block ${displayTip.height.toLocaleString('en-US')}` : '';
  $('wallet-error').textContent = state.error;
  $('cached-state-status').hidden = !state.cached;
  $('cached-state-status').textContent = !state.cached ? '' : `Previously saved balance and activity — ${
    !environment.active ? 'waiting for the app to resume.' : !environment.connected ? 'waiting for a connection.'
      : state.hdComplete === false ? 'waiting for address recovery.' : state.error ? 'update failed. Refresh to retry.' : 'updating…'}`;
  $('last-update').textContent = state.updatedAt ? `${state.cached ? 'Previously saved at ' : state.stale ? 'Last known balance · ' : 'Balance checked at '}${new Date(state.updatedAt).toLocaleTimeString('en-US')}. Balance updates automatically while the app is open.${state.historyStale ? ' Refresh to reload activity.' : ''}` : '';
  $('empty-history').hidden = state.history.length > 0;
  $('empty-history').textContent = state.updatedAt ? 'No activity in this history page.' : 'No history loaded yet.';
  $('load-more').hidden = !state.cursor;
  $('load-more').disabled = state.busy || !environment.active || !environment.connected;
  const focusedTxid = document.activeElement?.closest('#history button[data-txid]')?.dataset.txid;
  const rows = state.history.map(item => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'history-transaction'; button.dataset.txid = item.txid;
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'transaction-details');
    const label = document.createElement('span');
    label.textContent = BigInt(item.balance_delta) < 0n ? 'Sent' : BigInt(item.balance_delta) > 0n ? 'Received' : 'Transaction';
    const amount = document.createElement('span'); amount.className = 'amount'; amount.textContent = `${formatConn(item.balance_delta)} CONN`;
    const status = document.createElement('span'); status.className = 'state'; status.textContent = item.status === 'pending' ? 'Unconfirmed' : `${item.confirmations} confirmations`;
    const txid = document.createElement('span'); txid.className = 'txid'; txid.textContent = item.txid;
    const hint = document.createElement('span'); hint.className = 'history-details-hint'; hint.textContent = 'View details ›';
    button.append(label, amount, status, hint, txid); row.append(button); return row;
  });
  $('history').replaceChildren(...rows);
  if (focusedTxid) [...$('history').querySelectorAll('button[data-txid]')]
    .find(button => button.dataset.txid === focusedTxid)?.focus({ preventScroll: true });
  transactionDetails.render();
  $('history-limit').hidden = state.history.length < 2000;
  if (receiving !== receiveAddress) {
    receiveAddress = receiving;
    for (const id of ['receive-amount', 'receive-label', 'receive-message']) $(id).value = '';
    amountGuard.sync(); textGuard.sync();
    updateReceive();
  }
  if (state.address !== sendAccount) {
    if (pendingPayment?.owner && pendingPayment.owner !== state.address) pendingPayment = null;
    sendAccount = state.address;
    clearPaymentDrafts();
  }
  if (!state.address) showPage(hasBatchResult ? 'send' : 'overview');
  renderClaims();
  renderVault();
}

function clearPaymentDrafts() {
  ++scanRevision; clearRequestDetails();
  clearPaymentPasteError(); useAllBalance = false;
  for (const id of ['send-address', 'send-amount', 'p2c-domain', 'p2c-amount']) $(id).value = '';
  $('send-deduct-fees').checked = false; $('send-fee-rate').value = '1500'; $('p2c-expected').value = '1';
  $('send-status').textContent = ''; $('p2c-status').textContent = '';
  amountGuard.sync();
}

function updateReceive() {
  const draft = { address: receiveAddress, amount: $('receive-amount').value,
    label: $('receive-label').value, message: $('receive-message').value };
  const key = JSON.stringify(draft);
  if (key === receiveKey) return;
  receiveKey = key;
  const revision = ++receiveRevision;
  clearTimeout(receiveTimer);
  receiveRequest = null;
  $('receive-error').textContent = '';
  $('copy-status').textContent = '';
  $('receive-uri').value = '';
  $('copy-link').disabled = true;
  $('qr-card').hidden = true;
  $('receive-qr').removeAttribute('src');
  $('qr-status').textContent = '';
  $('label-count').textContent = `${[...draft.label].length}/100`;
  $('message-count').textContent = `${[...draft.message].length}/200`;
  if (!draft.address) return;
  let request;
  try { request = createReceiveRequest(draft); }
  catch (error) { $('receive-error').textContent = error.message; return; }
  $('qr-status').textContent = 'Updating payment request…';
  receiveTimer = setTimeout(async () => {
    try {
      const image = await QRCode.toDataURL(request.uri, { width: 256, margin: 4, errorCorrectionLevel: 'M' });
      if (revision !== receiveRevision) return;
      receiveRequest = request;
      $('receive-uri').value = request.uri;
      $('receive-qr').src = image;
      $('qr-card').hidden = false;
      $('qr-status').textContent = '';
      $('copy-link').disabled = false;
    } catch {
      if (revision !== receiveRevision) return;
      $('qr-status').textContent = '';
      $('receive-error').textContent = 'Could not generate this payment request. Shorten the details and try again.';
    }
  }, 120);
}

function showPage(next) {
  if (page !== next) { transactionDetails.close({ restoreFocus: false }); clearPaymentPasteError(); ++scanRevision; }
  page = next;
  for (const name of ['overview', 'receive', 'send', 'p2c', 'claims']) $(name).hidden = name !== page;
  for (const button of document.querySelectorAll('[data-page]')) {
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  renderWalletFiles();
}

async function refreshAccount(options = {}) {
  const address = session.state.address, expected = session.generation + 1;
  const refreshed = await session.refresh(options);
  if (refreshed && options.balanceOnly && session.historyNeedsBaseline()) liveBalance.request({ full: true });
  if (!refreshed && session.generation === expected && session.state.address === address && session.active && session.connected && session.state.error) {
    liveBalance.request({ failed: true });
  } else liveBalance.wake();
}
$('open-settings').addEventListener('click', () => showSettings(!settingsOpen));
$('settings-back').addEventListener('click', () => showSettings(false));
$('retry-settings').addEventListener('click', () => { void loadSettings(); });
function settingsEdited() {
  settingsDirty = true;
  $('settings-error').textContent = '';
  $('settings-status').textContent = 'Unsaved changes.';
  renderSettings();
}
for (const id of ['settings-theme', 'settings-lock-mode', 'settings-lock-minutes', 'settings-rpc-host', 'settings-rpc-port']) {
  $(id).addEventListener('input', settingsEdited);
  $(id).addEventListener('change', settingsEdited);
}
$('settings-default-server').addEventListener('click', () => {
  $('settings-rpc-host').value = DEFAULT_SETTINGS.rpcHost;
  $('settings-rpc-port').value = String(DEFAULT_SETTINGS.rpcPort);
  settingsEdited();
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('save-settings').disabled) return;
  let requested;
  try {
    if ($('settings-lock-mode').value === 'timer' && !/^[1-9][0-9]*$/.test($('settings-lock-minutes').value)) {
      throw new Error('Use a whole number from 1 to 1,440 minutes, or choose Never while open.');
    }
    requested = parseSettings({ theme: $('settings-theme').value,
      autoLockMinutes: $('settings-lock-mode').value === 'never' ? 0 : $('settings-lock-minutes').value,
      rpcHost: $('settings-rpc-host').value, rpcPort: $('settings-rpc-port').value });
  } catch (error) { $('settings-error').textContent = error.message; return; }
  settingsApplying = true;
  endpointSwitching = native && rpcEndpoint(requested) !== activeRpcEndpoint;
  const changesEndpoint = endpointSwitching, expected = ++nativeRevision, stateRevision = nativeStateRevision;
  if (changesEndpoint) { nativeBusy = true; nativeOperation = 'saveSettings'; liveBalance.pause(); }
  $('settings-error').textContent = '';
  $('settings-status').textContent = changesEndpoint ? 'Review the server change in the native confirmation.' : 'Saving settings…';
  renderVault(); renderClaims();
  try {
    const result = native ? await wallet.saveSettings(requested) : { settings: requested, endpointChanged: false };
    if (result?.cancelled === true) {
      $('settings-status').textContent = 'Server change cancelled. Your draft has not been saved.';
      return;
    }
    const saved = parseSettings(result.settings), endpoint = rpcEndpoint(saved);
    if (result.state?.rpcEndpoint && result.state.rpcEndpoint !== endpoint) throw new Error('Settings state mismatch.');
    if (native && (result.endpointChanged === true || endpoint !== activeRpcEndpoint)) invalidateEndpoint(endpoint);
    settings = saved; settingsKnown = true; settingsDirty = false;
    if (!native) {
      try { localStorage.setItem(PREVIEW_SETTINGS_KEY, JSON.stringify(saved)); } catch { /* Optional browser preview storage. */ }
    }
    endpointSwitching = false;
    if (native && result.state && expected === nativeRevision) {
      // A background transition always wins over a response captured earlier.
      adoptNativeAccount(!environment.active || stateRevision !== nativeStateRevision && !changesEndpoint
        ? { ...result.state, locked: true } : result.state);
    }
    applyTheme();
    $('settings-status').textContent = !native ? 'Saved in this browser preview. Locking and RPC require the mobile app.'
      : changesEndpoint ? 'Settings saved. Wallet locked; reconnecting to the selected server.' : 'Settings saved.';
  } catch (error) {
    if (error?.code === 'CANCELLED') $('settings-status').textContent = 'Server change cancelled. Your draft has not been saved.';
    else {
      $('settings-status').textContent = 'Your changes are still here. Try saving again.';
      $('settings-error').textContent = ['CLAIMS_ACTIVE', 'CLAIMS_RUNNING'].includes(error?.code)
        ? 'Stop Automatic Claims before changing the server.'
        : ['BUSY', 'NATIVE_BUSY', 'RECOVERY_ACTIVE', 'RECOVERY_BUSY'].includes(error?.code)
          ? 'Stop Automatic Claims and wait for the current wallet operation or address recovery to finish before changing the server.'
          : 'Could not save settings. Check the values and try again. Stop Automatic Claims before changing servers.';
    }
  } finally {
    settingsApplying = false; endpointSwitching = false;
    if (nativeOperation === 'saveSettings') { nativeBusy = false; nativeOperation = ''; }
    renderVault(); renderClaims();
    if (native) await pollNative();
    void ensureAccountWatch(); liveBalance.wake();
  }
});
$('refresh').addEventListener('click', () => { void refreshAccount(); });
$('load-more').addEventListener('click', () => { void refreshAccount({ more: true }); });
$('history').addEventListener('click', event => {
  const button = event.target.closest('button[data-txid]');
  if (button && $('history').contains(button)) transactionDetails.open(button.dataset.txid);
});
for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => showPage(button.dataset.page));
for (const [id, name] of [['mobile-data', 'allowMobileData'], ['background', 'allowBackground']]) {
  $(id).addEventListener('change', async () => {
    policy[name] = $(id).checked;
    if (native) {
      try { claims = (await wallet.claimsPolicy(policy)).state; }
      catch (error) { $('claims-error').textContent = error.message; await pollNative(); }
    }
    renderClaims();
  });
}
for (const id of ['claims-rate-limit', 'claims-concurrency']) $(id).addEventListener('input', () => {
  limitsDirty = true;
  $('claims-limits-error').textContent = '';
  renderClaimsLimits();
});
$('claims-limits-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!native || !limitsKnown || limitsApplying || !limitsDirty) return;
  let requested;
  try { requested = parseClaimsLimits({ connectionsPerSecondLimit: $('claims-rate-limit').value, concurrency: $('claims-concurrency').value }); }
  catch (error) { $('claims-limits-error').textContent = error.message; return; }
  limitsApplying = true;
  const expected = ++nativeRevision; // Invalidate a poll that began before this save.
  $('claims-limits-error').textContent = '';
  renderClaimsLimits();
  try {
    const result = await wallet.claimsLimits(requested);
    // Stop/Lock remain usable while settings are saved. Their newer snapshots
    // must not be replaced by the full state captured in this response.
    const saved = parseClaimsLimits(result.state);
    claimsLimits = saved;
    if (expected === nativeRevision) claims = result.state;
    limitsDirty = false;
  } catch (error) { $('claims-limits-error').textContent = error.message || 'Could not save connection limits. Try again.'; }
  finally { limitsApplying = false; renderClaims(); await pollNative(); liveBalance.wake(); }
});
for (const [id, action] of [['create-wallet', 'create'], ['import-recovery', 'importRecovery'], ['import-wallet', 'importWallet'], ['manage-import-wallet', 'importWallet'], ['unlock-wallet', 'unlock'], ['open-native-wallet', 'unlock'], ['lock-wallet', 'lock'], ['p2c-unlock-wallet', 'unlock'], ['p2c-lock-wallet', 'lock']]) {
  $(id).addEventListener('click', () => nativeAction(action));
}
$('export-wallet').addEventListener('click', () => { void exportWalletFile(); });
$('change-wallet-password').addEventListener('click', () => { void walletSecurityAction('changePassword'); });
$('view-recovery-phrase').addEventListener('click', () => { void walletSecurityAction('viewRecoveryPhrase'); });
$('new-receive-address').addEventListener('click', () => { if (!$('new-receive-address').disabled) void nativeAction('newAddress', {}, 'receive-error'); });
$('recover-addresses').addEventListener('click', () => { if (!$('recover-addresses').disabled) void nativeAction('recoverAddresses', {}, 'hd-error'); });
$('start-claims').addEventListener('click', () => nativeAction('claimsStart', { address: currentReceive() }));
$('stop-claims').addEventListener('click', () => nativeAction('claimsStop'));
$('stop-background-claims').addEventListener('click', () => nativeAction('claimsStop'));
$('check-claim').addEventListener('click', () => nativeAction('claimsCheckSubmission'));
$('p2c-open-claims').addEventListener('click', () => showPage('claims'));
$('p2c-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!native || vault.locked || !session.state.address || nativeBusy || !canReviewBalance() || paymentBatchBlocksPayment()) return;
  $('p2c-status').textContent = '';
  let request;
  try { request = { ...createP2CRequest({ domain: $('p2c-domain').value, amount: $('p2c-amount').value, expectedConnections: $('p2c-expected').value }), ...paymentFundingScope() }; }
  catch (error) { $('p2c-status').textContent = error.message; return; }
  $('p2c-domain').value = request.domain;
  const result = await nativeAction('reviewP2C', request, 'p2c-status');
  if (result?.txid) {
    $('p2c-status').textContent = `${result.status}: ${result.txid}${result.message ? ` · ${result.message}` : ''}`;
    void session.invalidate(); session.emit(); liveBalance.request({ full: true });
  }
});
$('send-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!native || vault.locked || !session.state.address || nativeBusy || scanningPayment || !canReviewBalance() || paymentBatchBlocksPayment()) return;
  $('send-status').textContent = '';
  let request;
  try { request = { ...createSendRequest({ address: $('send-address').value, amount: $('send-amount').value,
    feeRate: $('send-fee-rate').value, subtractFeeFromAmount: $('send-deduct-fees').checked, useAllBalance }), ...paymentFundingScope({ sweep: useAllBalance }) }; }
  catch (error) { $('send-status').textContent = error.message; return; }
  const result = await nativeAction('reviewPayment', request, 'send-status');
  if (result?.batch === true) {
    if (paymentBatch) $('payment-batch-title').focus({ preventScroll: false });
    void session.invalidate(); session.emit(); liveBalance.request({ full: true });
    return;
  }
  if (result?.txid) {
    $('send-status').textContent = `${result.status}: ${result.txid}${result.message ? ` · ${result.message}` : ''}`;
    useAllBalance = false;
    // Never let the pre-payment snapshot offer the same coins as a fresh sweep.
    void session.invalidate(); session.emit(); liveBalance.request({ full: true });
  }
});
$('payment-batch-reload').addEventListener('click', () => {
  if (!$('payment-batch-reload').disabled) void loadPaymentBatch();
});
$('payment-batch-refresh').addEventListener('click', () => {
  if (!$('payment-batch-refresh').disabled) void loadPaymentBatch();
});
$('payment-batch-dismiss').addEventListener('click', async () => {
  if (!paymentBatch || $('payment-batch-dismiss').disabled) return;
  const batch = paymentBatch;
  paymentBatchAcknowledging = true; $('payment-batch-action-error').textContent = ''; renderVault();
  try {
    const result = await wallet.dismissPaymentBatch({ batchId: batch.batchId });
    parsePaymentBatchDismissal(result, batch.batchId);
    await loadPaymentBatch();
  } catch (error) {
    if (paymentBatch?.batchId === batch.batchId) $('payment-batch-action-error').textContent = error?.code === 'BUSY'
      ? 'The native payment is still finishing. Wait, reload the result, and check it before closing.'
      : 'Could not close the payment result. Reload it and try again.';
  } finally { paymentBatchAcknowledging = false; renderVault(); }
});
$('payment-batch-transactions').addEventListener('click', async event => {
  const button = event.target.closest('button[data-batch-txid]');
  if (!button || button.disabled || !paymentBatch || !$('payment-batch-transactions').contains(button)) return;
  const batch = paymentBatch, txid = button.dataset.batchTxid;
  if (!batch.transactions.some(part => part.txid === txid)) return;
  paymentBatchExplorer = txid; $('payment-batch-action-error').textContent = ''; renderPaymentBatch();
  try { await explorer.openTransaction({ txid }); }
  catch {
    if (paymentBatch?.batchId === batch.batchId) $('payment-batch-action-error').textContent = 'Could not open the explorer. Check that a browser is installed and try again.';
  } finally { paymentBatchExplorer = ''; renderPaymentBatch(); }
});
$('send-use-all').addEventListener('click', () => {
  if ($('send-use-all').disabled) return;
  const amount = availableSendAmount(session.state);
  if (amount === null) return;
  clearPaymentPasteError();
  ++scanRevision; clearRequestDetails();
  $('send-amount').value = amount; $('send-deduct-fees').checked = true; useAllBalance = true;
  useAllFundingAddresses = partialFundingAddresses();
  amountGuard.sync(); $('send-status').textContent = ''; renderVault();
});
$('send-refresh-balance').addEventListener('click', () => { if (!$('send-refresh-balance').disabled) void refreshAccount({ balanceOnly: true }); });
$('send-amount').addEventListener('input', () => { useAllBalance = false; renderVault(); });
$('send-deduct-fees').addEventListener('change', () => { if (!$('send-deduct-fees').checked) useAllBalance = false; renderVault(); });
$('send-fee-rate').addEventListener('input', () => { $('send-status').textContent = ''; });
for (const id of ['send-address', 'send-amount', 'send-fee-rate', 'send-deduct-fees']) {
  $(id).addEventListener('input', () => {
    clearPaymentPasteError(); ++scanRevision; clearRequestDetails();
    if (id === 'send-address') { useAllBalance = false; renderVault(); }
  });
}
$('paste-payment').addEventListener('click', async () => {
  if ($('paste-payment').disabled) return;
  clearPaymentPasteError();
  const revision = paymentPasteRevision;
  const expected = nativeRevision, owner = session.state.address;
  const previous = [$('send-address').value, $('send-amount').value, $('send-deduct-fees').checked];
  const current = () => revision === paymentPasteRevision && !nativeBusy && !vault.locked &&
    environment.active && page === 'send' && nativeRevision === expected && session.state.address === owner &&
    previous[0] === $('send-address').value && previous[1] === $('send-amount').value && previous[2] === $('send-deduct-fees').checked;
  try {
    // Android WebView does not reliably expose the browser clipboard API.
    // Read once, only for this click, through the bounded foreground-only bridge.
    const clipboard = await wallet.readPaymentClipboard();
    if (!current()) return;
    const parsed = parseClipboardPaymentText(clipboard?.text);
    $('send-address').value = parseMainnetAddress(parsed.address);
    ++scanRevision; clearRequestDetails();
    $('send-amount').value = parsed.amount || '';
    useAllBalance = false; $('send-deduct-fees').checked = false;
    amountGuard.sync(); $('send-status').textContent = ''; renderVault();
  } catch (error) {
    if (current()) showPaymentPasteError(error?.code === 'CLIPBOARD_UNAVAILABLE'
      ? 'Could not read the clipboard. Paste directly into the address field.' : undefined);
  }
});
$('scan-payment').addEventListener('click', async () => {
  if ($('scan-payment').disabled || page !== 'send') return;
  clearPaymentPasteError();
  const revision = ++scanRevision, owner = session.state.address;
  const before = JSON.stringify([$('send-address').value, $('send-amount').value, $('send-deduct-fees').checked, $('send-fee-rate').value]);
  const current = () => revision === scanRevision && session.state.address === owner && !nativeBusy && page === 'send' &&
    before === JSON.stringify([$('send-address').value, $('send-amount').value, $('send-deduct-fees').checked, $('send-fee-rate').value]);
  scanningPayment = true; renderVault();
  try {
    const result = await paymentInput.scanPaymentQr();
    if (!current()) return;
    // Opening the camera can pause/lock the native vault. Refresh that state
    // without weakening locking or throwing away this public QR draft.
    const expected = nativeRevision, stateRevision = ++nativeStateRevision;
    vault = { ...vault, locked: true };
    renderVault();
    try {
      // Unlike a periodic poll, this cannot be skipped because another poll
      // is pending. Its older snapshot was invalidated above.
      const info = await wallet.getState();
      if (expected === nativeRevision && stateRevision === nativeStateRevision && environment.active) adoptNativeAccount(info);
    } catch { /* Keep review locked until a fresh native snapshot succeeds. */ }
    if (!current() || result?.cancelled) return;
    if (result?.error) throw Object.assign(new Error('Scan failed'), { code: result.error });
    const request = parsePaymentIntake(result?.text);
    scanningPayment = false;
    acceptPaymentRequest(request);
  } catch (error) {
    if (current()) {
      if (error?.code === 'CAMERA_PERMISSION_DENIED') showPaymentPasteError('Camera permission is needed to scan a payment QR. Allow it in device settings or paste the payment link.');
      else if (error?.code && error.code !== 'INVALID_PAYMENT_LINK') showPaymentPasteError('Could not open the camera. Try again or paste the payment link.');
      else showPaymentInputError();
    }
  } finally { scanningPayment = false; renderVault(); }
});
$('copy-link').addEventListener('click', async () => {
  if (!receiveRequest || receiveRequest.address !== currentReceive()) return;
  const revision = receiveRevision;
  try {
    await navigator.clipboard.writeText(receiveRequest.uri);
    if (revision === receiveRevision) $('copy-status').textContent = 'Payment link copied.';
  } catch {
    if (revision === receiveRevision) $('copy-status').textContent = 'Clipboard unavailable. Select the payment link above to copy it.';
  }
});
for (const id of ['receive-amount', 'receive-label', 'receive-message']) $(id).addEventListener('input', updateReceive);
$('clear-request').addEventListener('click', () => {
  for (const id of ['receive-amount', 'receive-label', 'receive-message']) $(id).value = '';
  amountGuard.sync(); textGuard.sync(); updateReceive();
});

async function start() {
  // Defaults stay conservative until native status is known. Public balance
  // refreshes are foreground-only; claims require a separate explicit start.
  if (native) await paymentInput.addListener('paymentLinkAvailable', () => { void drainPaymentLinks(); });
  if (native) await wallet.addListener('walletChanged', event => {
    if (endpointSwitching || event.rpcEndpoint && event.rpcEndpoint !== activeRpcEndpoint) return;
    if (event.address === session.state.address && (event.watch || typeof event.coverageLimited === 'boolean')) {
      watchCoverage = event.watch ?? event;
      vault = { ...vault, watch: watchCoverage }; renderVault();
    }
    if (environment.active && environment.connected) liveBalance.notify(event);
  });
  if (native) await wallet.addListener('paymentPreparation', event => {
    const text = paymentProgressText(event, { operation: nativeOperation, address: session.state.address,
      busy: nativeBusy, active: environment.active && !vault.locked });
    if (text) { preparationProgress = text; renderVault(); }
  });
  if (native) await wallet.addListener('walletStateChanged', info => {
    // Inactivity locking is native. Reflect its locked state immediately and
    // invalidate an older poll without accepting a delayed unlock event.
    if (info?.locked !== true || info.rpcEndpoint && info.rpcEndpoint !== activeRpcEndpoint) return;
    ++nativeStateRevision;
    vault = { ...vault, locked: true };
    renderVault(); renderClaims();
  });
  await Network.addListener('networkStatusChange', status => {
    updateEnvironment({ connected: status.connected, connectionType: status.connectionType }); renderClaims();
  });
  await App.addListener('appStateChange', ({ isActive }) => {
    updateEnvironment({ active: isActive });
  });
  if (native) await App.addListener('backButton', () => {
    if (transactionDetails.isOpen()) transactionDetails.close();
    else if (settingsOpen) showSettings(false);
    else if (page !== 'overview') showPage('overview');
    else App.minimizeApp().catch(() => { $('global-error').textContent = 'Could not minimize the app. Use the system Home gesture.'; });
  });
  const status = await Network.getStatus();
  environment = { ...environment, connected: status.connected, connectionType: status.connectionType };
  if (native) environment.active = (await App.getState()).isActive;
  else environment.active = !document.hidden;
  session.setEnvironment(environment);
  document.addEventListener('visibilitychange', () => {
    updateEnvironment({ active: !document.hidden });
  });
  render(session.state);
  await loadSettings();
  await pollNative();
  await loadPaymentBatch();
  if (native) setInterval(pollNative, 1000);
}
start().catch(() => { $('global-error').textContent = 'Could not initialize device services. Restart the app to try again.'; })
  .finally(() => { ready = true; renderVault(); liveBalance.wake(); void drainPaymentLinks(); document.documentElement.dataset.ready = 'true'; });
