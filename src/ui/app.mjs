import { acknowledgePreferences, createPreferenceSaver, preferenceBatch } from './preferences.mjs';
import { reconcileChildren } from './reconcile.mjs';

const $ = selector => document.querySelector(selector);
const app = $('#app');
const dialog = $('#modal');
const bridge = window.connectwallet;
const paths = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  send:'<path d="m7 17 10-10M7 7h10v10"/>',receive:'<path d="m17 7-10 10M7 7v10h10"/>',
  globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6.5h14M5 17.5h14"/>',
  activity:'<path d="M3 12h4l3-7 4 14 3-7h4"/>',settings:'<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
  refresh:'<path d="M20 8a8 8 0 0 0-14-2L3 9m0-5v5h5m-4 7a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',back:'<path d="M20 12H4m6-6-6 6 6 6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',check:'<path d="m5 12 4 4L19 6"/>',
  warning:'<path d="m10.3 4.2-8 14A1.8 1.8 0 0 0 4 21h16a1.8 1.8 0 0 0 1.7-2.8l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v5m0 3v.1"/>',
  spark:'<path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z"/>',
  eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  connection:'<path d="M5 10a10 10 0 0 1 14 0M8 13a6 6 0 0 1 8 0m-5 3a2 2 0 0 1 2 0M2 7a14 14 0 0 1 20 0"/><circle cx="12" cy="19" r=".7"/>',
  key:'<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-5-5 3-3m-1 5 3-3"/>',
  external:'<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
};
const e = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.globe}</svg>`;
const mark = () => '<img class="connectwallet-mark" src="../../assets/icon.png" alt="" aria-hidden="true" draggable="false">';
const brand = () => `<div class="brand"><div class="brand-mark">${mark()}</div><div><strong>ConnectWallet</strong><small>By ConnectCoin</small></div></div>`;
const orb = () => '<svg viewBox="0 0 240 240" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><circle cx="120" cy="120" r="96"/><circle cx="120" cy="120" r="73"/><ellipse cx="120" cy="120" rx="36" ry="96"/><ellipse cx="120" cy="120" rx="73" ry="96"/><ellipse cx="120" cy="120" rx="96" ry="36"/><ellipse cx="120" cy="120" rx="96" ry="73"/><path d="M24 120h192M120 24v192"/><circle cx="193" cy="82" r="5" class="orb-lime"/><circle cx="74" cy="183" r="4" class="orb-violet"/></svg>';
const format = value => {
  if (value == null || value === '') return '—';
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return '—';
  const fraction = match[3]?.replace(/0+$/, '');
  return `${match[1]}${match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
};
const cc = value => `${format(value)} CONN`;
const compactHash = value => value ? `${value.slice(0, 9)}…${value.slice(-7)}` : '—';
const notice = (text, type = '') => `<div class="notice ${type}">${icon(type === 'danger' ? 'warning' : 'shield')}<div>${text}</div></div>`;
let state = { phase: 'welcome', network: { status: 'disconnected', chain: 'testnet4' }, config: { theme: 'system', rpc: { host: 'connectcoin4.com', port: 48190 }, claims: { maxConnectionsPerSecond: 100, maxConcurrent: 100, lookbackBlocks: 600 } } };
let view = 'overview';
let sendMode = 'address';
let sendReviewSequence = 0;
let authView = 'welcome';
let setup = null;
let replacement = null;
let busy = false;
let locking = false;
const emptySend = () => ({ address: '', domain: '', amount: '', expectedConnections: '1000' });
let draft = { send: emptySend(), claims: {}, settings: {} };
let rpcDraftReady = false;
const preferences = createPreferenceSaver({
  snapshot: () => preferenceBatch(state.config, draft, { rpcReady: rpcDraftReady }),
  save: patch => invoke('saveConfig', patch),
  saved: (next, batch) => {
    acknowledgePreferences(draft, batch);
    document.querySelectorAll('.inline-error[data-error-source="preferences"]').forEach(target => {
      target.textContent = ''; target.classList.add('hidden'); delete target.dataset.errorSource;
    });
    if (!Object.hasOwn(draft.settings, 'host') && !Object.hasOwn(draft.settings, 'port')) rpcDraftReady = false;
    if (next) acceptState(next, { background: true });
  },
  failed: error => showError(new Error(`Settings were not saved. ${errorMessage(error)} Your edits are retained; edit the setting again to retry.`), 'preferences'),
  blocked: () => busy || locking || compositionActive,
});
let historyFilter = 'all';
let toastTimer, secretTimer;
let currentPreview;
let modalKind;
let unsubscribe;
let renderTimer = null;
let pointerActive = false;
let actionKeyActive = false;
let compositionActive = false;
let lastShellMarkup = null;
let lastShellView = null;
let rendering = false;

function scheduleRender() {
  if (renderTimer !== null) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    // Do not replace a pressed button before its click/keyboard activation.
    // Keep only the latest state; no queue of obsolete DOM updates.
    if (pointerActive || actionKeyActive || compositionActive) { scheduleRender(); return; }
    render();
  }, 200);
}

function toast(message) {
  clearTimeout(toastTimer);
  const target = $('#toast'); target.textContent = message; target.classList.add('show');
  toastTimer = setTimeout(() => target.classList.remove('show'), 4000);
}
function errorMessage(error) { return error?.message || 'Something went wrong. Please try again.'; }
function showError(error, source = '') {
  const message = errorMessage(error);
  const container = dialog.open ? $('#modal-error') : $('#view-error');
  if (container) { container.textContent = message; container.classList.remove('hidden'); container.setAttribute('role', 'alert'); container.dataset.errorSource = source; }
  else toast(message);
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('[data-busy]').forEach(button => { button.disabled = value || locking || button.dataset.unavailable === 'true'; });
  app.setAttribute('aria-busy', String(value || locking));
}
async function invoke(method, payload = {}) {
  if (!bridge?.invoke) throw new Error('Open ConnectWallet in the desktop app to use your wallet.');
  return bridge.invoke(method, payload);
}
async function run(operation) {
  if (busy || locking) return;
  document.querySelectorAll('.inline-error').forEach(target => { target.textContent = ''; target.classList.add('hidden'); });
  setBusy(true);
  try { rpcDraftReady = true; await preferences.flush(); await operation(); } catch (error) { showError(error); } finally { setBusy(false); }
}
async function reload() { acceptState(await invoke('getState')); }
async function lockWallet() {
  // Security actions must reach main even while a normal RPC/review action is
  // pending. Keep that action's busy state and independently guard repeat locks.
  if (locking || state.phase !== 'unlocked') return;
  locking = true; closeModal(); setBusy(busy);
  try { await invoke('lock'); rpcDraftReady = true; await preferences.flush(); await reload(); }
  catch (error) { showError(error); }
  finally { locking = false; setBusy(busy); }
}
function themePreference(config = state.config) {
  return ['system', 'light', 'dark'].includes(config?.theme) ? config.theme : 'system';
}
function applyTheme() {
  document.documentElement.dataset.theme = themePreference();
}
function acceptState(next, { background = false } = {}) {
  if (!next || typeof next !== 'object' || !['welcome', 'locked', 'unlocked'].includes(next.phase)) return;
  const previous = state.phase;
  const importantChange = next.error !== state.error ||
    (state.claims?.enabled && !next.claims?.enabled) ||
    (next.claims?.lastError && !next.claims.lastErrorDiagnostic &&
      !next.claims.lastErrorTransient && next.claims.lastError !== state.claims?.lastError);
  const securityChanged = state.securityEpoch !== undefined && next.securityEpoch !== state.securityEpoch;
  // A new security context must never retain live controls/drafts from the old
  // wallet, even if both snapshots happen to report an unlocked phase.
  if (securityChanged) { lastShellMarkup = null; lastShellView = null; }
  const replacementEnded = Boolean(replacement && (next.replacementActive !== true || next.phase !== 'locked' || securityChanged));
  const clearSetup = Boolean(setup && next.setupActive === false) || securityChanged || replacementEnded;
  if (clearSetup) {
    if (replacementEnded || securityChanged) replacement = null;
    setup = null; authView = 'welcome'; draft.send = emptySend(); closeModal();
    document.querySelectorAll('input[name="password"], input[name="passwordConfirm"], textarea[name="mnemonic"]').forEach(field => { field.value = ''; });
  }
  state = { ...next, config: { ...next.config, theme: themePreference(next.config) } };
  // Theme changes must apply even while welcome/locked forms keep their DOM.
  applyTheme();
  if (next.phase === 'locked' && previous !== 'locked') { setup = null; draft.send = emptySend(); closeModal(); }
  if (next.phase === 'unlocked' && previous !== 'unlocked') { setup = null; authView = 'welcome'; closeModal(); }
  if (!clearSetup && previous === next.phase && next.phase !== 'unlocked' && app.children.length && !$('.boot')) return;
  if (background && previous === next.phase && !securityChanged && !clearSetup && !importantChange) scheduleRender();
  else render();
}
const errorSlot = () => '<div id="view-error" class="inline-error hidden" role="alert"></div>';
const title = { overview: 'Overview', send: 'Send', receive: 'Receive', claims: 'Automatic claims', activity: 'Activity', settings: 'Settings' };
function pageHeading(heading, description, action = '') {
  return `<div class="page-heading"><div><h1>${heading}</h1><p>${description}</p></div>${action}</div>`;
}
function online() { return ['connected', 'ready', 'online', 'synced'].includes(state.network?.status); }
function render() {
  rendering = true;
  clearTimeout(renderTimer); renderTimer = null;
  const scrollX = window.scrollX, scrollY = window.scrollY;
  const diagnosticScroll = $('.diagnostic-list')?.scrollTop;
  const focused = document.activeElement;
  const focusId = focused?.id;
  const start = focused?.selectionStart;
  const end = focused?.selectionEnd;
  if (state.phase === 'unlocked') renderShell();
  else {
    lastShellMarkup = null;
    lastShellView = null;
    if (setup && ['backup', 'verify'].includes(authView)) renderBackup();
    else renderAuth();
  }
  if (focusId && !focused.isConnected) {
    const replacement = document.getElementById(focusId);
    if (replacement) { replacement.focus({ preventScroll: true }); if (typeof replacement.setSelectionRange === 'function' && start != null) { try { replacement.setSelectionRange(start, end); } catch { /* number/select input */ } } }
  }
  setBusy(busy);
  window.scrollTo(scrollX, scrollY);
  if (diagnosticScroll != null && $('.diagnostic-list')) $('.diagnostic-list').scrollTop = diagnosticScroll;
  rendering = false;
}
function updateShell(markup) {
  // Unrelated claim progress must not rebuild Activity, Settings or a form.
  if (markup === lastShellMarkup) return;
  if (lastShellMarkup === null || lastShellView !== view) app.innerHTML = markup;
  else {
    const template = document.createElement('template');
    template.innerHTML = markup;
    reconcileChildren(app, template.content);
  }
  lastShellMarkup = markup;
  lastShellView = view;
}
function renderShell() {
  const wallet = state.wallet ?? {};
  const network = state.network ?? {};
  updateShell(`<div class="shell"><aside class="sidebar">${brand()}<div class="nav-label">YOUR WALLET</div><nav class="nav" aria-label="Main navigation">${Object.entries(title).map(([name, label]) => `<button class="nav-button ${view === name ? 'active' : ''}" data-view="${name}" title="${label}" ${view === name ? 'aria-current="page"' : ''}>${icon({overview:'grid',send:'send',receive:'receive',claims:'globe',activity:'activity',settings:'settings'}[name])}<span>${label}</span></button>`).join('')}</nav><div class="sidebar-bottom"><div class="testnet-note"><div class="label"><span class="dot online"></span> A space to experiment</div><p>You’re on ConnectCoin testnet. These coins have no promised monetary value.</p></div><div class="sidebar-foot"><span>Made for connection.</span><button class="icon-button" data-action="lock" title="Lock wallet" aria-label="Lock wallet">${icon('lock')}</button></div></div></aside><main class="workspace"><header class="topbar"><div class="breadcrumb"><span>Your workspace</span><span class="separator">/</span><strong>${title[view]}</strong></div><div class="top-actions"><div class="network-pill"><span class="dot ${online() ? 'online' : ''}"></span>${e(network.chain ?? 'testnet4')} · ${online() ? 'Connected' : e(network.status ?? 'Connecting')}</div><button class="icon-button" data-action="refresh" title="Refresh wallet" aria-label="Refresh wallet">${icon('refresh')}</button><div class="profile" title="${e(wallet.name ?? 'My wallet')}">${e((wallet.name ?? 'My wallet').slice(0, 2).toUpperCase())}</div></div></header>${state.error ? `<div class="page-error">${notice(e(typeof state.error === 'string' ? state.error : state.error.message), 'danger')}</div>` : ''}${errorSlot()}<div id="page">${({ overview: overview, send: sendPage, receive: receivePage, claims: claimsPage, activity: activityPage, settings: settingsPage })[view]()}</div><footer class="bottom-strip"><span>${icon('shield')} Your keys stay on this device.</span><span>${icon('connection')}${network.height != null ? `Block ${e(Number(network.height).toLocaleString('en-US'))}` : 'Waiting for network'}<span aria-hidden="true">·</span> ${e(network.host ?? state.config?.rpc?.host ?? '')}</span></footer></main></div>`);
}
function overview() {
  const balance = state.wallet?.balance ?? {};
  return `${pageHeading('A little more connected.', 'Your coins, your keys. A simpler way to explore ConnectCoin.', `<button class="text-button" data-action="external" data-url="https://connectcoincrypto.com/">Explore ConnectCoin ${icon('external')}</button>`)}<div class="dashboard-grid"><section class="card balance-card" aria-label="Wallet balance"><div class="card-top"><span class="caption">Available balance</span><span class="coin-mark">${mark()} CONNECTCOIN</span></div><div class="balance-number">${e(format(balance.available))}<span class="currency">CONN</span></div><p class="balance-sub">${e(state.wallet?.name ?? 'Your wallet')} <span aria-hidden="true">·</span> Testnet funds</p><div class="balance-actions"><button class="button" data-view="send">${icon('send')} Send coins</button><button class="button secondary" data-view="receive">${icon('receive')} Receive</button></div><div class="balance-details"><div class="balance-detail"><label>Confirmed</label><strong>${e(cc(balance.confirmed))}</strong></div><div class="balance-detail"><label>Pending</label><strong>${e(cc(balance.pending))}</strong></div></div></section><section class="card claims-promo"><div class="eyebrow">${icon('spark')} A DIFFERENT WAY TO PARTICIPATE</div><h2>Make connections.<br>Collect rewards.</h2><p>Explore Pay-to-Connect bounties. Let your wallet look for eligible HTTPS connection proofs.</p><button class="button lime" data-view="claims">${state.config?.claims?.enabled ? 'Manage automatic claims' : 'Explore automatic claims'} ${icon('arrow')}</button><div class="promo-foot">${icon('shield')} Optional. Always in your control.</div><div class="orbit-art">${orb()}</div></section></div><div class="section-heading"><h2>Recent activity</h2><button class="text-button" data-view="activity">View all activity ${icon('arrow')}</button></div>${activityTable((state.history ?? []).slice(0, 5))}<div class="footer-links"><button data-action="external" data-url="https://discord.gg/JYWbz5PsPp">Join the community ↗</button><button data-action="external" data-url="https://connectcoincrypto.com/whitepaper.pdf">Read the whitepaper ↗</button></div>`;
}
function activityTable(items) {
  if (!items.length) return '<section class="card activity-card"><div class="activity-head"><span>Transaction</span><span>Transaction ID</span><span>Amount</span><span>Status</span></div><div class="empty-state"><div class="empty-icon">'+icon('activity')+'</div><h3>Your story starts here.</h3><p>Receive your first testnet coins or explore automatic claims. Your transactions will appear here.</p></div></section>';
  return `<section class="card activity-card"><div class="activity-head"><span>Transaction</span><span>Transaction ID</span><span>Amount</span><span>Status</span></div>${items.map(item => {
    const incoming = ['received','receive','incoming','claim'].includes(item.direction) || (!item.direction && !String(item.amount).startsWith('-'));
    const pending = item.status === 'pending' || item.confirmations === 0;
    const direction = item.direction === 'claim' ? 'P2C claim' : item.direction === 'self' ? 'Self transfer' : incoming ? 'Received' : 'Sent';
    return `<div class="activity-row"><div class="activity-type"><div class="round-icon ${incoming ? 'receive' : ''}">${icon(incoming ? 'receive' : 'send')}</div><div><strong>${direction}</strong><small>${pending ? 'Awaiting confirmation' : `${e(item.confirmations ?? '—')} confirmations`}</small></div></div><div class="transaction-hash" title="${e(item.txid)}">${e(compactHash(item.txid))}</div><div class="amount ${incoming ? 'positive' : ''}">${incoming && !String(item.amount).startsWith('-') ? '+' : item.direction === 'sent' && !String(item.amount).startsWith('-') ? '−' : ''}${e(cc(item.amount))}</div><span class="status-badge ${pending ? 'pending' : ''}">${pending ? 'Pending' : 'Confirmed'}</span></div>`;
  }).join('')}</section>`;
}
function sendPage() {
  const values = { ...draft.send, feeRate: draft.settings.feeRate ?? state.config?.feeRate ?? 1500 };
  const bounty = sendMode === 'bounty';
  return `${pageHeading('Send a little connection.', 'Simple payments, signed privately on your device.')}<div class="form-layout"><section class="card form-card"><div class="send-modes filter-tabs" aria-label="Payment type"><button type="button" class="filter-tab ${bounty ? '' : 'active'}" data-send-mode="address" aria-pressed="${!bounty}">To an address</button><button type="button" class="filter-tab ${bounty ? 'active' : ''}" data-send-mode="bounty" aria-pressed="${bounty}">Create a bounty</button></div><h2>${bounty ? 'Pay for a connection.' : 'Send ConnectCoin'}</h2><p class="card-description">${bounty ? 'Create a public Pay-to-Connect reward. Anyone with an eligible proof can claim it.' : 'Make sure the destination is a ConnectCoin testnet address.'}</p><form id="send-form">${bounty ? `<label class="field"><span class="field-label">HTTPS website domain</span><input class="input address-input" id="send-domain" data-draft="send.domain" name="domain" value="${e(values.domain)}" placeholder="example.com" autocomplete="off" spellcheck="false" required><p class="field-help">Enter only the domain, without https://, a path or a port.</p></label>` : `<label class="field"><span class="field-label">Recipient address</span><input class="input address-input" id="send-address" data-draft="send.address" name="address" value="${e(values.address)}" placeholder="Paste a ConnectCoin address" autocomplete="off" spellcheck="false" required></label>`}<label class="field"><span class="field-label">${bounty ? 'Bounty reward' : 'Amount'} <small>Available: ${e(cc(state.wallet?.balance?.available))}</small></span><div class="input-row"><input class="input" id="send-amount" data-draft="send.amount" name="amount" value="${e(values.amount)}" placeholder="0.00" inputmode="decimal" autocomplete="off" required><span class="input-suffix">CONN</span></div></label>${bounty ? `<label class="field"><span class="field-label">Expected candidate evaluations</span><input class="input" id="send-expected" data-draft="send.expectedConnections" name="expectedConnections" value="${e(values.expectedConnections)}" inputmode="numeric" autocomplete="off" required><p class="field-help">Sets the hash target. For example, 1,000 means one qualifying candidate per 1,000 on average—not a guaranteed connection count. Only the qualifying proof goes on-chain.</p></label>` : ''}<details class="advanced-fee"><summary class="text-button">Advanced fee settings</summary><label class="field"><span class="field-label">Fee rate <small>connects / virtual byte</small></span><input class="input" id="send-fee" data-draft="settings.feeRate" name="feeRate" value="${e(values.feeRate)}" type="number" min="1201" max="100000" step="1" inputmode="numeric" required><p class="field-help">Saved automatically for future payments. 10,000,000,000 connects = 1 CONN. The exact network fee is shown before you confirm.</p></label></details><div class="form-divider"></div>${notice(bounty ? 'You are funding a public bounty, not paying the website directly. Review the domain, reward and fee before confirming.' : 'You’ll review the destination, amount and exact fee before anything is sent.', 'info')}<div class="form-actions"><button class="button" data-busy type="submit">${bounty ? 'Review bounty' : 'Review payment'} ${icon('arrow')}</button></div></form></section><section class="card"><h3>${bounty ? 'More off-chain. Less on-chain.' : 'A quick confidence check.'}</h3><ul class="tip-list">${bounty ? `<li>${icon('globe')}<div><strong>You choose the website</strong><p>Claimers connect to the specified HTTPS domain and produce cryptographic evidence.</p></div></li><li>${icon('spark')}<div><strong>You choose the hash target</strong><p>A harder target increases the expected number of candidates. They do not each need their own blockchain transaction.</p></div></li><li>${icon('shield')}<div><strong>One eligible proof claims the reward</strong><p>Nodes validate the claim. This does not prove a human visited a page or guarantee website traffic, SEO, or a fixed number of connections.</p></div></li>` : `<li>${icon('shield')}<div><strong>Keep your recovery phrase private</strong><p>You never need to share it to send or receive a payment.</p></div></li><li>${icon('check')}<div><strong>Check the entire address</strong><p>Payments cannot be reversed once confirmed. Compare the destination with your recipient.</p></div></li><li>${icon('globe')}<div><strong>You’re using testnet</strong><p>Only send to compatible ConnectCoin testnet addresses, not Bitcoin or other networks.</p></div></li>`}</ul></section></div>`;
}
function receivePage() {
  const address = state.wallet?.address;
  const qr = state.wallet?.qrDataUrl;
  return `${pageHeading('Good things come your way.', 'Share your public address. Keep your recovery phrase to yourself.')}<section class="card receive-card">${typeof qr === 'string' && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(qr) ? `<img class="qr" src="${e(qr)}" alt="QR code for your ConnectCoin receiving address">` : `<div class="receive-emblem">${mark()}</div>`}<h2>Your receiving address</h2><p class="card-description">ConnectCoin · ${e(state.network?.chain ?? 'testnet4')}</p><div class="address-box">${e(address ?? 'Your receiving address will appear here.')}</div><button class="button" data-action="copy-address" data-busy data-unavailable="${!address}" ${address ? '' : 'disabled'}>${icon('copy')} Copy address</button><button class="button secondary" data-action="new-address" data-busy>${icon('refresh')} New address</button>${notice('Send only ConnectCoin testnet coins to this address. Your public address is safe to share; your recovery phrase is not.')}</section>`;
}
function diagnosticPanel() {
  const diagnostics = state.diagnostics;
  if (state.config?.developerMode !== true || !diagnostics) return '';
  const recent = Array.isArray(diagnostics.recent) ? diagnostics.recent.slice(-50).reverse() : [];
  return `<section class="card diagnostics-card" aria-label="Local diagnostics"><div class="card-top"><h2>Recent diagnostic errors</h2><button class="text-button" data-action="open-diagnostics">Open log folder ${icon('external')}</button></div><p class="card-description">The last 50 errors from this app session stay here even after claiming continues. Full diagnostics are saved locally, with UTC timestamps and automatic file rotation. No recovery words, passwords, addresses or transaction contents are logged.</p>${diagnostics.status === 'unavailable' ? notice('The diagnostic log could not be written. Recent errors are available in memory only; check folder permissions and free disk space.', 'danger') : ''}${diagnostics.dropped ? notice(`${e(diagnostics.dropped)} diagnostic records could not be saved. The history may be incomplete.`) : ''}<p class="diagnostic-path">${e(diagnostics.file ?? '')}</p>${recent.length ? `<ol class="diagnostic-list">${recent.map(row => {
    const details = row.details ?? {}, error = details.error ?? {};
    const metadata = [details.stage, details.method, details.claimId != null ? `claim #${details.claimId}` : null, error.code != null ? `RPC/OS ${error.code}` : null, error.nodeCode != null ? `node ${error.nodeCode}` : null, Number.isFinite(details.durationMs) ? `${details.durationMs.toFixed(1)} ms` : null].filter(value => value != null);
    return `<li><div class="diagnostic-meta"><time>${e(row.timestamp)}</time><span>${e(row.event)}</span></div><strong>${e(error.message ?? 'Operation failed; see the diagnostic log.')}</strong><p>${e(metadata.join(' · '))}</p></li>`;
  }).join('')}</ol>` : '<p class="card-description">No diagnostic errors recorded in this session.</p>'}</section>`;
}
function claimsPage() { return claimsControlsPage() + diagnosticPanel(); }
function claimsControlsPage() {
  const config = { maxConnectionsPerSecond: 100, maxConcurrent: 100, lookbackBlocks: 600, ...state.config?.claims, ...draft.claims };
  const claims = state.claims ?? {};
  const enabled = state.config?.claims?.enabled === true;
  const high = Number(config.maxConnectionsPerSecond) > 100 || Number(config.maxConcurrent) > 100;
  return `${pageHeading('Every connection has potential.', 'Discover Pay-to-Connect bounties without running a full node.')}<div class="claim-control"><div><h3>Automatic claims</h3><p>${enabled ? (claims.enabled ? 'Your wallet is looking for eligible proofs. Claims pause while locked and resume automatically when you unlock.' : 'Enabled for this wallet. Claims resume when the wallet is unlocked and its connection is ready. Check any alert below.') : 'Off until you choose. Your choice is saved, including after restarting the app.'}</p></div><button class="switch ${enabled ? 'on' : ''}" role="switch" aria-checked="${enabled}" aria-label="Enable automatic claims" data-action="toggle-claims" data-busy><span></span></button></div><div class="stat-grid"><div class="stat-card"><div class="caption">Connection attempts</div><strong>${e(claims.attempts == null ? '—' : Number(claims.attempts).toLocaleString('en-US'))}</strong></div><div class="stat-card"><div class="caption">Bounties queued</div><strong>${e(claims.available == null ? '—' : Number(claims.available).toLocaleString('en-US'))}</strong></div><div class="stat-card"><div class="caption">Claims submitted</div><strong>${e(claims.sent == null ? '—' : Number(claims.sent).toLocaleString('en-US'))}</strong></div></div><div class="form-layout"><section class="card form-card"><div class="card-top"><h2>Your pace. Your limits.</h2><span class="status-badge ${claims.enabled ? '' : 'pending'}">${e(claims.status ?? (claims.enabled ? 'Active' : 'Paused'))}</span></div><p class="card-description">Valid changes save automatically. Connection capacity depends on your device, router and internet provider.</p>${claims.helperAvailable === false ? notice('<strong>Automatic Claims helper not installed.</strong> Install the optional helper with <span class="inline-code">npm run setup:claims</span>, or use a desktop package that includes it. Payments and receiving still work.') : ''}${claims.lastError && (state.config?.developerMode === true || claims.lastErrorDiagnostic !== true) ? notice(e(claims.lastError), 'danger') : ''}<form id="claims-form"><div class="two-fields"><label class="field"><span class="field-label">Maximum starts per second</span><input class="input" id="claims-rate" name="maxConnectionsPerSecond" data-draft="claims.maxConnectionsPerSecond" type="number" min="1" max="256" step="1" value="${e(config.maxConnectionsPerSecond)}" required></label><label class="field"><span class="field-label">Maximum simultaneous connections</span><input class="input" id="claims-concurrent" name="maxConcurrent" data-draft="claims.maxConcurrent" type="number" min="1" max="256" step="1" value="${e(config.maxConcurrent)}" required></label></div><div id="claims-warning" class="${high ? '' : 'hidden'}">${notice('<strong>High connection load.</strong> Values above 100 can saturate your router or ISP connection, interrupt other apps, and burden destination websites. Increase cautiously.', 'danger')}</div><label class="field"><span class="field-label">Look back through recent blocks <small>1–600</small></span><input class="input" id="claims-lookback" name="lookbackBlocks" data-draft="claims.lookbackBlocks" type="number" min="1" max="600" step="1" value="${e(config.lookbackBlocks)}" required><p class="field-help">This light-wallet server exposes only the last 600 blocks. Larger windows may include older, less useful “trash bounties”; unlimited history isn’t available through this API.</p></label></form></section><section class="card"><h3>Not CPU mining.</h3><ul class="tip-list"><li>${icon('globe')}<div><strong>Connect to eligible websites</strong><p>Bounties specify a domain and proof requirements. A successful connection does not guarantee a reward.</p></div></li><li>${icon('shield')}<div><strong>Submit cryptographic evidence</strong><p>The wallet prepares a claim. Network nodes validate the proof and transaction.</p></div></li><li>${icon('lock')}<div><strong>Stay in control</strong><p>Stop whenever you like. Claims use bandwidth and network fees. No CPU miner runs in this wallet.</p></div></li></ul></section></div>`;
}
function activityPage() {
  const items = (state.history ?? []).filter(item => historyFilter === 'all' || (historyFilter === 'pending' ? item.status === 'pending' || item.confirmations === 0 : item.status !== 'pending' && item.confirmations > 0));
  return `${pageHeading('Your activity, at a glance.', 'A clear record of your ConnectCoin payments and claims.')}<div class="section-heading"><h2>Transaction history</h2><div class="filter-tabs" aria-label="Filter transaction history">${['all','pending','confirmed'].map(name => `<button class="filter-tab ${historyFilter === name ? 'active' : ''}" data-filter="${name}" aria-pressed="${historyFilter === name}">${name[0].toUpperCase()+name.slice(1)}</button>`).join('')}</div></div>${activityTable(items)}`;
}
function developerSettings() {
  const enabled = state.config?.developerMode === true;
  return `<section class="card form-card"><div class="setting-row"><div><h2>Developer Mode</h2><p id="developer-mode-description">Show recoverable claim rejection warnings and the Recent diagnostic errors panel in Automatic claims.</p></div><button id="developer-mode" class="switch ${enabled ? 'on' : ''}" role="switch" aria-checked="${enabled}" aria-label="Developer Mode" aria-describedby="developer-mode-description" data-action="toggle-developer-mode" data-busy><span></span></button></div><p class="field-help">Off by default. Local diagnostic logging stays active in either mode. Important connection, security and stopped-claim alerts remain visible.</p></section>`;
}
function settingsPage() {
  const rpc = { host: 'connectcoin4.com', port: 48190, ...state.config?.rpc, ...draft.settings };
  const autoLockMinutes = draft.settings.autoLockMinutes ?? state.config?.autoLockMinutes ?? 15;
  return `${pageHeading('Make yourself at home.', 'Your connection, your security, your preferences.')}<div class="settings-stack"><section class="card form-card appearance-row"><div><h2>Appearance</h2><p class="card-description" id="theme-description">Make this space feel like yours. System follows your device’s light or dark appearance automatically.</p></div><label class="field appearance-field"><span class="field-label">Color theme</span><select class="select" id="theme-preference" aria-describedby="theme-description" data-busy>${[['system','System (default)'],['light','Light'],['dark','Dark']].map(([value,label]) => `<option value="${value}" ${themePreference() === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></section><section class="card form-card"><h2>Network connection</h2><p class="card-description">Changes save automatically. The server reconnects when you finish editing its hostname and port.</p><form id="settings-form"><div class="two-fields"><label class="field"><span class="field-label">Server hostname or IP</span><input class="input" id="rpc-host" name="host" data-draft="settings.host" value="${e(rpc.host)}" spellcheck="false" autocomplete="off" required></label><label class="field"><span class="field-label">TCP port</span><input class="input" id="rpc-port" name="port" data-draft="settings.port" type="number" min="1" max="65535" value="${e(rpc.port)}" required></label></div><label class="field"><span class="field-label">Lock after inactivity <small>Minutes · 1–60</small></span><input class="input" id="auto-lock" name="autoLockMinutes" data-draft="settings.autoLockMinutes" type="number" min="1" max="60" step="1" value="${e(autoLockMinutes)}" required></label>${notice('<strong>This connection is not encrypted.</strong> Queried addresses and transactions can be observed or altered in transit. The server supplies balances, transaction history and bounty data; this is not independent full-node verification. Use a server you trust.')}</form></section><section class="card form-card"><h2>Security & backup</h2><p class="card-description">Your recovery phrase controls your coins. Keep an offline copy somewhere safe.</p><div class="setting-row"><div><strong>Recovery phrase</strong><p>View your words privately. Your wallet password is required.</p></div><button class="button secondary" data-action="recovery">${icon('key')} View recovery phrase</button></div><div class="setting-row"><div><strong>Encrypted wallet backup</strong><p>Save an encrypted copy of this wallet. Keep the password separately.</p></div><button class="button secondary" data-action="export" data-busy>${icon('file')} Export wallet</button></div><div class="setting-row"><div><strong>Lock your wallet</strong><p>Enabled automatic claims pause while locked and resume when you unlock. Wallet locks after ${e(state.config?.autoLockMinutes ?? 15)} minutes of inactivity.</p></div><button class="button secondary" data-action="lock">${icon('lock')} Lock now</button></div></section>${developerSettings()}<section class="card"><h3>ConnectWallet, by ConnectCoin.</h3><p class="card-description">A lighter way to participate. Built for ConnectCoin testnet.</p><div class="footer-links"><button data-action="external" data-url="https://connectcoincrypto.com/">ConnectCoin ↗</button><button data-action="external" data-url="https://discord.gg/JYWbz5PsPp">Community ↗</button><button data-action="external" data-url="https://explorer.connectcoincrypto.com/">Block explorer ↗</button></div></section></div>`;
}
function passwordField(id, label, confirm = false) {
  const existing = id === 'unlock-password' || id === 'recovery-password';
  return `<label class="field"><span class="field-label">${label}</span><div class="password-row"><input class="input" id="${id}" name="${confirm ? 'passwordConfirm' : 'password'}" type="password" autocomplete="${existing ? 'current-password' : 'new-password'}" required ${existing ? '' : 'minlength="12"'}><button class="icon-button" type="button" data-action="show-password" data-target="${id}" aria-label="Show password">${icon('eye')}</button></div></label>`;
}
function renderAuth() {
  let content;
  if (state.phase === 'locked' && !replacement) content = `<div class="lock-icon">${icon('lock')}</div><div class="eyebrow">WELCOME BACK</div><h2>Your wallet. Your space.</h2><p class="card-description">Unlock ${e(state.wallet?.name ?? 'your wallet')} to pick up where you left off.</p>${errorSlot()}<form class="auth-form" id="unlock-form">${passwordField('unlock-password','Wallet password')}<button class="button full" type="submit" data-busy>Unlock wallet ${icon('arrow')}</button></form><p class="field-help">Your password unlocks this device’s encrypted wallet. It is not your recovery phrase.</p><div class="auth-actions recovery-actions"><button class="button secondary full" type="button" data-action="forgot-password">Forgot password?</button><button class="text-button" type="button" data-action="replace-wallet">Use another wallet</button></div>`;
  else if (authView === 'create' || authView === 'restore') {
    const restore = authView === 'restore';
    const recovering = replacement?.mode === 'recover';
    content = `<button class="back-button" data-action="auth-back">${icon('back')} Back</button><div class="eyebrow">${restore ? 'A FAMILIAR PLACE' : 'LET’S GET YOU STARTED'}</div><h2>${recovering ? 'Restore access to your wallet.' : restore ? 'Welcome home.' : 'A wallet of your own.'}</h2><p class="card-description">${restore ? 'Restore with your 12, 18 or 24 recovery words. Your new password protects this device only.' : 'Give your wallet a name and protect it with a password. Next, we’ll back up your recovery words.'}</p>${replacement ? notice('Your current wallet stays untouched until you finish. Its encrypted file will be preserved in <strong>wallet-backups</strong>; that copy still needs its original password. A different recovery phrase opens a different wallet.') : ''}${errorSlot()}<form class="auth-form" id="${restore ? 'restore' : 'create'}-form"><label class="field"><span class="field-label">Wallet name</span><input class="input" name="name" id="setup-name" placeholder="My ConnectCoin wallet" maxlength="40" required></label>${restore ? '<label class="field"><span class="field-label">Recovery phrase</span><textarea class="textarea" id="restore-phrase" name="mnemonic" spellcheck="false" autocomplete="off" autocapitalize="none" placeholder="Enter your words in order, separated by spaces" required></textarea></label>' : '<div class="field-label">Recovery phrase length</div><div class="choice-row">'+[12,18,24].map(count => `<label class="choice"><input type="radio" name="wordCount" value="${count}" ${count === 24 ? 'checked' : ''}><span>${count} words</span></label>`).join('')+'</div>'}${passwordField('setup-password','Create a password')}${passwordField('setup-confirm','Confirm password',true)}<p class="field-help">Use at least 12 characters. This is an encryption password, not an additional BIP39 passphrase.</p><div class="form-actions"><button class="button full" data-busy type="submit">${recovering ? 'Restore wallet and reset password' : restore ? 'Restore wallet' : 'Create recovery phrase'} ${icon('arrow')}</button></div></form>`;
  } else if (replacement) content = `<button class="back-button" data-action="cancel-replacement">${icon('back')} Keep current wallet</button><div class="eyebrow">A FRESH WORKSPACE</div><h2>Choose your next wallet.</h2><p class="card-description">Create a new wallet or restore one with its recovery phrase. Your current wallet will not be replaced until you finish.</p>${errorSlot()}<div class="auth-actions"><button class="button full" data-action="auth-create">Create a new wallet ${icon('arrow')}</button><button class="button secondary full" data-action="auth-restore">I already have a recovery phrase</button></div>${notice('The previous encrypted wallet will be kept in <strong>wallet-backups</strong>. It still needs its original password. Creating another wallet does not transfer or recover funds from the previous one.')}`;
  else content = `<div class="eyebrow">CONNECTCOIN, A LITTLE CLOSER.</div><h2>Hello, connection.</h2><p class="card-description">A calm home for your ConnectCoin. Send, receive and explore Pay-to-Connect — without a full node.</p>${errorSlot()}<div class="auth-actions"><button class="button full" data-action="auth-create">Create a new wallet ${icon('arrow')}</button><button class="button secondary full" data-action="auth-restore">I already have a recovery phrase</button></div>${notice('<strong>Welcome to testnet.</strong> This is experimental software. Start with test coins, keep your recovery phrase safe, and never share it.')}<div class="footer-links"><button data-action="external" data-url="https://connectcoincrypto.com/">Meet ConnectCoin ↗</button><button data-action="external" data-url="https://discord.gg/JYWbz5PsPp">Need a hand? ↗</button></div>`;
  app.innerHTML = `<div class="auth-shell"><section class="auth-art">${brand()}<div><h1>A beautiful way<br>to <em>connect.</em></h1><p>A little less complexity.<br>A little more possibility.<br>Your ConnectCoin journey starts here.</p></div><div class="auth-art-footer">YOUR KEYS. YOUR COINS. YOUR CONNECTION.</div><div class="auth-orb">${orb()}</div></section><main class="auth-card-wrap"><div class="auth-content">${content}</div></main></div>`;
}
function renderBackup() {
  const verify = authView === 'verify';
  app.innerHTML = `<main class="backup-wrap"><div class="backup-top">${brand()}<span class="backup-progress">${verify ? '02 / VERIFY' : '01 / BACK UP'}</span></div><div class="backup-intro"><h1>${verify ? 'A small check. A safer future.' : 'These words are your wallet.'}</h1><p>${verify ? 'Enter the words below from your offline backup. This makes sure you can recover your wallet when you need it.' : 'Write every word down, in this exact order. Keep the list offline and private. Anyone with these words can access your coins.'}</p></div>${errorSlot()}${verify ? `<form id="verify-form"><div class="check-grid">${setup.checkIndexes.map(index => `<label class="field"><span class="field-label">Word #${index + 1}</span><input class="input" name="word-${index}" id="check-${index}" autocomplete="off" spellcheck="false" autocapitalize="none" required></label>`).join('')}</div>${notice('We will never ask you to enter your recovery phrase on a website or send it to support.','info')}<div class="backup-footer"><button class="back-button" type="button" data-action="backup-back">${icon('back')} Check my words again</button><button class="button" type="submit" data-busy>Open my wallet ${icon('arrow')}</button></div></form>` : `${notice('<strong>No screenshots. No chat messages. No cloud notes.</strong> A private, offline backup is the safest place for these words.')}<div class="seed-grid">${setup.words.map((word,index) => `<div class="seed-word"><span>${index+1}</span>${e(word)}</div>`).join('')}</div><div class="backup-footer"><label class="checkbox"><input id="backup-ack" type="checkbox"> I’ve written all ${setup.words.length} words down in order and stored them somewhere private.</label><button class="button" data-action="backup-next" data-busy>Verify my backup ${icon('arrow')}</button></div>`}<div class="form-divider"></div><button class="back-button" data-action="cancel-setup">${icon('back')} Cancel wallet creation</button></main>`;
}
function openModal(heading, description, body, kind) {
  clearTimeout(secretTimer); modalKind = kind;
  dialog.innerHTML = `<div class="modal-heading"><h2 id="modal-title">${heading}</h2><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><p class="modal-description">${description}</p><div id="modal-error" class="inline-error hidden" role="alert"></div>${body}`;
  if (!dialog.open) dialog.showModal();
}
function closeModal() {
  sendReviewSequence++;
  clearTimeout(secretTimer); currentPreview = null; modalKind = null;
  if (dialog.open) dialog.close();
  dialog.innerHTML = '';
}
function cancelSendReview() {
  closeModal();
  void invoke('cancelSendPreview').catch(showError);
}
function requestReplacement(mode) {
  const recovering = mode === 'recover';
  openModal(recovering ? 'Restore access to your wallet.' : 'Use another wallet.',
    recovering ? 'You need your original 12, 18 or 24 recovery words. There is no password reset by email or support.' : 'You can create a new wallet or import another recovery phrase on this device.',
    `${notice('<strong>Your current wallet is not removed now.</strong> Only after a valid restoration or a verified new backup will ConnectWallet preserve the old encrypted file in <strong>wallet-backups</strong> and replace the active wallet.')}<p class="field-help">The preserved copy still needs its original password. Without your recovery words or another working access method, starting over does not recover the old funds.</p><label class="checkbox recovery-confirm"><input id="replacement-ack" type="checkbox"> I understand that another wallet has different keys and the preserved encrypted copy still needs its original password.</label><div class="modal-actions"><button class="button secondary" data-action="close-modal">Cancel</button><button class="button" data-action="begin-replacement" data-mode="${mode}" data-busy data-unavailable="true" disabled>Continue</button></div>`, 'replacement');
}
async function cancelReplacement() {
  const next = await invoke('cancelWalletReplacement');
  replacement = null; setup = null; authView = 'welcome';
  closeModal(); acceptState(next); render();
}
function sendReview(preview) {
  const bounty = preview.type === 'p2c';
  if (bounty && (![6, 7].includes(preview.signatureAlgorithmsMask) || !['verified', 'failed', 'timeout', 'unavailable', 'busy'].includes(preview.rsaProbeStatus) || (preview.signatureAlgorithmsMask === 6) !== (preview.rsaProbeStatus === 'verified'))) {
    throw new Error('Incomplete bounty signature policy. Review the bounty again.');
  }
  const policy = bounty ? `<div class="review-line"><dt>Allowed signatures</dt><dd>${preview.signatureAlgorithmsMask === 6 ? 'RSA-PSS / SHA-256 only' : 'ECDSA P-256 + RSA-PSS / SHA-256'} (mask ${preview.signatureAlgorithmsMask})</dd></div>` : '';
  const fallback = { unavailable: 'The TLS helper is unavailable.', timeout: 'The RSA check timed out.', busy: 'The RSA checker is busy.', failed: 'RSA support could not be confirmed.' };
  const probeNotice = bounty ? notice(preview.rsaProbeStatus === 'verified'
    ? '<strong>RSA support verified.</strong> This bounty will accept only the two supported RSA-PSS schemes. The check confirms one server’s current capability, not future availability or every server behind this domain.'
    : `<strong>${fallback[preview.rsaProbeStatus]}</strong> All supported signature schemes remain allowed. This is not confirmation that the website can produce a valid P2C proof.`, preview.rsaProbeStatus === 'verified' ? 'info' : 'warning') : '';
  currentPreview = preview;
  openModal('One final look.', 'Check every detail. Nothing will be broadcast until you confirm.', `<dl><div class="review-line address"><dt>${bounty ? 'Bounty domain' : 'Sending to'}</dt><dd>${e(preview.address)}</dd></div><div class="review-line"><dt>${bounty ? 'Public reward' : 'Amount'}</dt><dd>${e(cc(preview.amount))}</dd></div>${bounty ? `<div class="review-line"><dt>Expected candidates</dt><dd>${e(preview.expectedConnections)}</dd></div>${policy}` : ''}<div class="review-line"><dt>Network fee</dt><dd>${e(cc(preview.fee))}</dd></div><div class="review-line review-total"><dt>Total</dt><dd>${e(cc(preview.total))}</dd></div></dl>${probeNotice}${notice(bounty ? 'This public reward can be spent by any eligible claimer. It is not a payment to the domain owner. Confirmed transactions cannot be reversed.' : 'This payment is on ConnectCoin testnet. Confirmed payments cannot be reversed.')}<div class="modal-actions"><button class="button secondary" data-action="close-modal">Go back</button><button class="button" data-action="confirm-send" data-busy>${bounty ? 'Create bounty' : 'Confirm & send'} ${icon('send')}</button></div>`, 'send');
}

document.addEventListener('input', event => {
  const target = event.target;
  if (target.id === 'replacement-ack') {
    const button = $('[data-action="begin-replacement"]');
    if (button) { button.dataset.unavailable = String(!target.checked); button.disabled = busy || !target.checked; }
  }
  if (target.dataset.draft) {
    const [section, key] = target.dataset.draft.split('.');
    if (Object.hasOwn(draft, section)) draft[section][key] = target.value;
    if (section === 'settings' && ['host', 'port'].includes(key)) rpcDraftReady = false;
    else if (['claims', 'settings'].includes(section)) preferences.schedule();
  }
  if (target.id === 'claims-rate' || target.id === 'claims-concurrent') $('#claims-warning')?.classList.toggle('hidden', !(Number($('#claims-rate').value) > 100 || Number($('#claims-concurrent').value) > 100));
});
document.addEventListener('focusout', event => {
  if (rendering || !['rpc-host', 'rpc-port'].includes(event.target.id) || ['rpc-host', 'rpc-port'].includes(event.relatedTarget?.id)) return;
  rpcDraftReady = true; preferences.schedule(0);
});
document.addEventListener('change', event => {
  if (event.target.id !== 'theme-preference') return;
  const preference = event.target.value;
  if (busy || !['system', 'light', 'dark'].includes(preference)) {
    event.target.value = themePreference();
    return;
  }
  void run(async () => {
    try {
      // Appearance does not reconnect the server, restart claims, or clear drafts.
      acceptState(await invoke('setTheme', { theme: preference }));
    } finally {
      const selector = $('#theme-preference');
      if (selector) selector.value = themePreference();
    }
  });
});
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button?.dataset.action === 'lock') { void lockWallet(); return; }
  if (button && modalKind === 'send-preparing' && ['close-modal', 'cancel-send-review'].includes(button.dataset.action)) { cancelSendReview(); return; }
  if (!button || busy || locking) return;
  if (button.dataset.view && state.phase === 'unlocked') { rpcDraftReady = true; preferences.schedule(0); view = button.dataset.view; render(); return; }
  if (button.dataset.sendMode) { sendMode = button.dataset.sendMode; render(); return; }
  if (button.dataset.filter) { historyFilter = button.dataset.filter; render(); return; }
  const action = button.dataset.action;
  if (!action) return;
  if (action === 'auth-create' || action === 'auth-restore') { authView = action.slice(5); render(); return; }
  if (action === 'auth-back') {
    if (replacement?.mode === 'recover') void run(cancelReplacement);
    else { authView = 'welcome'; render(); }
    return;
  }
  if (action === 'forgot-password' || action === 'replace-wallet') { requestReplacement(action === 'forgot-password' ? 'recover' : 'switch'); return; }
  if (action === 'show-password') {
    const field = document.getElementById(button.dataset.target); field.type = field.type === 'password' ? 'text' : 'password';
    button.setAttribute('aria-label', field.type === 'password' ? 'Show password' : 'Hide password'); return;
  }
  if (action === 'close-modal') { if (modalKind === 'send') cancelSendReview(); else closeModal(); return; }
  if (action === 'backup-back') { authView = 'backup'; render(); return; }
  if (action === 'backup-next') {
    if (!$('#backup-ack')?.checked) { showError(new Error('Please confirm you’ve written down and safely stored your recovery phrase.')); return; }
    authView = 'verify'; render(); return;
  }
  if (action === 'recovery') {
    openModal('Your recovery phrase.', 'Find a private place. Anyone who sees these words can control your coins.', `<form id="recovery-form">${passwordField('recovery-password','Wallet password')}<div class="modal-actions"><button class="button secondary" type="button" data-action="close-modal">Cancel</button><button class="button" type="submit" data-busy>Reveal words ${icon('key')}</button></div></form>`, 'recovery'); return;
  }
  void run(async () => {
    switch (action) {
      case 'begin-replacement': {
        if (!$('#replacement-ack')?.checked) throw new Error('Please confirm you understand how wallet recovery and replacement work.');
        const mode = button.dataset.mode;
        const prepared = await invoke('beginWalletReplacement', { mode });
        const next = await invoke('getState');
        if (!next.replacementActive || next.replacementMode !== mode || typeof prepared.replacementId !== 'string') throw new Error('Wallet replacement was cancelled. Please start again.');
        acceptState(next); replacement = { replacementId: prepared.replacementId, mode };
        setup = null; authView = mode === 'recover' ? 'restore' : 'welcome'; closeModal(); render(); break;
      }
      case 'cancel-replacement': await cancelReplacement(); break;
      case 'refresh': await invoke('refresh'); await reload(); toast('Wallet refreshed.'); break;
      case 'open-diagnostics': await invoke('openDiagnostics'); break;
      case 'toggle-developer-mode': await invoke('setDeveloperMode', { enabled: state.config?.developerMode !== true }); await reload(); toast(`Developer Mode ${state.config?.developerMode ? 'enabled' : 'disabled'}.`); break;
      case 'external': await invoke('openExternal', { url: button.dataset.url }); break;
      case 'copy-address': await invoke('copyAddress'); toast('Public address copied.'); break;
      case 'new-address': {
        const result = await invoke('newAddress');
        await reload();
        if (typeof result === 'string' || result?.address) { state.wallet = { ...state.wallet, address: result.address ?? result, qrDataUrl: result.qrDataUrl ?? state.wallet?.qrDataUrl }; render(); }
        toast('New receiving address ready.'); break;
      }
      case 'export': {
        const result = await invoke('exportWallet'); if (result?.cancelled !== true) toast('Encrypted wallet backup exported.'); break;
      }
      case 'cancel-setup': await invoke('cancelSetup'); setup = null; authView = 'welcome'; render(); break;
      case 'confirm-send': {
        if (!currentPreview?.previewId) throw new Error('Payment preview expired. Please review the payment again.');
        await invoke('confirmSend', { previewId: currentPreview.previewId }); closeModal();
        draft.send = emptySend(); view = 'activity'; await reload(); toast('Payment submitted to the network.'); break;
      }
      case 'toggle-claims': {
        await invoke('setClaims', { enabled: state.config?.claims?.enabled !== true });
        await reload(); toast(state.config?.claims?.enabled ? 'Automatic claims enabled. They resume when you unlock.' : 'Automatic claims disabled.'); break;
      }
    }
  });
});
document.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  if (busy || locking || !form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  void run(async () => {
    switch (form.id) {
      case 'create-form':
      case 'restore-form': {
        const replacementId = replacement?.replacementId;
        if (values.password !== values.passwordConfirm) throw new Error('Your passwords don’t match. Please check them.');
        if (values.password.length < 12) throw new Error('Use a password with at least 12 characters.');
        if (form.id === 'create-form') {
          const securityEpoch = state.securityEpoch;
          const prepared = await invoke('prepareWallet', { name: values.name.trim(), password: values.password, wordCount: Number(values.wordCount), ...(replacementId ? { replacementId } : {}) });
          if (state.securityEpoch !== securityEpoch) throw new Error('Wallet was locked during setup. Start again when you are ready.');
          const words = Array.isArray(prepared.mnemonic) ? prepared.mnemonic : String(prepared.mnemonic ?? '').trim().split(/\s+/);
          if (!prepared.setupId || ![12,18,24].includes(words.length) || !Array.isArray(prepared.checkIndexes) || prepared.checkIndexes.length !== 3 || prepared.checkIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= words.length)) throw new Error('Could not prepare a safe recovery backup. Please try again.');
          setup = { setupId: prepared.setupId, words, checkIndexes: prepared.checkIndexes }; authView = 'backup'; form.reset(); render();
        } else {
          const mnemonic = values.mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
          if (![12,18,24].includes(mnemonic.split(' ').length)) throw new Error('Enter exactly 12, 18 or 24 recovery words.');
          await invoke('restoreWallet', { name: values.name.trim(), password: values.password, mnemonic, ...(replacementId ? { replacementId } : {}) });
          form.reset(); await reload();
          toast(replacementId ? 'Wallet restored. Previous encrypted wallet preserved in wallet-backups.' : 'Your wallet is restored.');
        }
        values.password = ''; values.passwordConfirm = ''; values.mnemonic = ''; break;
      }
      case 'verify-form': {
        const answers = Object.fromEntries(setup.checkIndexes.map(index => [index, String(values[`word-${index}`]).trim().toLowerCase()]));
        await invoke('confirmWallet', { setupId: setup.setupId, answers }); setup = null; form.reset(); await reload(); toast('Your wallet is ready. Welcome to ConnectCoin.'); break;
      }
      case 'unlock-form': await invoke('unlock', { password: values.password }); form.reset(); values.password = ''; await reload(); break;
      case 'send-form': {
        const amount = values.amount.trim();
        if (!/^\d+(?:\.\d{1,10})?$/.test(amount) || !/[1-9]/.test(amount)) throw new Error('Enter a positive amount, with up to 10 decimal places.');
        if (!/^\d+$/.test(values.feeRate) || Number(values.feeRate) <= 0) throw new Error('Enter a positive whole-number fee rate.');
        if (sendMode === 'bounty' && !/^[1-9]\d*$/.test(values.expectedConnections.trim())) throw new Error('Expected candidates must be a positive whole number.');
        const destination = sendMode === 'bounty' ? { domain: values.domain.trim(), expectedConnections: values.expectedConnections.trim() } : { address: values.address.trim() };
        const sequence = ++sendReviewSequence;
        if (sendMode === 'bounty') openModal('Preparing your bounty.', 'Checking funds and the website’s RSA support. The TLS check has a three-second deadline and sends no HTTP request.', '<p role="status">Please wait for the signature policy before confirming.</p><div class="modal-actions"><button class="button secondary" data-action="cancel-send-review">Cancel</button></div>', 'send-preparing');
        try {
          const preview = await invoke('previewSend', { ...destination, amount, feeRate: Number(values.feeRate) });
          if (sequence === sendReviewSequence && state.phase === 'unlocked') sendReview(preview);
        } catch (error) {
          if (sequence === sendReviewSequence) {
            if (modalKind === 'send-preparing') closeModal();
            throw error;
          }
        }
        break;
      }
      case 'claims-form': {
        await reload(); toast('Connection settings saved.'); break;
      }
      case 'settings-form':
        if (['host', 'port'].some(key => Object.hasOwn(draft.settings, key))) throw new Error('Enter a valid server hostname or IP address and a port between 1 and 65535.');
        await reload(); toast('Connection settings saved.'); break;
      case 'recovery-form': {
        const securityEpoch = state.securityEpoch;
        const result = await invoke('getRecoveryPhrase', { password: values.password }); form.reset(); values.password = '';
        if (state.phase !== 'unlocked' || state.securityEpoch !== securityEpoch) throw new Error('Wallet locked. Unlock it before viewing recovery words.');
        const words = String(result?.mnemonic ?? result).trim().split(/\s+/);
        openModal('For your eyes only.', 'Write these words down in order. This view closes automatically after 45 seconds.', `${notice('Never share your phrase, paste it into a website, or send it to support.')}<div class="seed-grid modal-seed-grid">${words.map((word,index) => `<div class="seed-word"><span>${index + 1}</span>${e(word)}</div>`).join('')}</div><button class="button full" data-action="close-modal">Hide recovery phrase ${icon('lock')}</button>`, 'secret');
        secretTimer = setTimeout(closeModal, 45000); break;
      }
    }
  });
});
dialog.addEventListener('cancel', event => {
  event.preventDefault();
  if (modalKind === 'send-preparing' || (!busy && modalKind === 'send')) cancelSendReview();
  else if (!busy) closeModal();
});
document.addEventListener('keydown', event => {
  if (['Enter', ' '].includes(event.key) && event.target.closest('button, select')) actionKeyActive = true;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l' && state.phase === 'unlocked') { event.preventDefault(); void lockWallet(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    void run(async () => { window.location.reload(); });
  }
});
document.addEventListener('keyup', () => { actionKeyActive = false; });
document.addEventListener('pointerdown', () => { pointerActive = true; }, { capture: true });
document.addEventListener('pointerup', () => { pointerActive = false; }, { capture: true });
document.addEventListener('pointercancel', () => { pointerActive = false; });
document.addEventListener('compositionstart', () => { compositionActive = true; });
document.addEventListener('compositionend', () => { compositionActive = false; });
window.addEventListener('blur', () => { pointerActive = false; actionKeyActive = false; compositionActive = false; });
document.addEventListener('visibilitychange', () => { if (document.hidden && modalKind === 'secret') closeModal(); });
window.addEventListener('beforeunload', () => { unsubscribe?.(); setup = null; replacement = null; currentPreview = null; clearTimeout(secretTimer); clearTimeout(renderTimer); });

render();
if (bridge?.onState) unsubscribe = bridge.onState(next => acceptState(next, { background: true }));
if (bridge?.onBeforeClose) bridge.onBeforeClose(async () => { rpcDraftReady = true; await preferences.flush(); });
if (bridge?.invoke) void invoke('getState').then(next => { state = { ...state, phase: '' }; acceptState(next); }).catch(showError);
else showError(new Error('Desktop preview only. Wallet actions are available in the ConnectWallet app.'));
