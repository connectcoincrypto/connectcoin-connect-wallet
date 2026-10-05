import { Capacitor, registerPlugin } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { App } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import QRCode from 'qrcode';
import icon from '../../assets/icon-512.png';
import { installAmountInputRestrictions } from '../../src/ui/amount-input.mjs';
import { installTextInputRestrictions } from '../../src/ui/text-input.mjs';
import { parseClipboardPaymentText } from '../../src/core/payment-uri.mjs';
import { formatConn, parseWatchAddress } from './model.mjs';
import { createReceiveRequest, RECEIVE_METADATA_NOTICE } from './receive-request.mjs';
import { DEFAULT_CLAIMS_POLICY, evaluateClaimsPolicy } from './claims-policy.mjs';
import { WatchSession } from './session.mjs';
import { nativeActionState, nativeControlState } from './native-controls.mjs';
import './styles.css';

const $ = id => document.getElementById(id);
const native = Capacitor.getPlatform() === 'android';
const wallet = registerPlugin('NativeWallet');
const PUBLIC_PROFILE = 'connectwallet.mobile.alpha.public-profile.v1';
let environment = { active: true, connected: false, connectionType: 'unknown' };
let policy = { ...DEFAULT_CLAIMS_POLICY };
let page = 'overview', saving = Promise.resolve(), ready = false;
let receiveAddress = '', receiveKey = '', receiveRevision = 0, receiveTimer;
let receiveRequest = null;
let vault = { exists: false, locked: true, account: null };
let claims = null, polling = false, nativeBusy = false;

$('brand-icon').src = icon;
$('preview-notice').hidden = native;
$('receive-metadata-notice').textContent = RECEIVE_METADATA_NOTICE;
const amountGuard = installAmountInputRestrictions(document, { onReject: () => {
  $('receive-error').textContent = 'Use digits and one decimal separator, with up to 10 decimal places. Nothing was pasted.';
} });
const textGuard = installTextInputRestrictions(document, { onReject: ({ limit }) => {
  $('receive-error').textContent = `Keep this field within ${limit} characters. Nothing was pasted.`;
} });

const session = new WatchSession({
  query: async (method, params) => {
    if (!native) throw Object.assign(new Error('Android required'), { code: 'UNAVAILABLE' });
    const response = await wallet.queryPublic({ method, params });
    return response.result;
  },
  // Results are generation-guarded by WatchSession. Do not cancel the shared
  // native transport here: an explicitly enabled claims session also uses it.
  cancelAll: async () => {},
  onChange: render,
});

// Preferences contains PUBLIC data only, never a password, seed or private key.
// Serialize writes so a slow save cannot resurrect an address after removal.
function persist() {
  const value = JSON.stringify({ version: 1, address: session.state.address,
    allowMobileData: policy.allowMobileData, allowBackground: policy.allowBackground });
  saving = saving.catch(() => {}).then(() => Preferences.set({ key: PUBLIC_PROFILE, value }));
  saving.catch(() => { $('global-error').textContent = 'Could not save these public preferences on this device.'; });
  return saving;
}

function renderClaims() {
  const controls = nativeControlState({ native, address: session.state.address, claims, locked: vault.locked, busy: nativeBusy });
  const status = evaluateClaimsPolicy({ enabled: claims?.enabled === true, ...policy, connected: environment.connected,
    connectionType: environment.connectionType, appActive: environment.active,
    nativeClaimsAvailable: native, nativeBackgroundAvailable: native, platform: Capacitor.getPlatform() });
  $('mobile-data').checked = policy.allowMobileData;
  $('background').checked = policy.allowBackground;
  $('claims-status').textContent = !native ? 'Preview · native claims not available' : claims ? `${claims.policyStatus} · ${claims.status}` : status.reason;
  $('start-claims').disabled = controls.startDisabled;
  $('stop-claims').disabled = controls.stopDisabled;
  for (const key of ['attempts', 'valid', 'invalid', 'targetHits', 'submitted', 'unknown', 'connectionsPerSecond', 'eligible']) {
    const value = claims?.[key]; $('claims-' + key).textContent = Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '0';
  }
  $('claims-domain').textContent = claims?.currentDomain ? `Current domain: ${claims.currentDomain}` : '';
  $('claims-discovery').textContent = claims?.totalBlocks ? `Discovery: ${claims.discoveredBlocks}/${claims.totalBlocks} blocks${claims.discoveryComplete ? ' · complete' : ' · claims can run during discovery'}` : '';
  $('claims-error').textContent = claims?.lastError || '';
  $('claims-receipt').hidden = !claims?.receiptTxid;
  $('claims-receipt').textContent = claims?.receiptTxid ? `${claims.receiptStatus}: ${claims.receiptTxid}` : '';
  $('check-claim').hidden = !claims || !['pending', 'unknown'].includes(claims.receiptStatus);
}

function renderVault() {
  const owns = vault.account?.address === session.state.address;
  $('account-kind').textContent = owns ? 'NATIVE WALLET · FIRST ADDRESS' : 'WATCH-ONLY ACCOUNT';
  $('vault-status').textContent = !vault.exists ? 'Create or import a native wallet first.' : vault.locked ? 'Wallet locked. Unlock to review a payment.' : 'Unlocked · first receiving address only';
  $('open-native-wallet').hidden = !vault.exists;
  $('create-wallet').disabled = !native || vault.exists || nativeBusy;
  $('import-wallet').disabled = !native || vault.exists || nativeBusy;
  $('unlock-wallet').disabled = !native || !vault.exists || nativeBusy;
  $('lock-wallet').disabled = nativeControlState({ native, locked: vault.locked, busy: nativeBusy }).lockDisabled;
  $('review-payment').disabled = !native || vault.locked || !owns || nativeBusy;
  $('receive-ownership').textContent = owns ? 'This is the first receiving address of your native wallet. Keep your recovery backup safe.' : 'Watching an address does not give access to its funds. Confirm ownership before receiving.';
}

async function nativeAction(action, options = {}, { adoptAddress = false } = {}) {
  const control = nativeActionState(action, native, nativeBusy);
  if (!control.allowed) return;
  if (control.ownsBusy) nativeBusy = true;
  renderVault(); renderClaims(); $('global-error').textContent = '';
  try {
    const result = await wallet[action](options);
    vault = await wallet.getState();
    if (adoptAddress && vault.account?.address) {
      // Local unlock is complete. Let the independently guarded public refresh
      // finish without holding native controls hostage to the network timeout.
      void session.watch(parseWatchAddress(vault.account.address));
      await persist();
    }
    return result;
  } catch (error) { $('global-error').textContent = error.message || 'Native operation could not complete.'; }
  finally { if (control.ownsBusy) nativeBusy = false; renderVault(); renderClaims(); await pollNative(); }
}

async function pollNative() {
  if (!native || polling || !environment.active) return;
  polling = true;
  try {
    const [info, counters] = await Promise.all([wallet.getState(), wallet.claimsState()]);
    vault = info; claims = counters.state;
    policy = { allowMobileData: claims.allowMobileData === true, allowBackground: claims.allowBackground === true };
    renderVault(); renderClaims();
  } catch { /* Keep the last snapshot; never fake counters or restart a session. */ }
  finally { polling = false; }
}

function render(state) {
  $('setup-panel').hidden = Boolean(state.address);
  $('wallet-panel').hidden = !state.address;
  $('current-address').textContent = state.address;
  $('receive-address').textContent = state.address;
  $('connection-status').textContent = !native ? 'Preview · no live RPC' : !environment.active ? 'Paused · app is in the background'
    : !environment.connected ? 'Offline · refresh when reconnected' : `${environment.connectionType === 'cellular' ? 'Mobile data' : environment.connectionType === 'wifi' ? 'Wi-Fi' : 'Network connected'} · foreground only`;
  $('refresh').disabled = state.busy || !environment.active || !environment.connected;
  $('refresh').textContent = state.busy ? 'Loading…' : 'Refresh';
  $('balance').textContent = state.balance ? formatConn(state.balance.confirmed) : '—';
  $('pending').textContent = state.balance
    ? `Pending in: ${formatConn(state.balance.pending_received)} · Pending out: ${formatConn(state.balance.pending_spent)} · Immature: ${formatConn(state.balance.immature)} CONN`
    : 'Refresh to load balances';
  $('block-height').textContent = state.tip ? `Block ${state.tip.height.toLocaleString('en-US')}` : '';
  $('wallet-error').textContent = state.error;
  $('last-update').textContent = state.updatedAt ? `${state.stale ? 'Last known balance · ' : 'Balance checked at '}${new Date(state.updatedAt).toLocaleTimeString('en-US')}. Refresh to check for changes.` : '';
  $('empty-history').hidden = state.history.length > 0;
  $('empty-history').textContent = state.updatedAt ? 'No activity in this history page.' : 'No history loaded yet.';
  $('load-more').hidden = !state.cursor;
  $('load-more').disabled = state.busy || !environment.active || !environment.connected;
  const rows = state.history.map(item => {
    const row = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = BigInt(item.balance_delta) < 0n ? 'Sent' : BigInt(item.balance_delta) > 0n ? 'Received' : 'Transaction';
    const amount = document.createElement('span'); amount.className = 'amount'; amount.textContent = `${formatConn(item.balance_delta)} CONN`;
    const status = document.createElement('span'); status.className = 'state'; status.textContent = item.status === 'pending' ? 'Unconfirmed' : `${item.confirmations} confirmations`;
    const txid = document.createElement('span'); txid.className = 'txid'; txid.textContent = item.txid;
    row.append(label, amount, status, txid); return row;
  });
  $('history').replaceChildren(...rows);
  $('history-limit').hidden = state.history.length < 2000;
  if (state.address !== receiveAddress) {
    receiveAddress = state.address;
    for (const id of ['receive-amount', 'receive-label', 'receive-message']) $(id).value = '';
    amountGuard.sync(); textGuard.sync();
    updateReceive();
  }
  if (!state.address) showPage('overview');
  renderClaims();
  renderVault();
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
  page = next;
  for (const name of ['overview', 'receive', 'send', 'claims']) $(name).hidden = name !== page;
  for (const button of document.querySelectorAll('[data-page]')) {
    if (button.dataset.page === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

$('watch-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!ready) return;
  $('setup-error').textContent = '';
  let address;
  try { address = parseWatchAddress($('watch-address').value); }
  catch { $('setup-error').textContent = 'Enter a valid mainnet ConnectCoin public address or "connectcoin:" payment link.'; return; }
  $('watch-address').value = '';
  $('copy-status').textContent = '';
  const pending = session.watch(address);
  persist().catch(() => {});
  await pending;
});
$('forget').addEventListener('click', () => { session.forget(); $('copy-status').textContent = ''; persist().catch(() => {}); });
$('refresh').addEventListener('click', () => { session.refresh(); });
$('load-more').addEventListener('click', () => { session.refresh({ more: true }); });
for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => showPage(button.dataset.page));
for (const [id, name] of [['mobile-data', 'allowMobileData'], ['background', 'allowBackground']]) {
  $(id).addEventListener('change', async () => {
    policy[name] = $(id).checked;
    if (native) {
      try { claims = (await wallet.claimsPolicy(policy)).state; }
      catch (error) { $('claims-error').textContent = error.message; await pollNative(); }
    }
    renderClaims(); persist().catch(() => {});
  });
}
for (const [id, action] of [['create-wallet', 'create'], ['import-wallet', 'importRecovery'], ['unlock-wallet', 'unlock'], ['open-native-wallet', 'unlock'], ['lock-wallet', 'lock']]) {
  $(id).addEventListener('click', () => nativeAction(action, {}, { adoptAddress: action !== 'lock' }));
}
$('start-claims').addEventListener('click', () => nativeAction('claimsStart', { address: session.state.address }));
$('stop-claims').addEventListener('click', () => nativeAction('claimsStop'));
$('check-claim').addEventListener('click', () => nativeAction('claimsCheckSubmission'));
$('send-form').addEventListener('submit', async event => {
  event.preventDefault(); $('send-status').textContent = '';
  const amount = $('send-amount').value.replace(',', '.').replace(/\.$/, '');
  const result = await nativeAction('reviewPayment', { address: $('send-address').value.trim(), amount });
  if (result?.txid) $('send-status').textContent = `${result.status}: ${result.txid}${result.message ? ` · ${result.message}` : ''}`;
});
$('paste-payment').addEventListener('click', async () => {
  try {
    const parsed = parseClipboardPaymentText(await navigator.clipboard.readText());
    $('send-address').value = parseWatchAddress(parsed.address);
    $('send-amount').value = parsed.amount || '';
    amountGuard.sync(); $('send-status').textContent = '';
  } catch { $('send-status').textContent = 'Copy a valid ConnectCoin address or "connectcoin:" payment link.'; }
});
$('copy-link').addEventListener('click', async () => {
  if (!receiveRequest || receiveRequest.address !== session.state.address) return;
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
  await Network.addListener('networkStatusChange', status => {
    environment = { ...environment, connected: status.connected, connectionType: status.connectionType };
    session.setEnvironment(environment); renderClaims();
  });
  await App.addListener('appStateChange', ({ isActive }) => {
    environment.active = isActive; session.setEnvironment(environment);
  });
  if (native) await App.addListener('backButton', () => {
    if (page !== 'overview') showPage('overview');
    else App.minimizeApp().catch(() => { $('global-error').textContent = 'Could not minimize the app. Use the system Home gesture.'; });
  });
  const status = await Network.getStatus();
  environment = { ...environment, connected: status.connected, connectionType: status.connectionType };
  if (native) environment.active = (await App.getState()).isActive;
  else environment.active = !document.hidden;
  session.setEnvironment(environment);
  document.addEventListener('visibilitychange', () => {
    environment.active = !document.hidden; session.setEnvironment(environment);
  });
  const { value } = await Preferences.get({ key: PUBLIC_PROFILE });
  if (value) {
    try {
      if (value.length > 1024) throw new Error('Oversized preference');
      const profile = JSON.parse(value);
      if (profile.version !== 1) throw new Error('Unsupported preferences');
      policy = { allowMobileData: profile.allowMobileData === true, allowBackground: profile.allowBackground === true };
      renderClaims();
      if (profile.address) void session.watch(parseWatchAddress(profile.address));
    } catch { $('global-error').textContent = 'Saved public preferences could not be loaded. Add your public address again.'; }
  }
  render(session.state);
  await pollNative();
  if (native) setInterval(pollNative, 1000);
}
start().catch(() => { $('global-error').textContent = 'Could not initialize device services. Restart the app to try again.'; })
  .finally(() => { ready = true; $('watch-address').disabled = false; $('watch-submit').disabled = false; });
