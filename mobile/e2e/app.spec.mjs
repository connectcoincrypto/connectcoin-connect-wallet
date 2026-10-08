import { test, expect } from '@playwright/test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import QRCode from 'qrcode';

const address = bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.toBytes(true).slice(1))]);
const otherAddress = bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.double().toBytes(true).slice(1))]);
const changeAddress = bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.multiply(3n).toBytes(true).slice(1))]);
const hdAccounts = [
  { address, index: 0, change: 0, network: 'main', path: "m/44'/0'/0'/0/0" },
  { address: otherAddress, index: 1, change: 0, network: 'main', path: "m/44'/0'/0'/0/1" },
  { address: changeAddress, index: 0, change: 1, network: 'main', path: "m/44'/0'/0'/1/0" },
];
const testnet = bech32m.encode('tcc', [1, ...bech32m.toWords(secp256k1.Point.BASE.toBytes(true).slice(1))]);
const profileKey = 'CapacitorStorage.connectwallet.mobile.alpha.public-profile.v1';
const publicSnapshotKey = `CapacitorStorage.connectwallet.mobile.public-snapshot.mainnet.v2.connectcoin4.com%3A48190.${address}`;
const confirmedHistory = {
  txid: 'b'.repeat(64), status: 'confirmed', block_height: 121, block_hash: 'c'.repeat(64),
  confirmations: 3, received: '10000000000', spent: '0', balance_delta: '10000000000',
};
const pendingHistory = {
  txid: 'd'.repeat(64), status: 'pending', block_height: null, block_hash: null,
  confirmations: 0, received: '10000000000', spent: '0', balance_delta: '10000000000',
};

async function waitReady(page) {
  await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
}

async function fakeNative(page, options = {}) {
  // This bridge exists exclusively in Playwright's isolated browser context.
  // No app flag, bundled backdoor, secret fixture, real RPC or native signer.
  await page.addInitScript(({ address, hdAccounts, options, profileKey }) => {
    const clone = value => JSON.parse(JSON.stringify(value));
    const account = value => value == null ? null : ({ address: value, index: 0, change: 0, network: 'main', path: "m/44'/0'/0'/0/0" });
    const native = window.testNative = {
      calls: [], listeners: {}, deferredMethods: { ...options.deferredMethods }, pendingResponses: [],
      settings: { theme: 'dark', autoLockMinutes: 0, rpcHost: 'connectcoin4.com', rpcPort: 48190, ...options.settings },
      settingsError: options.settingsError ?? null, failSettingsRead: options.failSettingsRead === true,
      clipboardText: options.clipboardText ?? '', cancelPendingOnLock: options.cancelPendingOnLock === true,
      scanResult: options.scanResult ?? { cancelled: true }, scanError: options.scanError ?? null,
      explorerError: options.explorerError ?? null,
      paymentBatch: options.paymentBatch ?? JSON.parse(localStorage.getItem('TEST_ONLY_NATIVE_PAYMENT_BATCH') || 'null'),
      paymentBatchError: options.paymentBatchError ?? null, dismissBatchError: null,
      exportError: options.exportError ?? null, exportResult: options.exportResult ?? { exported: true },
      securityErrors: { ...options.securityErrors }, recoveryViewResult: options.recoveryViewResult ?? { viewed: true },
      importError: options.importError ?? null, imports: [],
      pendingPaymentLink: options.initialPaymentLink ?? null,
      vault: { exists: options.exists !== false, locked: options.locked === true,
        account: account(Object.hasOwn(options, 'accountAddress') ? options.accountAddress : address),
        accountScope: 'first-receive-address', lastPayment: options.lastPayment ?? null },
      unlockAddress: options.unlockAddress || address,
      rpcUnavailable: options.rpcUnavailable === true,
      watchConnected: options.watchConnected, historyFailures: options.historyFailures || 0,
      history: options.history ?? [],
      hdHistoryByAddress: options.hdHistoryByAddress ?? {}, hdUtxosByAddress: options.hdUtxosByAddress ?? {},
      hdChanges: options.hdChanges ?? [], journalSequence: options.journalSequence ?? 0,
      watchCoverage: options.watchCoverage ?? null, recoveryError: null,
      balance: options.balance ?? { confirmed: '10000000000', immature: '0', available_confirmed: '10000000000', pending_received: '0',
        pending_spent: '0', pending_delta: '0', total: '10000000000' },
      claims: { enabled: false, requested: false, running: false, policyStatus: 'stopped', status: 'stopped',
        allowMobileData: false, allowBackground: false, backgroundService: false,
        attempts: 0, valid: 0, invalid: 0, targetHits: 0, submitted: 0, unknown: 0,
        connectionsPerSecond: 0, connectionsPerSecondLimit: 100, concurrency: 100, activeConnections: 0,
        eligible: 0, currentDomain: '', lastError: '', receiptTxid: '', receiptStatus: '', ...options.claims },
      emit(plugin, eventName, value) { for (const listener of this.listeners[`${plugin}:${eventName}`] || []) listener(value); },
      setPaymentLink(value) {
        this.pendingPaymentLink = value;
        this.emit('NativePaymentInput', 'paymentLinkAvailable', {});
      },
      setAccount(value, locked = false) {
        if (this.vault.accountScope === 'hd-wallet' && value === this.vault.walletId) {
          this.vault = { ...this.vault, exists: true, locked }; return;
        }
        this.vault = { ...this.vault, exists: value !== null, account: account(value), locked };
      },
      setHd(changes) { Object.assign(this.vault, clone(changes)); },
      response(method, value) {
        const snapshot = clone(value);
        if (!this.deferredMethods[method]) return snapshot;
        delete this.deferredMethods[method];
        return new Promise((resolve, reject) => this.pendingResponses.push({ method,
          resolve: () => resolve(snapshot), reject: () => reject(Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' })),
        }));
      },
      releaseResponses() { for (const pending of this.pendingResponses.splice(0)) pending.resolve(); },
      cancelResponses(methods) {
        this.pendingResponses = this.pendingResponses.filter(pending => {
          if (!methods.includes(pending.method)) return true;
          pending.reject(); return false;
        });
      },
    };
    if (options.hd) {
      const accounts = clone(options.hdAccounts ?? hdAccounts);
      const current = accounts.find(item => item.change === 0 && item.index === (options.hd?.receiveIndex ?? 0));
      Object.assign(native.vault, { accountScope: 'hd-wallet', walletId: accounts.find(item => item.change === 0 && item.index === 0).address,
        account: current, accounts,
        hd: { complete: true, recovering: false, scanned: accounts.length, receiveIndex: current.index, changeIndex: 0,
          ...(typeof options.hd === 'object' ? options.hd : {}) } });
    }
    if (options.legacyAddress && !sessionStorage.getItem('testLegacyProfileSeeded')) {
      localStorage.setItem(profileKey, JSON.stringify({ version: 1, address: options.legacyAddress, allowMobileData: false, allowBackground: false }));
      sessionStorage.setItem('testLegacyProfileSeeded', 'true');
    }
    const savedClaims = localStorage.getItem('TEST_ONLY_NATIVE_CLAIMS_POLICY');
    if (savedClaims) Object.assign(native.claims, JSON.parse(savedClaims));
    const savedLimits = localStorage.getItem('TEST_ONLY_NATIVE_CLAIMS_LIMITS');
    if (savedLimits) Object.assign(native.claims, JSON.parse(savedLimits));
    const savedSettings = localStorage.getItem('TEST_ONLY_NATIVE_SETTINGS');
    if (savedSettings) Object.assign(native.settings, JSON.parse(savedSettings));
    native.vault.rpcEndpoint = `${native.settings.rpcHost}:${native.settings.rpcPort}`;
    const tip = native.tip = { chain: 'main', genesis_hash: '30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e',
      height: 123, hash: 'a'.repeat(64), mediantime: 1800000000, ...options.tip };
    const methods = {
      NativeWallet: ['getState', 'getPaymentBatch', 'dismissPaymentBatch', 'getSettings', 'saveSettings', 'watchAccount', 'removeListener', 'create', 'importRecovery', 'importWallet', 'exportWallet', 'changePassword', 'viewRecoveryPhrase', 'unlock', 'lock', 'readPaymentClipboard', 'queryPublic', 'reviewPayment', 'reviewP2C',
        'claimsState', 'claimsPolicy', 'claimsLimits', 'claimsStart', 'claimsStop', 'claimsCheckSubmission', 'recoverAddresses', 'getRecoverySnapshots', 'newAddress'],
      NativePaymentInput: ['scanPaymentQr', 'takePaymentLink', 'removeListener'],
      NativeExplorer: ['openTransaction'],
      Network: ['getStatus', 'removeListener'], App: ['getState', 'minimizeApp', 'removeListener'], Preferences: ['get', 'set'],
    };
    if (options.platform === 'ios') window.webkit = { messageHandlers: { bridge: {} } };
    else window.androidBridge = {};
    window.Capacitor = {
      PluginHeaders: Object.entries(methods).map(([name, list]) => ({ name, methods: [
        ...list.map(name => ({ name, rtype: 'promise' })),
        ...(['NativeWallet', 'NativePaymentInput', 'Network', 'App'].includes(name) ? [{ name: 'addListener', rtype: 'callback' }] : []),
      ] })),
      nativeCallback(plugin, method, options, callback) {
        if (method !== 'addListener') throw new Error(`Unexpected test callback: ${plugin}.${method}`);
        (native.listeners[`${plugin}:${options.eventName}`] ||= []).push(callback);
        return String(native.listeners[`${plugin}:${options.eventName}`].length);
      },
      async nativePromise(plugin, method, params = {}) {
        native.calls.push({ plugin, method, params: clone(params) });
        if (plugin === 'Network' && method === 'getStatus') return { connected: true, connectionType: 'wifi' };
        if (plugin === 'App' && method === 'getState') return { isActive: true };
        if (method === 'removeListener' || plugin === 'App' && method === 'minimizeApp') return {};
        if (plugin === 'Preferences') {
          if (method === 'get') return native.response('publicSnapshot', { value: localStorage.getItem(`CapacitorStorage.${params.key}`) });
          if (method === 'set') { localStorage.setItem(`CapacitorStorage.${params.key}`, params.value); return {}; }
        }
        if (plugin === 'NativePaymentInput') {
          if (method === 'takePaymentLink') {
            const pending = native.pendingPaymentLink;
            native.pendingPaymentLink = null;
            return pending == null ? {} : typeof pending === 'string' ? { text: pending } : clone(pending);
          }
          if (method === 'scanPaymentQr') {
            if (native.scanError) throw Object.assign(new Error('TEST_ONLY: scanner could not open.'), { code: native.scanError });
            return native.response(method, native.scanResult);
          }
          throw new Error(`Unexpected test payment intake: ${method}`);
        }
        if (plugin === 'NativeExplorer' && method === 'openTransaction') {
          if (Object.keys(params).join(',') !== 'txid' || !/^[0-9a-f]{64}$/.test(params.txid)) {
            throw Object.assign(new Error('TEST_ONLY: invalid explorer transaction.'), { code: 'INVALID_ARGUMENT' });
          }
          if (native.explorerError) throw Object.assign(new Error('TEST_ONLY: do not display native details <script>payload</script>'), { code: native.explorerError });
          return native.response(method, {});
        }
        if (plugin !== 'NativeWallet') throw new Error(`Unexpected test bridge: ${plugin}.${method}`);
        if (method === 'getPaymentBatch') {
          if (Object.keys(params).length) throw new Error('TEST_ONLY: receipt reads must contain no arguments.');
          if (native.paymentBatchError) throw new Error('TEST_ONLY: private journal details must remain hidden.');
          return native.response(method, { batch: native.paymentBatch });
        }
        if (method === 'dismissPaymentBatch') {
          if (native.dismissBatchError) throw Object.assign(new Error('TEST_ONLY: private journal details must remain hidden.'), { code: native.dismissBatchError });
          if (Object.keys(params).join(',') !== 'batchId' || params.batchId !== native.paymentBatch?.batchId) throw new Error('TEST_ONLY: wrong acknowledgement.');
          const result = await native.response(method, { dismissed: true, batchId: params.batchId });
          native.paymentBatch = null; localStorage.removeItem('TEST_ONLY_NATIVE_PAYMENT_BATCH');
          return result;
        }
        if (method === 'getSettings') {
          if (native.failSettingsRead) throw new Error('TEST_ONLY: saved settings unavailable.');
          return native.response(method, native.settings);
        }
        if (method === 'saveSettings') {
          if (Object.keys(params).sort().join(',') !== 'autoLockMinutes,rpcHost,rpcPort,theme') throw new Error('TEST_ONLY: invalid settings fields.');
          if (native.settingsError) throw Object.assign(new Error('TEST_ONLY: private native diagnostic must stay hidden'), { code: native.settingsError });
          const endpoint = `${params.rpcHost}:${params.rpcPort}`;
          const endpointChanged = endpoint !== native.vault.rpcEndpoint;
          if (endpointChanged && (native.claims.enabled || native.claims.requested)) throw Object.assign(new Error('TEST_ONLY: stop claims first.'), { code: 'CLAIMS_ACTIVE' });
          if (endpointChanged && native.vault.hd?.recovering) throw Object.assign(new Error('TEST_ONLY: recovery is busy.'), { code: 'RECOVERY_ACTIVE' });
          native.settings = clone(params);
          localStorage.setItem('TEST_ONLY_NATIVE_SETTINGS', JSON.stringify(params));
          if (endpointChanged) { native.vault.rpcEndpoint = endpoint; native.vault.locked = true; }
          return native.response(method, { settings: native.settings, state: native.vault, endpointChanged });
        }
        if (method === 'watchAccount') return native.response(method, {
          address: native.vault.walletId ?? native.vault.account?.address ?? null, connected: native.watchConnected ?? !native.rpcUnavailable,
          ...(native.vault.accountScope === 'hd-wallet' ? { coverageLimited: false, watched: native.vault.accounts.length, total: native.vault.accounts.length,
            ...native.watchCoverage } : {}),
        });
        if (method === 'getState') {
          if (native.failState) throw new Error('TEST_ONLY: state refresh failed.');
          if (native.vault.accountScope === 'hd-wallet') native.vault.watch = { connected: native.watchConnected ?? !native.rpcUnavailable,
            coverageLimited: false, watched: native.vault.accounts.length, total: native.vault.accounts.length, ...native.watchCoverage };
          return native.response(method, native.vault);
        }
        if (method === 'getRecoverySnapshots') return native.response(method, options.recoverySnapshots ?? { walletId: native.vault.walletId, groups: [] });
        if (method === 'recoverAddresses') {
          if (native.recoveryError) throw new Error(native.recoveryError);
          native.vault.hd.recovering = true;
          const result = await native.response(method, { ...clone(native.vault),
            hd: { ...native.vault.hd, complete: true, recovering: false, scanned: native.vault.accounts.length } });
          native.vault = clone(result); return result;
        }
        if (method === 'newAddress') {
          const next = native.vault.accounts.find(item => item.change === 0 && item.index === native.vault.hd.receiveIndex + 1);
          if (!next) throw new Error('TEST_ONLY: next public address fixture is missing.');
          const result = await native.response(method, { ...clone(native.vault), account: clone(next),
            hd: { ...native.vault.hd, receiveIndex: next.index } });
          native.vault = clone(result); return result;
        }
        if (method === 'exportWallet') {
          if (native.exportError) throw Object.assign(new Error('TEST_ONLY: private native file path and password must not appear'), { code: native.exportError });
          return native.response(method, native.exportResult);
        }
        if (method === 'changePassword' || method === 'viewRecoveryPhrase') {
          if (Object.keys(params).length) throw new Error('TEST_ONLY: security requests must not contain any values.');
          const code = native.securityErrors[method];
          if (method === 'changePassword' && !['BUSY', 'NATIVE_BUSY'].includes(code)) {
            native.vault.locked = true;
            native.emit('NativeWallet', 'walletStateChanged', { locked: true });
          }
          if (code) throw Object.assign(new Error('TEST_ONLY: private native authentication detail must not appear'), { code });
          return native.response(method, method === 'changePassword' ? native.vault : native.recoveryViewResult);
        }
        if (['create', 'importRecovery', 'importWallet'].includes(method)) {
          if (method === 'importWallet' || method === 'importRecovery') {
            native.imports.push(method === 'importWallet' ? 'encrypted-file' : 'recovery');
            if (native.importError) throw Object.assign(new Error('TEST_ONLY: private imported file path and password must not appear'), { code: native.importError });
          }
          // Native setup commits only after its backup/confirmation dialogs
          // complete. Dismissal must preserve the existing vault snapshot.
          const nextVault = { ...clone(native.vault), exists: true, locked: false, account: account(native.unlockAddress) };
          const result = await native.response(method, nextVault);
          native.vault = clone(result);
          return result;
        }
        if (method === 'unlock') {
          native.setAccount(native.unlockAddress); return native.response(method, native.vault);
        }
        if (method === 'lock') {
          native.vault.locked = true;
          if (native.cancelPendingOnLock) native.cancelResponses(['unlock', 'reviewPayment', 'reviewP2C', 'importRecovery', 'importWallet', 'exportWallet', 'changePassword', 'viewRecoveryPhrase']);
          return clone(native.vault);
        }
        if (method === 'readPaymentClipboard') {
          if (native.clipboardError) throw Object.assign(new Error('TEST_ONLY: clipboard unavailable.'), { code: native.clipboardError });
          return { text: native.clipboardReader ? await native.clipboardReader() : native.clipboardText };
        }
        if (method === 'claimsState') return native.response(method, { state: native.claims });
        if (method === 'claimsPolicy') {
          Object.assign(native.claims, params);
          localStorage.setItem('TEST_ONLY_NATIVE_CLAIMS_POLICY', JSON.stringify(params));
          return { state: clone(native.claims) };
        }
        if (method === 'claimsLimits') {
          if (Object.keys(params).sort().join(',') !== 'concurrency,connectionsPerSecondLimit' ||
              Object.values(params).some(value => !Number.isInteger(value) || value < 1 || value > 100)) {
            throw new Error('TEST_ONLY: invalid native claims limits.');
          }
          if (native.failLimits) throw new Error('TEST_ONLY: could not save limits.');
          Object.assign(native.claims, params);
          localStorage.setItem('TEST_ONLY_NATIVE_CLAIMS_LIMITS', JSON.stringify(params));
          return native.response(method, { state: native.claims });
        }
        if (method === 'claimsStart') {
          Object.assign(native.claims, { enabled: true, requested: true, status: 'paused', policyStatus: 'TEST_ONLY_NO_WORK' });
          return clone(native.vault);
        }
        if (method === 'claimsStop') {
          Object.assign(native.claims, { enabled: false, requested: false, status: 'stopped', policyStatus: 'stopped' });
          return { state: clone(native.claims) };
        }
        if (method === 'reviewPayment') {
          if (native.paymentResult) {
            if (native.paymentResult.batch === true) {
              native.paymentBatch = clone(native.paymentResult);
              localStorage.setItem('TEST_ONLY_NATIVE_PAYMENT_BATCH', JSON.stringify(native.paymentBatch));
            }
            return native.response(method, native.paymentResult);
          }
          if (native.cancelPayment) throw Object.assign(new Error('Cancelled.'), { code: 'CANCELLED' });
          if (native.deferPayment) return native.response(method, { txid: 'd'.repeat(64), status: 'submitted' });
          throw new Error(native.paymentError || 'TEST_ONLY: native payment review cancelled; no signer or broadcast exists.');
        }
        if (method === 'reviewP2C') {
          if (native.deferP2C) return native.response(method, { txid: 'c'.repeat(64), status: 'submitted' });
          throw new Error('TEST_ONLY: native P2C review cancelled; no signer or broadcast exists.');
        }
        if (method === 'queryPublic') {
          if (native.rpcUnavailable) throw new Error('TEST_ONLY: public RPC unavailable.');
          if (params.method === 'getchaintip') return { result: clone(tip) };
          if (params.method === 'getaddresschanges' && native.vault.accountScope === 'hd-wallet') {
            const after = params.params.cursor ? Number(params.params.cursor.split('.').at(-1)) : native.journalSequence;
            const changes = native.hdChanges.filter(item => item.sequence > after && params.params.addresses.includes(item.address));
            return native.response('changes', { result: { tip: clone(tip), unit: 'connects', changes: clone(changes),
              next_cursor: `journal.${native.journalSequence}`, through_sequence: native.journalSequence, journal_epoch: 1, has_more: false } });
          }
          if (params.method === 'getaddressutxos' && native.vault.accountScope === 'hd-wallet') {
            return native.response('utxos', { result: { address: params.params.address, tip: clone(tip), unit: 'connects', live: true,
              items: clone(native.hdUtxosByAddress[params.params.address] ?? []), next_cursor: null } });
          }
          if (params.method === 'getaddressbalance') return native.response('balance', { result: { address: params.params.address, tip: clone(tip), unit: 'connects', ...clone(native.balance) } });
          if (params.method === 'getaddresshistory') {
            if (native.historyFailures > 0) { native.historyFailures--; throw new Error('TEST_ONLY: initial history failed.'); }
            const responseKey = native.deferredMethods[`history:${params.params.address}`] ? `history:${params.params.address}` : 'history';
            return native.response(responseKey, { result: { address: params.params.address, tip: clone(tip), unit: 'connects',
              live: true, items: clone(native.vault.accountScope === 'hd-wallet' ? native.hdHistoryByAddress[params.params.address] ?? [] : native.history), next_cursor: null } });
          }
          throw new Error(`Unexpected test public query: ${params.method}`);
        }
        throw new Error(`Unexpected test wallet call: ${method}`);
      },
    };
  }, { address, hdAccounts, options, profileKey });
}

async function openNativeWallet(page, options = {}) {
  await fakeNative(page, options);
  await page.goto('/');
  await waitReady(page);
  await expect(page.locator('#current-address')).toHaveText(options.accountAddress ?? address);
}

function batchReceipt(statuses = ['submitted', 'check-required', 'not-sent']) {
  const submittedCount = statuses.filter(status => status === 'submitted').length;
  return { batch: true, batchId: 'a14c66d4-35a2-4cc0-8b3a-d5797c0a6e04', walletId: address, address: otherAddress,
    status: statuses.includes('check-required') ? 'check-required' : submittedCount === statuses.length ? 'submitted' : submittedCount ? 'partial' : 'not-sent',
    transactionCount: statuses.length, submittedCount,
    transactions: statuses.map((status, index) => ({ txid: (index + 1).toString(16).padStart(64, '0'), status, amount: '1000000001', fee: '150000' })),
    requestedTotal: (1000000001n * BigInt(statuses.length)).toString(), total: (1000000001n * BigInt(statuses.length)).toString(),
    fee: (150000n * BigInt(statuses.length)).toString() };
}

async function openReceive(page) {
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.locator('#copy-link')).toBeEnabled();
  await expect(page.locator('#receive-qr')).toBeVisible();
}

test('iOS uses the native wallet bridge with Send, P2C and foreground claims', async ({ page }) => {
  await openNativeWallet(page, { platform: 'ios' });
  await expect(page.locator('#preview-notice')).toBeHidden();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#send-address')).toBeEnabled();
  await page.getByRole('button', { name: 'P2C', exact: true }).click();
  await expect(page.locator('#p2c-domain')).toBeEnabled();
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#start-claims')).toBeEnabled();
  await expect(page.locator('#background')).toBeHidden();
  await expect(page.locator('#background')).toBeDisabled();
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.plugin === 'NativeWallet' && call.method === 'getState'))).toBe(true);
});

async function walletDraftSnapshot(page) {
  return page.evaluate(() => ({
    address: document.getElementById('current-address').textContent,
    values: Object.fromEntries(['receive-amount', 'receive-label', 'receive-message', 'receive-uri',
      'send-address', 'send-amount', 'send-fee-rate', 'p2c-domain', 'p2c-amount', 'p2c-expected']
      .map(id => [id, document.getElementById(id).value])),
    deduct: document.getElementById('send-deduct-fees').checked,
    qr: document.getElementById('receive-qr').getAttribute('src'),
  }));
}

async function expectWalletActions(page, locked) {
  for (const prefix of ['', 'p2c-']) {
    await expect(page.locator(`#${prefix}unlock-wallet`)).toHaveJSProperty('hidden', !locked);
    await expect(page.locator(`#${prefix}lock-wallet`)).toHaveJSProperty('hidden', locked);
    await expect(page.locator(`#${prefix}${locked ? 'unlock' : 'lock'}-wallet`)).toBeEnabled();
  }
}

async function expectNoIntakePayment(page) {
  await expect(page.locator('#incoming-payment, #use-incoming-payment, #dismiss-incoming-payment')).toHaveCount(0);
  expect(await page.evaluate(() => window.testNative.calls.filter(call =>
    ['reviewPayment', 'reviewP2C', 'sendrawtransaction', 'claimsStart'].includes(call.method)))).toEqual([]);
}

test.describe('General settings', () => {
  test('settings work before a wallet exists and persist the explicit foreground-only default', async ({ page }) => {
    await fakeNative(page, { exists: false, accountAddress: null });
    await page.goto('/'); await waitReady(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('#settings-title')).toBeFocused();
    await expect(page.locator('#setup-panel')).toBeHidden();
    await expect(page.locator('#settings-theme')).toHaveValue('dark');
    await expect(page.locator('#settings-lock-mode')).toHaveValue('never');
    await expect(page.locator('#settings-lock-help')).toContainText('still locks when you leave the app');
    await expect(page.locator('#settings-rpc-host')).toHaveValue('connectcoin4.com');
    await expect(page.locator('#settings-rpc-port')).toHaveValue('48190');
    await page.locator('#settings-theme').selectOption('light');
    await page.locator('#save-settings').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'saveSettings').map(call => call.params))).toEqual([
      { theme: 'light', autoLockMinutes: 0, rpcHost: 'connectcoin4.com', rpcPort: 48190 },
    ]);
    await page.reload(); await waitReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.locator('#open-settings').click();
    await expect(page.locator('#settings-theme')).toHaveValue('light');
    await page.evaluate(() => window.testNative.emit('App', 'backButton', {}));
    await expect(page.locator('#settings-panel')).toBeHidden();
    await expect(page.locator('#open-settings')).toBeFocused();
    await expect(page.locator('#setup-panel')).toBeVisible();
    expect(await page.evaluate(() => window.testNative.calls.some(call => ['create', 'unlock', 'queryPublic', 'claimsStart'].includes(call.method)))).toBe(false);
  });

  test('theme and timer save preserve balances and payment drafts; system follows device changes', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openNativeWallet(page, { watchConnected: false });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(otherAddress);
    await page.locator('#send-use-all').click();
    await page.waitForTimeout(700); // Let the startup catch-up settle before counting new reads.
    const before = await page.evaluate(() => window.testNative.calls.filter(call => ['queryPublic', 'watchAccount'].includes(call.method)));
    await page.locator('#open-settings').click();
    await page.locator('#settings-theme').selectOption('system');
    await page.locator('#settings-lock-mode').selectOption('timer');
    await page.locator('#settings-lock-minutes').fill('1440');
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-status')).toHaveText('Settings saved.');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => window.testNative.settings.autoLockMinutes)).toBe(1440);
    expect(await page.evaluate(() => window.testNative.calls.filter(call => ['queryPublic', 'watchAccount'].includes(call.method)))).toEqual(before);
    await page.locator('#settings-back').click();
    await expect(page.locator('#send-address')).toHaveValue(otherAddress);
    await expect(page.locator('#send-amount')).toHaveValue('1');
    await expect(page.locator('#send-all-hint')).toBeVisible();
    await expect(page.locator('#review-payment')).toBeEnabled();
  });

  test('invalid hostname, port and inactivity are rejected without a native save', async ({ page }) => {
    await openNativeWallet(page); await page.locator('#open-settings').click();
    for (const value of ['https://connectcoin4.com', '127.0.0.1', 'localhost', 'node.local', 'node.example/path', '']) {
      await page.locator('#settings-rpc-host').fill(value); await page.locator('#save-settings').click();
      await expect(page.locator('#settings-error')).toContainText('public RPC hostname');
    }
    await page.locator('#settings-rpc-host').fill('connectcoin4.com');
    for (const value of ['0', '65536', '1.5', '1e3', '']) {
      await page.locator('#settings-rpc-port').fill(value); await page.locator('#save-settings').click();
      await expect(page.locator('#settings-error')).toContainText('whole number');
    }
    await page.locator('#settings-rpc-port').fill('48190');
    await page.locator('#settings-lock-mode').selectOption('timer');
    for (const value of ['0', '-1', '1441', '1.5', '']) {
      await page.locator('#settings-lock-minutes').fill(value); await page.locator('#save-settings').click();
      await expect(page.locator('#settings-error')).toContainText('whole number');
    }
    expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'saveSettings'))).toBe(false);
  });

  test('failed read cannot save defaults, and failed saves keep the draft for retry', async ({ page }) => {
    await openNativeWallet(page, { failSettingsRead: true }); await page.locator('#open-settings').click();
    await expect(page.locator('#settings-error')).toContainText('Could not load');
    await expect(page.locator('#save-settings')).toBeDisabled();
    await page.locator('#settings-form').dispatchEvent('submit');
    expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'saveSettings'))).toBe(false);
    await page.evaluate(() => { window.testNative.failSettingsRead = false; });
    await page.locator('#retry-settings').click();
    await expect(page.locator('#settings-theme')).toBeEnabled();
    await page.locator('#settings-theme').selectOption('light');
    await page.evaluate(() => { window.testNative.settingsError = 'STORAGE_ERROR'; });
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-error')).toContainText('Could not save settings');
    await expect(page.locator('#settings-error')).not.toContainText('private native');
    await expect(page.locator('#settings-theme')).toHaveValue('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('#save-settings')).toBeEnabled();
    await page.evaluate(() => { window.testNative.settingsError = null; });
    await page.locator('#save-settings').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('server changes never stop claims and cancellation preserves the original endpoint', async ({ page }) => {
    await openNativeWallet(page, { claims: { enabled: true, requested: true } });
    await page.locator('#open-settings').click();
    await page.locator('#settings-rpc-host').fill('node.example.com'); await page.locator('#save-settings').click();
    await expect(page.locator('#settings-error')).toHaveText('Stop Automatic Claims before changing the server.');
    expect(await page.evaluate(() => window.testNative.vault.rpcEndpoint)).toBe('connectcoin4.com:48190');
    expect(await page.evaluate(() => window.testNative.calls.some(call => ['claimsStop', 'claimsStart'].includes(call.method)))).toBe(false);
    await page.evaluate(() => { window.testNative.claims.enabled = false; window.testNative.claims.requested = false; window.testNative.settingsError = 'CANCELLED'; });
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-status')).toContainText('cancelled');
    await expect(page.locator('#settings-rpc-host')).toHaveValue('node.example.com');
    expect(await page.evaluate(() => window.testNative.vault.rpcEndpoint)).toBe('connectcoin4.com:48190');
    await page.locator('#settings-back').click();
    await expect(page.locator('#balance')).toHaveText('1');
  });

  test('server switch clears public state and sweep drafts before ignoring old reads and events', async ({ page }) => {
    await page.clock.install();
    await openNativeWallet(page, { history: [confirmedHistory], watchConnected: false, deferredMethods: { watchAccount: true } });
    await expect(page.locator('#balance')).toHaveText('1');
    // Finish the scheduled startup catch-up before suspending manual refresh
    // replies. Otherwise its balance read can consume the one-shot deferred
    // response first and leave Refresh disabled while the fixture waits to click.
    await page.clock.runFor(3000);
    await expect(page.locator('#refresh')).toBeEnabled();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(otherAddress); await page.locator('#send-use-all').click();
    await page.evaluate(() => { window.testNative.deferredMethods = { balance: true, history: true }; });
    await page.getByRole('button', { name: 'Overview', exact: true }).click(); await page.locator('#refresh').click();
    await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(item => item.method).sort())).toEqual(['balance', 'history', 'watchAccount']);
    await page.locator('#open-settings').click();
    await page.locator('#settings-rpc-host').fill('node.example.com');
    await page.evaluate(() => { window.testNative.rpcUnavailable = true; });
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-status')).toContainText('Wallet locked');
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'watchAccount').length)).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => {
      window.testNative.releaseResponses();
      window.testNative.emit('NativeWallet', 'walletChanged', { address: window.testNative.vault.account.address,
        rpcEndpoint: 'connectcoin4.com:48190', reason: 'tip', tip: { ...window.testNative.tip, height: 999 } });
    });
    await page.locator('#settings-back').click();
    await expect(page.locator('#balance')).toHaveText('—');
    await expect(page.locator('#history li')).toHaveCount(0);
    await expect(page.locator('#block-height')).toBeEmpty();
    await expect(page.locator('#load-more')).toBeHidden();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#send-amount')).toHaveValue('');
    await expect(page.locator('#send-address')).toHaveValue('');
    await expect(page.locator('#send-all-hint')).toBeHidden();
    await expect(page.locator('#send-use-all')).toBeDisabled();
    await expect(page.locator('#review-payment')).toBeDisabled();
    expect(await page.evaluate(() => window.testNative.vault.exists)).toBe(true);
  });

  test('HD cache is scoped to the selected server even for the same wallet', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdHistoryByAddress: { [address]: [confirmedHistory] } });
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key) !== null, publicSnapshotKey)).toBe(true);
    await page.locator('#open-settings').click(); await page.locator('#settings-rpc-host').fill('node.example.com');
    await page.evaluate(() => { window.testNative.rpcUnavailable = true; });
    await page.locator('#save-settings').click();
    await expect(page.locator('#settings-status')).toContainText('Wallet locked');
    await page.locator('#settings-back').click();
    await expect(page.locator('#balance')).toHaveText('—');
    await expect(page.locator('#history li')).toHaveCount(0);
    await expect(page.locator('#cached-state-status')).toBeHidden();
    const keys = await page.evaluate(() => window.testNative.calls.filter(call => call.plugin === 'Preferences' && call.method === 'get').map(call => call.params.key));
    expect(keys).toContain(`connectwallet.mobile.public-snapshot.mainnet.v2.node.example.com%3A48190.${address}`);
    expect(await page.evaluate(key => localStorage.getItem(key) !== null, publicSnapshotKey)).toBe(true);
  });

  test('native inactivity lock immediately disables review and defeats a pending unlocked poll', async ({ page }) => {
    await openNativeWallet(page); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#review-payment')).toBeEnabled();
    await page.locator('#send-use-all').click();
    await page.evaluate(() => { window.testNative.deferredMethods = { getState: true }; });
    await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(item => item.method))).toContain('getState');
    await page.evaluate(() => {
      window.testNative.vault.locked = true;
      window.testNative.emit('NativeWallet', 'walletStateChanged', { ...window.testNative.vault });
    });
    await expect(page.locator('#review-payment')).toBeDisabled();
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#unlock-wallet')).toBeVisible();
    await expect(page.locator('#review-payment')).toBeDisabled();
    await expect(page.locator('#send-amount')).toHaveValue('1');
  });

  test('light and dark settings have readable contrast and fit narrow and landscape screens', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/'); await waitReady(page); await page.locator('#open-settings').click();
    await expect(page.locator('#settings-status')).toContainText('Browser preview only');
    for (const theme of ['light', 'dark']) {
      await page.locator('#settings-theme').selectOption(theme); await page.locator('#save-settings').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const size of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(size);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        for (const id of ['open-settings', 'settings-back', 'settings-theme', 'settings-lock-mode', 'settings-rpc-host', 'settings-rpc-port', 'save-settings', 'change-wallet-password', 'view-recovery-phrase']) {
          const bounds = await page.locator(`#${id}`).boundingBox();
          expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width);
        }
      }
      const contrasts = await page.evaluate(() => {
        const lum = css => {
          const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
          return .2126 * r + .7152 * g + .0722 * b;
        };
        return ['settings-title', 'settings-lock-help', 'settings-status', 'settings-theme', 'settings-rpc-host', 'save-settings', 'settings-security-title', 'wallet-security-help'].map(id => {
          const el = document.getElementById(id), style = getComputedStyle(el);
          let background = style.backgroundColor, parent = el.parentElement;
          while (background === 'rgba(0, 0, 0, 0)' && parent) { background = getComputedStyle(parent).backgroundColor; parent = parent.parentElement; }
          const a = lum(style.color), b = lum(background);
          return { id, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
        });
      });
      for (const { id, ratio } of contrasts) expect(ratio, `${theme} ${id}`).toBeGreaterThanOrEqual(4.5);
      await page.setViewportSize({ width: 320, height: 568 });
      await page.screenshot({ path: `test-results/settings-${theme}-small.png`, fullPage: true });
    }
  });
});

test.describe('HD wallet', () => {
  const utxo = (txid, amount, vout = 0) => ({ txid, vout, amount, status: 'confirmed', block_height: 121,
    confirmations: 3, coinbase: false, mature: true, pending_spent_by: null });
  const funds = () => ({
    [address]: [utxo('1'.repeat(64), '20000000000')],
    [otherAddress]: [utxo('2'.repeat(64), '30000000000')],
    [changeAddress]: [utxo('3'.repeat(64), '40000000000')],
  });

  for (const platform of ['android', 'ios']) test(`${platform} HD network recovery shows retry progress without enabling payments or starting another scan`, async ({ page }) => {
    await openNativeWallet(page, { platform, hd: { complete: false, recovering: true, scanned: 17,
      recoveryState: 'waiting-network', errorCode: 'RPC_INACTIVE' } });
    await expect(page.locator('#hd-status')).toContainText('Waiting for a usable network · 17 checked');
    await expect(page.locator('#recover-addresses')).toBeDisabled();
    await expect(page.locator('#hd-error')).toBeEmpty();
    await page.evaluate(() => {
      const native = window.testNative;
      native.setHd({ hd: { ...native.vault.hd, recoveryState: 'retrying', retryAfterMs: 7100, errorCode: '-32029' } });
      native.emit('NativeWallet', 'walletStateChanged', native.vault);
    });
    await expect(page.locator('#hd-status')).toContainText('Retrying address discovery in 8 s · 17 checked');
    await expect(page.locator('#hd-status')).toContainText('-32029');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#send-use-all')).toBeDisabled();
    await expect(page.locator('#review-payment')).toBeDisabled();
    await page.evaluate(() => {
      const native = window.testNative;
      native.setHd({ locked: true, hd: { ...native.vault.hd, recovering: false, recoveryState: 'paused' } });
      native.emit('NativeWallet', 'walletStateChanged', native.vault);
    });
    await expect(page.locator('#hd-status')).toContainText('Unlock the wallet to resume');
    await expect(page.locator('#recover-addresses')).toBeDisabled();
    expect(await page.evaluate(() => window.testNative.calls.filter(call => ['recoverAddresses', 'reviewPayment', 'reviewP2C', 'claimsStart'].includes(call.method)))).toEqual([]);
  });

  test('HD terminal failure at zero is not presented as active discovery', async ({ page }) => {
    await openNativeWallet(page, { hd: { complete: false, recovering: false, scanned: 0, recoveryState: 'failed',
      error: 'The server returned invalid address data.', errorCode: 'HD_INVALID_DATA' } });
    await expect(page.locator('#hd-status')).toContainText('Address discovery stopped · 0 checked');
    await expect(page.locator('#hd-status')).not.toContainText('Discovering');
    await expect(page.locator('#hd-error')).toContainText('HD_INVALID_DATA');
    await expect(page.locator('#recover-addresses')).toBeEnabled();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#review-payment')).toBeDisabled();
  });

  test('incomplete recovery gates sweep and review, then verifies all owned addresses', async ({ page }) => {
    await openNativeWallet(page, { hd: { complete: false, recovering: false, scanned: 1 }, hdUtxosByAddress: funds(),
      deferredMethods: { recoverAddresses: true } });
    await expect(page.locator('#hd-status')).toContainText('Address discovery incomplete');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(otherAddress);
    await page.locator('#send-amount').fill('1');
    await expect(page.locator('#send-use-all')).toBeDisabled();
    await expect(page.locator('#review-payment')).toBeDisabled();
    await page.locator('#send-form').dispatchEvent('submit');
    expect(await page.evaluate(() => window.testNative.calls.filter(call => ['reviewPayment', 'queryPublic'].includes(call.method)))).toEqual([]);
    await page.locator('#recover-addresses').click();
    await expect(page.locator('#recover-addresses')).toBeDisabled();
    await expect(page.locator('#send-use-all')).toBeDisabled();
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#hd-status')).toContainText('3 owned addresses');
    await expect(page.locator('#send-available')).toHaveText('Available: 9 CONN');
    await expect(page.locator('#send-use-all')).toBeEnabled();
    await expect(page.locator('#review-payment')).toBeEnabled();
    await page.locator('#send-use-all').click();
    await expect(page.locator('#send-amount')).toHaveValue('9');
    await expect(page.locator('#send-deduct-fees')).toBeChecked();
    expect(await page.evaluate(() => [...new Set(window.testNative.calls.filter(call => call.method === 'queryPublic'
      && call.params.method === 'getaddressutxos').map(call => call.params.params.address))].sort())).toEqual(hdAccounts.map(account => account.address).sort());
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment'))).toEqual([]);
  });

  test('balance includes receive and change accounts while self-transfers have one net history row', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: funds(), hdHistoryByAddress: {
      [address]: [{ ...confirmedHistory, received: '0', spent: '50000000000', balance_delta: '-50000000000' }],
      [changeAddress]: [{ ...confirmedHistory, received: '49999998500', spent: '0', balance_delta: '49999998500' }],
    } });
    await expect(page.locator('#balance')).toHaveText('9');
    await expect(page.locator('#history li')).toHaveCount(1);
    await expect(page.locator('#history .amount')).toHaveText('-0.00000015 CONN');
    await page.locator('#history button.history-transaction').click();
    await expect(page.locator('#transaction-id')).toHaveText(confirmedHistory.txid);
    await expect(page.locator('#transaction-net')).toHaveText('-0.00000015 CONN');
    await expect(page.locator('#transaction-received')).toHaveText('4.99999985 CONN');
    await expect(page.locator('#transaction-spent')).toHaveText('5 CONN');
    await expect(page.locator('#transaction-address')).toContainText(address);
    await expect(page.locator('#transaction-address')).toContainText(changeAddress);
    expect(await page.evaluate(() => window.testNative.calls.some(call => ['reviewPayment', 'reviewP2C', 'claimsStart'].includes(call.method)))).toBe(false);
  });

  test('shows spendable partial balance and address progress while the remaining address is slow', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: funds(), deferredMethods: { history: true } });
    await expect(page.locator('#hd-status')).toContainText('3 owned addresses');
    await expect(page.locator('#wallet-load-progress')).toBeVisible();
    await expect(page.locator('#wallet-load-progress-text')).toHaveText('Verifying balance · 2 / 3 addresses');
    await expect(page.locator('#wallet-load-progress-bar')).toHaveAttribute('max', '3');
    await expect(page.locator('#wallet-load-progress-bar')).toHaveAttribute('value', '2');
    await expect(page.locator('#balance')).toHaveText('7');
    await expect(page.locator('#balance-label')).toHaveText('Confirmed balance · verified addresses only');
    await expect(page.locator('#partial-state-status')).toContainText('2 / 3 addresses verified');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#send-available')).toHaveText('Verified available balance: 7 CONN');
    await expect(page.locator('#send-use-all')).toHaveText('Use all verified balance');
    await expect(page.locator('#send-use-all')).toBeEnabled();
    await expect(page.locator('#review-payment')).toBeEnabled();
    await expect(page.locator('#send-refresh-balance')).toBeDisabled();
    await page.setViewportSize({ width: 320, height: 568 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/hd-startup-progress.png', fullPage: true });
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#balance')).toHaveText('9');
    await expect(page.locator('#partial-state-status')).toBeHidden();
    await expect(page.locator('#balance-label')).toHaveText('Confirmed balance');
    await expect(page.locator('#send-use-all')).toHaveText('Use all balance');
    await expect(page.locator('#wallet-load-progress')).toBeHidden();
    await expect(page.locator('#wallet-load-progress-text')).toBeEmpty();
  });

  test('restores public balance and activity on reload, with payments gated until live funds are verified', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: funds(),
      hdHistoryByAddress: { [address]: [confirmedHistory] },
      deferredMethods: Object.fromEntries(hdAccounts.map(account => [`history:${account.address}`, true])) });
    await expect(page.locator('#wallet-load-progress-text')).toContainText('0 / 3 addresses');
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#balance')).toHaveText('9');
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key) !== null, publicSnapshotKey)).toBe(true);
    await page.reload();
    await waitReady(page);
    await expect(page.locator('#cached-state-status')).toHaveText('Previously saved balance and activity — updating…');
    await expect(page.locator('#balance')).toHaveText('9');
    await expect(page.locator('#history .txid')).toHaveText(confirmedHistory.txid);
    await expect(page.locator('#last-update')).toContainText('Previously saved at');
    await expect(page.locator('#wallet-load-progress')).toBeVisible();
    await page.setViewportSize({ width: 320, height: 568 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: 'test-results/hd-startup-cache.png', fullPage: true });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#send-use-all')).toBeDisabled();
    await expect(page.locator('#review-payment')).toBeDisabled();
    await expect(page.locator('#send-balance-status')).toContainText('Previously saved balance');
    await page.locator('#send-address').fill(otherAddress);
    await page.locator('#send-amount').fill('1');
    await page.locator('#send-form').dispatchEvent('submit');
    await page.getByRole('button', { name: 'P2C', exact: true }).click();
    await expect(page.locator('#review-p2c')).toBeDisabled();
    await page.locator('#p2c-domain').fill('example.com');
    await page.locator('#p2c-amount').fill('1');
    await page.locator('#p2c-form').dispatchEvent('submit');
    expect(await page.evaluate(() => window.testNative.calls.filter(call => ['reviewPayment', 'reviewP2C'].includes(call.method)))).toEqual([]);
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#cached-state-status')).toBeHidden();
    await expect(page.locator('#wallet-load-progress')).toBeHidden();
    await expect(page.locator('#review-p2c')).toBeEnabled();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#send-use-all')).toBeEnabled();
    await expect(page.locator('#review-payment')).toBeEnabled();
    await expect(page.locator('#send-available')).toHaveText('Available: 9 CONN');
  });

  test('Send and P2C review restrict funding to the verified addresses during synchronization', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: funds(), deferredMethods: { history: true } });
    await expect(page.locator('#balance')).toHaveText('7');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(address);
    await page.locator('#send-amount').fill('1');
    await page.locator('#review-payment').click();
    await expect(page.locator('#send-status')).toContainText('TEST_ONLY');
    const send = await page.evaluate(() => window.testNative.calls.find(call => call.method === 'reviewPayment').params);
    expect(send).toEqual({ address, amount: '1', feeRate: '1500', subtractFeeFromAmount: false,
      useAllBalance: false, fundingAddresses: [otherAddress, changeAddress] });
    await page.getByRole('button', { name: 'P2C', exact: true }).click();
    await expect(page.locator('#p2c-balance-status')).toContainText('7 CONN · 2 / 3 addresses');
    await page.locator('#p2c-domain').fill('example.com');
    await page.locator('#p2c-amount').fill('1');
    await page.locator('#review-p2c').click();
    await expect(page.locator('#p2c-status')).toContainText('TEST_ONLY');
    const p2c = await page.evaluate(() => window.testNative.calls.find(call => call.method === 'reviewP2C').params);
    expect(p2c).toEqual({ domain: 'example.com', amount: '1', expectedConnections: '1', fundingAddresses: [otherAddress, changeAddress] });
    expect(await page.evaluate(() => window.testNative.pendingResponses.length)).toBe(1);
  });

  test('Use all verified balance freezes its source addresses even when the rest finishes syncing', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: funds(), deferredMethods: { history: true } });
    await expect(page.locator('#balance')).toHaveText('7');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(address);
    await page.locator('#send-use-all').click();
    await expect(page.locator('#send-amount')).toHaveValue('7');
    await expect(page.locator('#send-all-hint')).toContainText('2 selected addresses');
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#send-available')).toHaveText('Available: 9 CONN');
    await expect(page.locator('#send-amount')).toHaveValue('7');
    await expect(page.locator('#send-all-hint')).toContainText('Addresses verified later are not added');
    await page.locator('#review-payment').click();
    await expect(page.locator('#send-status')).toContainText('TEST_ONLY');
    const send = await page.evaluate(() => window.testNative.calls.find(call => call.method === 'reviewPayment').params);
    expect(send).toEqual({ address, amount: '7', feeRate: '1500', subtractFeeFromAmount: true,
      useAllBalance: true, fundingAddresses: [otherAddress, changeAddress] });
  });

  test('editing a partial sweep clears its frozen selection without disabling verified funding', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: funds(), deferredMethods: { history: true } });
    await expect(page.locator('#balance')).toHaveText('7');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(address);
    await page.locator('#send-use-all').click();
    await page.locator('#send-amount').fill('1');
    await expect(page.locator('#send-all-hint')).toBeHidden();
    await page.locator('#review-payment').click();
    await expect(page.locator('#send-status')).toContainText('TEST_ONLY');
    const send = await page.evaluate(() => window.testNative.calls.find(call => call.method === 'reviewPayment').params);
    expect(send.useAllBalance).toBe(false);
    expect(send.fundingAddresses).toEqual([otherAddress, changeAddress]);
  });

  test('locking a partial wallet clears the selected sweep and prevents both payment reviews', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: funds(), deferredMethods: { history: true } });
    await expect(page.locator('#balance')).toHaveText('7');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(address);
    await page.locator('#send-use-all').click();
    await expect(page.locator('#send-all-hint')).toBeVisible();
    await page.locator('#lock-wallet').click();
    await expect(page.locator('#send-all-hint')).toBeHidden();
    await expect(page.locator('#review-payment')).toBeDisabled();
    await page.locator('#send-form').dispatchEvent('submit');
    await page.getByRole('button', { name: 'P2C', exact: true }).click();
    await expect(page.locator('#review-p2c')).toBeDisabled();
    await page.locator('#p2c-form').dispatchEvent('submit');
    expect(await page.evaluate(() => window.testNative.calls.filter(call => ['reviewPayment', 'reviewP2C'].includes(call.method)))).toEqual([]);
  });

  test('empty verified addresses cannot fall through to spending funds from an unverified address', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: { [address]: funds()[address] }, deferredMethods: { history: true } });
    await expect(page.locator('#partial-state-status')).toContainText('2 / 3 addresses verified');
    await expect(page.locator('#balance')).toHaveText('0');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#send-use-all')).toBeDisabled();
    await expect(page.locator('#review-payment')).toBeDisabled();
    await page.locator('#send-address').fill(otherAddress);
    await page.locator('#send-amount').fill('1');
    await page.locator('#send-form').dispatchEvent('submit');
    await page.getByRole('button', { name: 'P2C', exact: true }).click();
    await expect(page.locator('#review-p2c')).toBeDisabled();
    await page.locator('#p2c-domain').fill('example.com');
    await page.locator('#p2c-amount').fill('1');
    await page.locator('#p2c-form').dispatchEvent('submit');
    expect(await page.evaluate(() => window.testNative.calls.filter(call => ['reviewPayment', 'reviewP2C'].includes(call.method)))).toEqual([]);
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#review-p2c')).toBeEnabled();
    await expect(page.locator('#balance')).toHaveText('2');
  });

  test('a delayed saved snapshot cannot restore the previous wallet after account replacement', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: funds(),
      hdHistoryByAddress: { [address]: [confirmedHistory] }, deferredMethods: { publicSnapshot: true } });
    await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(item => item.method))).toContain('publicSnapshot');
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#balance')).toHaveText('9');
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key) !== null, publicSnapshotKey)).toBe(true);
    await page.reload();
    await waitReady(page);
    await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(item => item.method))).toContain('publicSnapshot');
    await page.evaluate(({ otherAddress, changeAddress }) => {
      const accounts = [
        { address: otherAddress, index: 0, change: 0, network: 'main', path: "m/44'/0'/0'/0/0" },
        { address: changeAddress, index: 0, change: 1, network: 'main', path: "m/44'/0'/0'/1/0" },
      ];
      window.testNative.setHd({ walletId: otherAddress, account: accounts[0], accounts });
    }, { otherAddress, changeAddress });
    await expect(page.locator('#current-address')).toHaveText(otherAddress);
    await expect(page.locator('#balance')).toHaveText('7');
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#current-address')).toHaveText(otherAddress);
    await expect(page.locator('#balance')).toHaveText('7');
    await expect(page.locator('#history li')).toHaveCount(0);
    await expect(page.locator('#cached-state-status')).toBeHidden();
  });

  test('New address updates receiving QR without changing wallet identity or the Send draft', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: funds() });
    await expect(page.locator('#balance')).toHaveText('9');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(changeAddress);
    await page.locator('#send-amount').fill('1.25');
    await page.locator('#send-deduct-fees').check();
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await expectQrMatches(page, `connectcoin:${address}`);
    await page.locator('#new-receive-address').click();
    await expect(page.locator('#current-address')).toHaveText(otherAddress);
    await expect(page.locator('#receive-address')).toHaveText(otherAddress);
    await expect(page.locator('#receive-path')).toHaveText("m/44'/0'/0'/0/1");
    await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${otherAddress}`);
    await expectQrMatches(page, `connectcoin:${otherAddress}`);
    expect(await page.evaluate(() => window.testNative.vault.walletId)).toBe(address);
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'newAddress'))).toEqual([
      { plugin: 'NativeWallet', method: 'newAddress', params: {} },
    ]);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#send-address')).toHaveValue(changeAddress);
    await expect(page.locator('#send-amount')).toHaveValue('1.25');
    await expect(page.locator('#send-deduct-fees')).toBeChecked();
    await expect(page.locator('#send-available')).toHaveText('Available: 9 CONN');
    expect(await page.evaluate(() => window.testNative.calls.some(call => ['reviewPayment', 'reviewP2C', 'claimsStart'].includes(call.method)))).toBe(false);
  });

  test('partial live coverage is explicit but the displayed balance still includes every address', async ({ page }) => {
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: funds(), watchCoverage: { coverageLimited: true, watched: 1, total: 3 } });
    await expect(page.locator('#balance')).toHaveText('9');
    await expect(page.locator('#watch-coverage')).toBeVisible();
    await expect(page.locator('#watch-coverage')).toContainText('1 of 3');
    await expect(page.locator('#watch-coverage')).toContainText('Refresh');
    const requested = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic'
      && call.params.method === 'getaddressutxos').map(call => call.params.params.address));
    expect(new Set(requested)).toEqual(new Set(hdAccounts.map(account => account.address)));
  });

  test('ordinary and older native connected notifications preserve a 41-address startup without repeating history reads', async ({ page }) => {
    const accounts = Array.from({ length: 41 }, (_, offset) => {
      const change = offset < 21 ? 0 : 1, index = change ? offset - 21 : offset;
      return { address: bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.multiply(BigInt(offset + 1)).toBytes(true).slice(1))]),
        index, change, network: 'main', path: `m/44'/0'/0'/${change}/${index}` };
    });
    await page.clock.install();
    await openNativeWallet(page, { hd: true, hdAccounts: accounts,
      hdUtxosByAddress: { [accounts[1].address]: [utxo('4'.repeat(64), '20000000000')] },
      deferredMethods: { history: true } });
    await page.clock.runFor(2000);
    await expect(page.locator('#wallet-load-progress-text')).toContainText('40 / 41 addresses');
    await expect(page.locator('#balance')).toHaveText('2');
    const historyAddresses = () => page.evaluate(() => window.testNative.calls.filter(call =>
      call.method === 'queryPublic' && call.params.method === 'getaddresshistory').map(call => call.params.params.address));
    expect(await historyAddresses()).toHaveLength(41);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#send-use-all')).toBeEnabled();
    await page.evaluate(address => {
      const native = window.testNative;
      native.emit('NativeWallet', 'walletChanged', { address, reason: 'connected', tip: { ...native.tip },
        reorg: false, resync_required: false, changed_addresses: [], coverageLimited: false, watched: 41, total: 41 });
    }, address);
    await page.clock.runFor(3000);
    await expect(page.locator('#wallet-load-progress-text')).toContainText('40 / 41 addresses');
    await expect(page.locator('#send-use-all')).toBeEnabled();
    expect(await historyAddresses()).toHaveLength(41);
    await page.evaluate(address => {
      const native = window.testNative;
      native.delayedConnectedTip = { ...native.tip };
      native.tip.height++; native.tip.hash = 'e'.repeat(64);
      native.emit('NativeWallet', 'walletChanged', { address, reason: 'tip', tip: { ...native.tip },
        reorg: false, resync_required: false });
      // The first subscription ACK may arrive after another channel has already
      // reported the next block. That older registration snapshot is not a reorg.
      native.emit('NativeWallet', 'walletChanged', { address, reason: 'connected', tip: { ...native.delayedConnectedTip },
        reorg: false, resync_required: false, changed_addresses: [], coverageLimited: false, watched: 41, total: 41 });
    }, address);
    await page.clock.runFor(2000);
    await expect(page.locator('#wallet-load-progress-text')).toContainText('40 / 41 addresses');
    await expect(page.locator('#send-use-all')).toBeEnabled();
    await expect(page.locator('#block-height')).toHaveText('Block 124');
    expect(await historyAddresses()).toHaveLength(41);
    await page.evaluate(() => window.testNative.releaseResponses());
    await page.clock.runFor(3000);
    await expect(page.locator('#wallet-load-progress')).toBeHidden();
    await expect(page.locator('#partial-state-status')).toBeHidden();
    await expect(page.locator('#send-available')).toHaveText('Available: 2 CONN');
    await page.evaluate(address => {
      const native = window.testNative;
      native.emit('NativeWallet', 'walletChanged', { address, reason: 'connected', tip: { ...native.delayedConnectedTip },
        reorg: false, resync_required: false, changed_addresses: [], coverageLimited: false, watched: 41, total: 41 });
    }, address);
    await page.clock.runFor(5000);
    const histories = await historyAddresses();
    expect(histories).toHaveLength(41);
    expect(new Set(histories)).toEqual(new Set(accounts.map(account => account.address)));
    await expect(page.locator('#wallet-error')).toBeEmpty();
    await expect(page.locator('#send-use-all')).toBeEnabled();
    await expect(page.locator('#block-height')).toHaveText('Block 124');
    expect(await page.evaluate(() => window.testNative.calls.some(call => ['reviewPayment', 'reviewP2C', 'claimsStart'].includes(call.method)))).toBe(false);
  });

  test('tips only advance confirmations; an owned-address hint reads journal deltas without another baseline', async ({ page }) => {
    await page.clock.install();
    await openNativeWallet(page, { hd: true, hdUtxosByAddress: funds(), hdHistoryByAddress: { [address]: [confirmedHistory] } });
    await page.clock.runFor(3000);
    await expect(page.locator('#balance')).toHaveText('9');
    const before = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic'));
    await page.evaluate(address => {
      const native = window.testNative;
      native.tip.height = 124; native.tip.hash = 'e'.repeat(64);
      native.emit('NativeWallet', 'walletChanged', { address, reason: 'tip', tip: { ...native.tip }, reorg: false,
        resyncRequired: false, changedAddresses: [], coverageLimited: false, watched: 3, total: 3 });
    }, address);
    await page.clock.runFor(1000);
    await expect(page.locator('#history .state')).toHaveText('4 confirmations');
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic'))).toEqual(before);
    await page.evaluate(({ address, otherAddress }) => {
      const native = window.testNative;
      native.journalSequence = 1;
      const item = { txid: 'e'.repeat(64), vout: 7, amount: '20000000000', status: 'confirmed', block_height: 124,
        confirmations: 1, coinbase: false, mature: true, pending_spent_by: null };
      native.hdChanges = [{ sequence: 1, address: otherAddress, kind: 'utxo', action: 'upsert', txid: item.txid, vout: 7, item }];
      native.emit('NativeWallet', 'walletChanged', { address, reason: 'address', tip: { ...native.tip }, reorg: false,
        resyncRequired: false, changedAddresses: [otherAddress], coverageLimited: false, watched: 3, total: 3 });
    }, { address, otherAddress });
    await page.clock.runFor(1500);
    await expect(page.locator('#balance')).toHaveText('11');
    const after = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic'));
    expect(after.slice(before.length).map(call => call.params.method)).toEqual(['getaddresschanges']);
  });
});

test.describe('transaction details', () => {
  const historyButton = (page, txid) => page.locator(`#history button.history-transaction[data-txid="${txid}"]`);
  const publicAndPaymentCalls = page => page.evaluate(() => window.testNative.calls.filter(call =>
    ['queryPublic', 'reviewPayment', 'reviewP2C', 'claimsStart', 'openTransaction'].includes(call.method)));

  test('confirmed activity opens exact public details without a query or payment', async ({ page }) => {
    await page.clock.install();
    await openNativeWallet(page, { history: [confirmedHistory] });
    await page.clock.runFor(3000);
    const before = await publicAndPaymentCalls(page);
    await historyButton(page, confirmedHistory.txid).click();
    await expect(page.locator('#transaction-details')).toBeVisible();
    await expect(page.locator('#transaction-id')).toHaveText(confirmedHistory.txid);
    await expect(page.locator('#transaction-address')).toHaveText(address);
    await expect(page.locator('#transaction-status')).toHaveText('Confirmed');
    await expect(page.locator('#transaction-confirmations')).toHaveText('3');
    await expect(page.locator('#transaction-block')).toBeVisible();
    await expect(page.locator('#transaction-block-height')).toHaveText('121');
    await expect(page.locator('#transaction-block-hash')).toHaveText(confirmedHistory.block_hash);
    await expect(page.locator('#transaction-received')).toHaveText('1 CONN');
    await expect(page.locator('#transaction-spent')).toHaveText('0 CONN');
    await expect(page.locator('#transaction-net')).toHaveText('1 CONN');
    await expect(page.locator('#transaction-stale')).toBeHidden();
    await expect(page.locator('#transaction-open-explorer')).toBeEnabled();
    expect(await publicAndPaymentCalls(page)).toEqual(before);
  });

  test('pending activity hides nonexistent block details and retains exact fractional values', async ({ page }) => {
    const pending = { ...pendingHistory, received: '1234567891', balance_delta: '1234567891' };
    await openNativeWallet(page, { history: [pending] });
    await historyButton(page, pending.txid).click();
    await expect(page.locator('#transaction-status')).toHaveText('Unconfirmed');
    await expect(page.locator('#transaction-confirmations')).toHaveText('0');
    await expect(page.locator('#transaction-block')).toBeHidden();
    await expect(page.locator('#transaction-received')).toHaveText('0.1234567891 CONN');
    await expect(page.locator('#transaction-net')).toHaveText('0.1234567891 CONN');
  });

  test('outgoing activity shows address inputs and returned change rather than guessing a fee', async ({ page }) => {
    const outgoing = { ...confirmedHistory, received: '69999999999', spent: '100000000000', balance_delta: '-30000000001' };
    await openNativeWallet(page, { history: [outgoing] });
    await historyButton(page, outgoing.txid).click();
    await expect(page.locator('#transaction-received')).toHaveText('6.9999999999 CONN');
    await expect(page.locator('#transaction-spent')).toHaveText('10 CONN');
    await expect(page.locator('#transaction-net')).toHaveText('-3.0000000001 CONN');
    await expect(page.locator('#transaction-address')).toHaveText(address);
    // This RPC row has no recipient, timestamp or miner-fee field. The UI must
    // not invent any of those from the address's net balance change.
    await expect(page.locator('#transaction-details [data-field="fee"], #transaction-fee')).toHaveCount(0);
    expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'reviewPayment'))).toBe(false);
  });

  test('explorer opens only on the explicit action using only the transaction id', async ({ page }) => {
    await openNativeWallet(page, { history: [confirmedHistory, pendingHistory] });
    await historyButton(page, pendingHistory.txid).click();
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.plugin === 'NativeExplorer'))).toEqual([]);
    await page.locator('#transaction-open-explorer').click();
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.plugin === 'NativeExplorer'))).toEqual([
      { plugin: 'NativeExplorer', method: 'openTransaction', params: { txid: pendingHistory.txid } },
    ]);
    await expect(page.locator('#transaction-explorer-error')).toBeEmpty();
    await expectNoIntakePayment(page);
  });

  test('explorer failure is sanitized and can be retried', async ({ page }) => {
    await openNativeWallet(page, { history: [confirmedHistory], explorerError: 'EXPLORER_UNAVAILABLE' });
    await historyButton(page, confirmedHistory.txid).click();
    await page.locator('#transaction-open-explorer').click();
    await expect(page.locator('#transaction-explorer-error')).not.toBeEmpty();
    await expect(page.locator('#transaction-explorer-error')).not.toContainText('TEST_ONLY');
    await expect(page.locator('#transaction-explorer-error')).not.toContainText('payload');
    await expect(page.locator('#transaction-open-explorer')).toBeEnabled();
    await page.evaluate(() => { window.testNative.explorerError = null; });
    await page.locator('#transaction-open-explorer').click();
    await expect(page.locator('#transaction-explorer-error')).toBeEmpty();
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.plugin === 'NativeExplorer').length)).toBe(2);
  });

  test('explorer action is disabled while its launch is pending', async ({ page }) => {
    await openNativeWallet(page, { history: [confirmedHistory], deferredMethods: { openTransaction: true } });
    await historyButton(page, confirmedHistory.txid).click();
    await page.locator('#transaction-open-explorer').click();
    await expect(page.locator('#transaction-open-explorer')).toBeDisabled();
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.plugin === 'NativeExplorer').length)).toBe(1);
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#transaction-open-explorer')).toBeEnabled();
  });

  test('keyboard activation, Close, Escape and Android Back return to history without minimizing', async ({ page }) => {
    await page.clock.install();
    await openNativeWallet(page, { history: [confirmedHistory] });
    await page.clock.runFor(3000);
    const button = historyButton(page, confirmedHistory.txid);
    await button.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#transaction-details')).toBeVisible();
    await page.locator('#transaction-close').click();
    await expect(page.locator('#transaction-details')).toBeHidden();
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
    await expect(page.locator('#transaction-details')).toBeHidden();
    await expect(button).toBeFocused();
    await button.click();
    await page.evaluate(() => window.testNative.emit('App', 'backButton', {}));
    await expect(page.locator('#transaction-details')).toBeHidden();
    await expect(button).toBeFocused();
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'minimizeApp'))).toEqual([]);
  });

  test('tip changes update open details locally and focus returns to the rebuilt history row', async ({ page }) => {
    await page.clock.install();
    await openNativeWallet(page, { history: [confirmedHistory] });
    await page.clock.runFor(3000);
    await historyButton(page, confirmedHistory.txid).click();
    const before = await publicAndPaymentCalls(page);
    await page.evaluate(address => {
      const native = window.testNative;
      Object.assign(native.tip, { height: 126, hash: 'e'.repeat(64), mediantime: 1800000180 });
      native.emit('NativeWallet', 'walletChanged', { address, reason: 'tip', tip: { ...native.tip }, reorg: false });
    }, address);
    await expect(page.locator('#transaction-confirmations')).toHaveText('6');
    await expect(page.locator('#transaction-stale')).toBeHidden();
    expect(await publicAndPaymentCalls(page)).toEqual(before);
    await page.locator('#transaction-close').click();
    await expect(historyButton(page, confirmedHistory.txid)).toBeFocused();
  });

  test('the latest validated address event changes an open pending transaction to confirmed', async ({ page }) => {
    await page.clock.install();
    await openNativeWallet(page, { history: [pendingHistory] });
    await page.clock.runFor(3000);
    await historyButton(page, pendingHistory.txid).click();
    await page.evaluate(address => {
      const native = window.testNative;
      Object.assign(native.tip, { height: 124, hash: 'e'.repeat(64), mediantime: 1800000060 });
      native.history = native.history.map(row => ({ ...row, status: 'confirmed', block_height: 124, block_hash: native.tip.hash, confirmations: 1 }));
      native.emit('NativeWallet', 'walletChanged', { address, reason: 'address' });
    }, address);
    await page.clock.runFor(3000);
    await expect(page.locator('#transaction-details')).toBeVisible();
    await expect(page.locator('#transaction-status')).toHaveText('Confirmed');
    await expect(page.locator('#transaction-confirmations')).toHaveText('1');
    await expect(page.locator('#transaction-block-height')).toHaveText('124');
    await expect(page.locator('#transaction-block-hash')).toHaveText('e'.repeat(64));
    await expect(page.locator('#transaction-block')).toBeVisible();
  });

  test('a transaction removed by a validated history refresh closes the obsolete details', async ({ page }) => {
    await page.clock.install();
    await openNativeWallet(page, { history: [pendingHistory] });
    await page.clock.runFor(3000);
    await historyButton(page, pendingHistory.txid).click();
    await page.evaluate(address => {
      window.testNative.history = [];
      window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'address' });
    }, address);
    await page.clock.runFor(3000);
    await expect(page.locator('#history li')).toHaveCount(0);
    await expect(page.locator('#transaction-details')).toBeHidden();
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.plugin === 'NativeExplorer'))).toEqual([]);
  });

  test('account replacement closes details belonging to the old address', async ({ page }) => {
    await page.clock.install();
    await openNativeWallet(page, { history: [confirmedHistory] });
    await page.clock.runFor(3000);
    await historyButton(page, confirmedHistory.txid).click();
    await page.evaluate(otherAddress => { window.testNative.setAccount(otherAddress); }, otherAddress);
    await page.clock.runFor(3000);
    await expect(page.locator('#current-address')).toHaveText(otherAddress);
    await expect(page.locator('#transaction-details')).toBeHidden();
  });

  test('network disconnection marks public details stale instead of projecting fresh confirmations', async ({ page }) => {
    await page.clock.install();
    await openNativeWallet(page, { history: [confirmedHistory] });
    await page.clock.runFor(3000);
    await historyButton(page, confirmedHistory.txid).click();
    await page.evaluate(() => window.testNative.emit('Network', 'networkStatusChange', { connected: false, connectionType: 'none' }));
    await expect(page.locator('#transaction-stale')).toBeVisible();
    await expect(page.locator('#transaction-confirmations')).toHaveText('3');
    const before = await publicAndPaymentCalls(page);
    await page.clock.runFor(10000);
    expect(await publicAndPaymentCalls(page)).toEqual(before);
  });

  for (const viewport of [{ width: 320, height: 640 }, { width: 844, height: 390 }]) {
    test(`public details remain scrollable without horizontal overflow at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openNativeWallet(page, { history: [confirmedHistory] });
      await historyButton(page, confirmedHistory.txid).click();
      const dialog = page.locator('#transaction-details');
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      const box = await dialog.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
      await page.locator('#transaction-open-explorer').scrollIntoViewIfNeeded();
      await expect(page.locator('#transaction-open-explorer')).toBeInViewport();
      if (viewport.width === 320) await page.screenshot({ path: '.tools/artifacts/transaction-details-preview.png' });
      await page.locator('#transaction-open-explorer').click();
      expect(await page.evaluate(() => window.testNative.calls.filter(call => call.plugin === 'NativeExplorer').length)).toBe(1);
    });
  }
});

test('QR intake fills a blank draft with a canonical bare cc1p address while locked and never starts payment', async ({ page }) => {
  await openNativeWallet(page, { locked: true, scanResult: { text: otherAddress.toUpperCase() } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#scan-payment')).toBeEnabled();
  await expect(page.locator('#review-payment')).toBeDisabled();
  await page.locator('#scan-payment').click();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('');
  await expect(page.locator('#send-deduct-fees')).not.toBeChecked();
  await expect(page.locator('#incoming-payment')).toBeHidden();
  await expect(page.locator('#review-payment')).toBeDisabled();
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'scanPaymentQr')))
    .toEqual([{ plugin: 'NativePaymentInput', method: 'scanPaymentQr', params: {} }]);
  await expectNoIntakePayment(page);
});

test('QR URI intake displays exact amount and metadata without automatic review', async ({ page }) => {
  await openNativeWallet(page, { scanResult: { text: `connectcoin:${otherAddress}?amount=0.1234567891&label=Invoice&message=Order%2042` } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#scan-payment').click();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.1234567891');
  await expect(page.locator('#send-request-details')).toContainText('Invoice');
  await expect(page.locator('#send-request-details')).toContainText('Order 42');
  await expect(page.locator('#review-payment')).toBeEnabled();
  await expectNoIntakePayment(page);
  await page.screenshot({ path: 'test-results/mobile-scan-payment.png', fullPage: true });
});

test('QR cancellation is a no-op and camera denial offers sanitized feedback without changing a draft', async ({ page }) => {
  await openNativeWallet(page, { scanResult: { cancelled: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-amount').fill('0.2');
  await page.locator('#scan-payment').click();
  await expect(page.locator('#incoming-payment')).toBeHidden();
  await expect(page.locator('#payment-paste-error')).toBeEmpty();
  await expect(page.locator('#payment-input-error')).toBeEmpty();
  await page.evaluate(() => { window.testNative.scanError = 'CAMERA_PERMISSION_DENIED'; });
  await page.locator('#scan-payment').click();
  await expect(page.locator('#payment-paste-error')).not.toBeEmpty();
  await expect(page.locator('#payment-paste-error')).not.toContainText('TEST_ONLY');
  await expect(page.locator('#send-address')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('0.2');
  await expect(page.locator('#scan-payment')).toBeEnabled();
  await expectNoIntakePayment(page);
});

test('invalid QR results reject wrong-network, oversized and hostile input with fading global feedback', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  for (const result of [{ text: testnet }, { text: 'x'.repeat(1025) }, { text: 'javascript:PRIVATE_PAYLOAD_MARKER' },
    { text: `connectcoin://${address}` }, { error: 'INVALID_PAYMENT_LINK' }]) {
    await page.evaluate(result => { window.testNative.scanResult = result; }, result);
    await page.locator('#scan-payment').click();
    await expect(page.locator('#payment-input-error')).not.toBeEmpty();
    await expect(page.locator('#payment-input-error')).not.toContainText('PRIVATE_PAYLOAD_MARKER');
    await expect(page.locator('#send-address')).toHaveValue('');
    await expect(page.locator('#send-amount')).toHaveValue('');
    await expect(page.locator('#incoming-payment')).toBeHidden();
  }
  await page.clock.runFor(2999); await expect(page.locator('#payment-input-error')).not.toBeEmpty();
  await page.clock.runFor(1001); await expect(page.locator('#payment-input-error')).toBeEmpty();
  await expectNoIntakePayment(page);
});

test('QR automatically replaces an existing draft and clears old amount, fee and use-all state', async ({ page }) => {
  await openNativeWallet(page, { scanResult: { text: otherAddress } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await page.locator('#send-address').fill(address); await page.locator('#send-use-all').click();
  await page.locator('.send-fee-settings summary').click(); await page.locator('#send-fee-rate').fill('2500');
  await page.locator('#scan-payment').click();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('');
  await expect(page.locator('#send-deduct-fees')).not.toBeChecked();
  await expect(page.locator('#send-all-hint')).toBeHidden();
  await expect(page.locator('#send-fee-rate')).toHaveValue('1500');
  await expectNoIntakePayment(page);
});

test('cold and warm external connectcoin links automatically fill Send without signing', async ({ page }) => {
  await openNativeWallet(page, { initialPaymentLink: `connectcoin:${otherAddress}?amount=0.5&label=Cold` });
  await expect(page.locator('#send')).toBeVisible();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.5');
  await expect(page.locator('#send-request-details')).toContainText('Cold');
  await expectNoIntakePayment(page);
  await page.evaluate(text => window.testNative.setPaymentLink(text), `connectcoin:${address}?amount=0.75&label=Warm`);
  await expect(page.locator('#send-address')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('0.75');
  await expect(page.locator('#send-request-details')).toContainText('Warm');
  await expect(page.locator('#send-request-details')).not.toContainText('Cold');
  await page.screenshot({ path: 'test-results/mobile-auto-payment-link.png', fullPage: true });
  await expectNoIntakePayment(page);
});

test('a warm external link fills an empty draft from another screen without starting a payment', async ({ page }) => {
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await page.evaluate(text => window.testNative.setPaymentLink(text), `CONNECTCOIN:${otherAddress.toUpperCase()}?amount=1.2500`);
  await expect(page.locator('#send')).toBeVisible();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('1.25');
  await expectNoIntakePayment(page);
});

test('an external link received before native account setup fills Send automatically after setup', async ({ page }) => {
  await fakeNative(page, { exists: false, locked: true, accountAddress: null,
    initialPaymentLink: `connectcoin:${otherAddress}?amount=0.2` });
  await page.goto('/'); await waitReady(page);
  await expect(page.locator('#setup-panel')).toBeVisible();
  await expect(page.locator('#incoming-payment, #use-incoming-payment, #dismiss-incoming-payment')).toHaveCount(0);
  await expect(page.locator('#send-address')).toHaveValue('');
  await page.locator('#create-wallet').click();
  await expect(page.locator('#current-address')).toHaveText(address);
  await expect(page.locator('#send')).toBeVisible();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.2');
  await expectNoIntakePayment(page);
});

test('external links received in the background keep only the latest request and fill automatically on resume', async ({ page }) => {
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-amount').fill('0.1');
  await page.evaluate(() => window.testNative.emit('App', 'appStateChange', { isActive: false }));
  for (const amount of ['0.2', '0.3', '0.4']) {
    await page.evaluate(text => window.testNative.setPaymentLink(text), `connectcoin:${otherAddress}?amount=${amount}`);
    await expect.poll(() => page.evaluate(() => window.testNative.pendingPaymentLink)).toBeNull();
  }
  await expect(page.locator('#send-address')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('0.1');
  await page.evaluate(() => window.testNative.emit('App', 'appStateChange', { isActive: true }));
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.4');
  await expectNoIntakePayment(page);
});

test('external intake waits for native payment review then fills the latest request and preserves the receipt', async ({ page }) => {
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-amount').fill('0.1');
  await page.evaluate(() => { window.testNative.deferPayment = true; window.testNative.deferredMethods.reviewPayment = true; });
  await page.locator('#review-payment').click();
  await expect(page.locator('#send-progress')).toBeVisible();
  await expect(page.locator('#scan-payment')).toBeDisabled();
  for (const amount of ['0.2', '0.3']) {
    await page.evaluate(text => window.testNative.setPaymentLink(text), `connectcoin:${otherAddress}?amount=${amount}`);
    await expect.poll(() => page.evaluate(() => window.testNative.pendingPaymentLink)).toBeNull();
  }
  await expect(page.locator('#incoming-payment, #use-incoming-payment, #dismiss-incoming-payment')).toHaveCount(0);
  await expect(page.locator('#send-address')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('0.1');
  await expect(page.locator('#send-progress')).toBeVisible();
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').length)).toBe(1);
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'lock').length)).toBe(0);
  await page.evaluate(() => window.testNative.releaseResponses());
  await expect(page.locator('#send-progress')).toBeHidden();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.3');
  await expect(page.locator('#send-status')).toHaveText('submitted: ' + 'd'.repeat(64));
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').length)).toBe(1);
  expect(await page.evaluate(() => window.testNative.calls.find(call => call.method === 'reviewPayment').params.address)).toBe(address);
});

test('external metadata is automatically populated as literal text in Send, not HTML', async ({ page }) => {
  const label = '<img id="intake-pwned" src=x onerror="window.intakePwned=true">';
  const message = '<script>window.intakePwned=true</script>';
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-amount').fill('0.1');
  await page.evaluate(text => window.testNative.setPaymentLink(text),
    `connectcoin:${otherAddress}?label=${encodeURIComponent(label)}&message=${encodeURIComponent(message)}`);
  await expect(page.locator('#send-request-details')).toContainText(label);
  await expect(page.locator('#send-request-details')).toContainText(message);
  await expect(page.locator('#intake-pwned')).toHaveCount(0);
  expect(await page.evaluate(() => window.intakePwned)).toBeUndefined();
  await expect(page.locator('#send-amount')).toHaveValue('');
  await expectNoIntakePayment(page);
});

test('external bare addresses and invalid native link results leave the existing draft intact', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-amount').fill('0.1');
  for (const incoming of [otherAddress, `connectcoin:${testnet}`, 'https://example.com/PRIVATE_PAYLOAD_MARKER', { error: 'INVALID_PAYMENT_LINK' }]) {
    await page.evaluate(value => window.testNative.setPaymentLink(value), incoming);
    await expect(page.locator('#payment-input-error')).not.toBeEmpty();
    await expect(page.locator('#payment-input-error')).not.toContainText('PRIVATE_PAYLOAD_MARKER');
    await expect(page.locator('#send-address')).toHaveValue(address);
    await expect(page.locator('#send-amount')).toHaveValue('0.1');
    await expect(page.locator('#incoming-payment')).toBeHidden();
  }
  await page.clock.runFor(4000); await expect(page.locator('#payment-input-error')).toBeEmpty();
  await expectNoIntakePayment(page);
});

test('a newer external link invalidates a late QR result without replacing the newest request', async ({ page }) => {
  await openNativeWallet(page, { scanResult: { text: `connectcoin:${address}?amount=0.1` }, deferredMethods: { scanPaymentQr: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#scan-payment').click();
  await expect(page.locator('#scan-payment')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(value => value.method))).toContain('scanPaymentQr');
  await page.evaluate(text => window.testNative.setPaymentLink(text), `connectcoin:${otherAddress}?amount=0.2`);
  await expect.poll(() => page.evaluate(() => window.testNative.pendingPaymentLink)).toBeNull();
  await expect(page.locator('#send-address')).toHaveValue('');
  await page.evaluate(() => window.testNative.releaseResponses());
  await expect(page.locator('#scan-payment')).toBeEnabled();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.2');
  await expectNoIntakePayment(page);
});

test('changing native account invalidates a late camera result rather than moving the request to another wallet', async ({ page }) => {
  await page.clock.install();
  await openNativeWallet(page, { scanResult: { text: `connectcoin:${address}?amount=0.1` }, deferredMethods: { scanPaymentQr: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#scan-payment').click();
  await page.evaluate(value => window.testNative.setAccount(value), otherAddress);
  await page.clock.runFor(1500);
  await expect(page.locator('#current-address')).toHaveText(otherAddress);
  await page.evaluate(() => window.testNative.releaseResponses());
  await expect(page.locator('#scan-payment')).toBeEnabled();
  await expect(page.locator('#incoming-payment')).toBeHidden();
  await expect(page.locator('#send-address')).toHaveValue('');
  await expect(page.locator('#send-amount')).toHaveValue('');
  await expectNoIntakePayment(page);
});

test('a queued external request is discarded when its native wallet account is replaced before scan completion', async ({ page }) => {
  await page.clock.install();
  await openNativeWallet(page, { scanResult: { cancelled: true }, deferredMethods: { scanPaymentQr: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#scan-payment').click();
  await page.evaluate(text => window.testNative.setPaymentLink(text), `connectcoin:${address}?amount=0.2`);
  await expect.poll(() => page.evaluate(() => window.testNative.pendingPaymentLink)).toBeNull();
  await page.evaluate(value => window.testNative.setAccount(value), otherAddress);
  await page.clock.runFor(1500);
  await expect(page.locator('#current-address')).toHaveText(otherAddress);
  await page.evaluate(() => window.testNative.releaseResponses());
  await expect(page.locator('#scan-payment')).toBeEnabled();
  await expect(page.locator('#send-address')).toHaveValue('');
  await expect(page.locator('#send-amount')).toHaveValue('');
  await expectNoIntakePayment(page);
});

test('camera pause and wallet locking defer filling until the same account returns to the foreground', async ({ page }) => {
  await page.clock.install();
  await openNativeWallet(page, { scanResult: { text: `connectcoin:${otherAddress}?amount=0.1` }, deferredMethods: { scanPaymentQr: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#scan-payment').click();
  await page.evaluate(() => {
    window.testNative.emit('App', 'appStateChange', { isActive: false });
    window.testNative.vault.locked = true;
    window.testNative.releaseResponses();
  });
  await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(value => value.method))).not.toContain('scanPaymentQr');
  await expect(page.locator('#send-address')).toHaveValue('');
  await page.evaluate(() => window.testNative.emit('App', 'appStateChange', { isActive: true }));
  await page.clock.runFor(1500);
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.1');
  await expect(page.locator('#review-payment')).toBeDisabled();
  await expectNoIntakePayment(page);
});

test('a pre-camera unlocked poll cannot restore unlocked UI after pause and resume', async ({ page }) => {
  await page.clock.install();
  await openNativeWallet(page, { scanResult: { text: `connectcoin:${otherAddress}?amount=0.1` }, deferredMethods: { scanPaymentQr: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#vault-status')).toContainText('Unlocked');
  // Capture the unlocked snapshot now, not at the time we release the promise.
  await page.evaluate(() => { window.testNative.deferredMethods.getState = true; });
  await page.clock.runFor(1000);
  await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(value => value.method))).toContain('getState');
  await page.locator('#scan-payment').click();
  await page.evaluate(() => {
    const native = window.testNative;
    native.emit('App', 'appStateChange', { isActive: false });
    native.vault.locked = true;
    native.emit('App', 'appStateChange', { isActive: true });
  });
  await expect(page.locator('#vault-status')).toContainText('Wallet locked');
  await page.evaluate(() => {
    const native = window.testNative;
    const index = native.pendingResponses.findIndex(value => value.method === 'getState');
    native.pendingResponses.splice(index, 1)[0].resolve();
  });
  // No later timer tick may conceal an incorrect transient unlocked state.
  await page.clock.runFor(10);
  await expect(page.locator('#vault-status')).toContainText('Wallet locked');
  await expect(page.locator('#unlock-wallet')).toBeVisible();
  await expect(page.locator('#review-payment')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(value => value.method))).toEqual(['scanPaymentQr']);
  await page.evaluate(() => window.testNative.releaseResponses());
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#scan-payment')).toBeEnabled();
  await expect(page.locator('#vault-status')).toContainText('Wallet locked');
  await expect(page.locator('#review-payment')).toBeDisabled();
  await expectNoIntakePayment(page);
});

test('camera return obtains fresh native lock state even while an older periodic poll remains pending', async ({ page }) => {
  await page.clock.install();
  await openNativeWallet(page, { scanResult: { text: `connectcoin:${otherAddress}?amount=0.1` }, deferredMethods: { scanPaymentQr: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => { window.testNative.deferredMethods.getState = true; });
  await page.clock.runFor(1000);
  await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(value => value.method))).toEqual(['getState']);
  await page.locator('#scan-payment').click();
  const before = await page.evaluate(() => window.testNative.calls.filter(value => value.method === 'getState').length);
  await page.evaluate(() => {
    const native = window.testNative;
    // Simulate the native camera locking before the renderer receives a pause
    // notification. The scan callback must fetch state itself, not skip a busy poll.
    native.vault.locked = true;
    const index = native.pendingResponses.findIndex(value => value.method === 'scanPaymentQr');
    native.pendingResponses.splice(index, 1)[0].resolve();
  });
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  expect(await page.evaluate(() => window.testNative.calls.filter(value => value.method === 'getState').length)).toBe(before + 1);
  await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(value => value.method))).toEqual(['getState']);
  await expect(page.locator('#vault-status')).toContainText('Wallet locked');
  await expect(page.locator('#unlock-wallet')).toBeVisible();
  await expect(page.locator('#review-payment')).toBeDisabled();
  await page.evaluate(() => window.testNative.releaseResponses());
  await page.clock.runFor(10);
  await expect(page.locator('#vault-status')).toContainText('Wallet locked');
  await expect(page.locator('#review-payment')).toBeDisabled();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expectNoIntakePayment(page);
});

test('maximum-length incoming metadata stays literal and fits a narrow mobile screen', async ({ page }) => {
  const label = '<img id="intake-overflow" onerror="window.intakePwned=true">'.padEnd(100, 'X');
  const message = '<script>window.intakePwned=true</script>'.padEnd(200, 'Y');
  await page.setViewportSize({ width: 320, height: 740 });
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-amount').fill('0.1');
  await page.evaluate(text => window.testNative.setPaymentLink(text),
    `connectcoin:${otherAddress}?label=${encodeURIComponent(label)}&message=${encodeURIComponent(message)}`);
  await expect(page.locator('#send-request-details')).toContainText(label);
  await expect(page.locator('#send-request-details')).toContainText(message);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#intake-overflow')).toHaveCount(0);
  expect(await page.evaluate(() => window.intakePwned)).toBeUndefined();
  await expectNoIntakePayment(page);
});

test('RPC address notifications update Use all automatically without changing the payment draft', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.clock.runFor(300); await page.locator('#send-use-all').click();
  await page.evaluate(address => {
    Object.assign(window.testNative.balance, { confirmed: '20000000000', available_confirmed: '20000000000', total: '20000000000' });
    for (let index = 0; index < 20; index++) window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'address' });
  }, address);
  await page.clock.runFor(2500);
  await expect(page.locator('#send-available')).toHaveText('Available: 2 CONN');
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await expect(page.locator('#send-amount')).toHaveValue('1');
  await page.locator('#send-use-all').click(); await expect(page.locator('#send-amount')).toHaveValue('2');
  const count = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length);
  await page.clock.runFor(60000);
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length)).toBe(count);
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'reviewPayment'))).toBe(false);
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'watchAccount').every(call => Object.keys(call.params).length === 0))).toBe(true);
});

test('unrelated blocks never refresh the balance but an owned-address event still does', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.clock.runFor(3000);
  await expect(page.locator('#send-use-all')).toBeEnabled();
  const before = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length);
  await page.evaluate(({ address, otherAddress }) => {
    for (let index = 0; index < 100; index++) {
      window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'tip' });
      window.testNative.emit('NativeWallet', 'walletChanged', { address: otherAddress, reason: 'address' });
    }
  }, { address, otherAddress });
  await page.clock.runFor(120000);
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length)).toBe(before);
  await expect(page.locator('#send-balance-status')).toBeEmpty();
  await page.evaluate(address => {
    Object.assign(window.testNative.balance, { confirmed: '20000000000', available_confirmed: '20000000000', total: '20000000000' });
    window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'address' });
  }, address);
  await page.clock.runFor(1000);
  await expect(page.locator('#send-available')).toHaveText('Available: 2 CONN');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length)).toBe(before + 3);
});

test('ordinary tip events advance confirmed activity locally without balance reads or disabling Use all', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page, { history: [confirmedHistory, pendingHistory] });
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.clock.runFor(3000);
  await expect(page.locator('#send-use-all')).toBeEnabled();
  const confirmed = page.locator('#history li').filter({ hasText: confirmedHistory.txid }).locator('.state');
  const pending = page.locator('#history li').filter({ hasText: pendingHistory.txid }).locator('.state');
  await expect(confirmed).toHaveText('3 confirmations');
  await expect(pending).toHaveText('Unconfirmed');
  const before = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length);
  await page.evaluate(address => {
    const native = window.testNative;
    window.testTipUiChanges = [];
    new MutationObserver(() => window.testTipUiChanges.push({
      disabled: document.querySelector('#send-use-all').disabled,
      status: document.querySelector('#send-balance-status').textContent,
    })).observe(document.querySelector('#send'), { attributes: true, childList: true, subtree: true });
    for (let height = 124; height <= 223; height++) {
      Object.assign(native.tip, { height, hash: height.toString(16).padStart(64, '0'), mediantime: 1800000000 + height });
      native.emit('NativeWallet', 'walletChanged', { address, reason: 'tip', tip: { ...native.tip }, reorg: false, resync_required: false });
    }
  }, address);
  await page.clock.runFor(120000);
  await expect(confirmed).toHaveText('103 confirmations');
  await expect(pending).toHaveText('Unconfirmed');
  await expect(page.locator('#block-height')).toContainText('223');
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await expect(page.locator('#send-balance-status')).toBeEmpty();
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length)).toBe(before);
  const changes = await page.evaluate(() => window.testTipUiChanges);
  expect(changes.length).toBeGreaterThan(0);
  expect(changes.every(change => !change.disabled && !change.status.includes('Updating balance'))).toBe(true);
});

test('owned-address events validate both balance and activity after local tip updates', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page, { history: [pendingHistory] });
  await page.clock.runFor(3000);
  const row = page.locator('#history li').filter({ hasText: pendingHistory.txid }).locator('.state');
  await expect(row).toHaveText('Unconfirmed');
  const before = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length);
  await page.evaluate(address => {
    const native = window.testNative;
    Object.assign(native.tip, { height: 124, hash: 'e'.repeat(64), mediantime: 1800000060 });
    native.emit('NativeWallet', 'walletChanged', { address, reason: 'tip', tip: { ...native.tip } });
    native.history = native.history.map(row => ({ ...row, status: 'confirmed', block_height: 124, block_hash: native.tip.hash, confirmations: 1 }));
    native.emit('NativeWallet', 'walletChanged', { address, reason: 'address' });
  }, address);
  await page.clock.runFor(3000);
  await expect(row).toHaveText('1 confirmations');
  expect(await page.evaluate(before => window.testNative.calls.filter(call => call.method === 'queryPublic')
    .slice(before).map(call => call.params.method), before)).toEqual(['getchaintip', 'getaddressbalance', 'getaddresshistory']);
});

test('reorg tips cannot project old activity while the replacement baseline is still loading', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page, { history: [confirmedHistory] });
  await page.clock.runFor(3000);
  await page.evaluate(address => {
    const native = window.testNative;
    native.deferredMethods.history = true;
    native.history = [{ ...native.history[0], status: 'pending', block_height: null, block_hash: null, confirmations: 0 }];
    Object.assign(native.tip, { hash: 'e'.repeat(64), mediantime: 1800000060 });
    native.emit('NativeWallet', 'walletChanged', { address, reason: 'tip', tip: { ...native.tip }, reorg: true });
  }, address);
  await page.clock.runFor(3000);
  await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.some(item => item.method === 'history'))).toBe(true);
  const before = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length);
  await page.evaluate(address => {
    const native = window.testNative;
    Object.assign(native.tip, { height: 125, hash: 'f'.repeat(64), mediantime: 1800000120 });
    native.emit('NativeWallet', 'walletChanged', { address, reason: 'tip', tip: { ...native.tip }, reorg: false });
  }, address);
  await page.clock.runFor(5000);
  await expect(page.locator('#history')).not.toContainText('5 confirmations');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length)).toBe(before);
  await page.evaluate(() => window.testNative.releaseResponses()); await page.clock.runFor(3000);
  await expect(page.locator('#history li').filter({ hasText: confirmedHistory.txid }).locator('.state')).toHaveText('Unconfirmed');
});

test('a reconnect revalidates activity before using newer tips for confirmation projection', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page, { history: [confirmedHistory] });
  await page.clock.runFor(3000);
  await page.evaluate(address => {
    const native = window.testNative;
    native.emit('NativeWallet', 'walletChanged', { address, reason: 'disconnected' });
    native.deferredMethods.history = true;
    native.history = [];
    Object.assign(native.tip, { height: 130, hash: 'e'.repeat(64), mediantime: 1800000060 });
    native.emit('NativeWallet', 'walletChanged', { address, reason: 'connected', tip: { ...native.tip }, resync_required: true });
  }, address);
  await page.clock.runFor(3000);
  await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.some(item => item.method === 'history'))).toBe(true);
  await page.evaluate(address => {
    const native = window.testNative;
    Object.assign(native.tip, { height: 131, hash: 'f'.repeat(64), mediantime: 1800000120 });
    native.emit('NativeWallet', 'walletChanged', { address, reason: 'tip', tip: { ...native.tip } });
  }, address);
  await page.clock.runFor(3000);
  await expect(page.locator('#history')).not.toContainText('11 confirmations');
  await page.evaluate(() => window.testNative.releaseResponses()); await page.clock.runFor(3000);
  await expect(page.locator('#history li')).toHaveCount(0);
});

test('resume and RPC reconnection restore Use all without a manual refresh', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.clock.runFor(300);
  await page.evaluate(() => window.testNative.emit('App', 'appStateChange', { isActive: false }));
  await expect(page.locator('#send-use-all')).toBeDisabled();
  const count = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length);
  await page.clock.runFor(60000);
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length)).toBe(count);
  await page.evaluate(() => window.testNative.emit('App', 'appStateChange', { isActive: true }));
  await page.clock.runFor(2500); await expect(page.locator('#send-use-all')).toBeEnabled();
  await page.evaluate(address => window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'disconnected' }), address);
  // Revalidate after an established watch disconnects: chain/address changes
  // could have been missed while the notification channel was unavailable.
  await expect(page.locator('#send-use-all')).toBeDisabled();
  await page.evaluate(address => window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'connected' }), address);
  await page.clock.runFor(2500); await expect(page.locator('#send-use-all')).toBeEnabled();
});

test('startup recovers a failed initial snapshot without a subscription ACK or manual Refresh', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page, { watchConnected: false, historyFailures: 1, history: [confirmedHistory] });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.clock.runFor(1500);
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await expect(page.locator('#send-available')).toHaveText('Available: 1 CONN');
  await page.locator('#send-use-all').click(); await expect(page.locator('#send-amount')).toHaveValue('1');
  // Balance recovery is usable immediately; then one bounded full baseline
  // repairs the failed history before the scheduler becomes idle again.
  await page.clock.runFor(3000);
  await expect(page.locator('#history li').filter({ hasText: confirmedHistory.txid }).locator('.state')).toHaveText('3 confirmations');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic' && call.params.method === 'getaddresshistory').length)).toBe(2);
  const count = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length);
  await page.clock.runFor(120000);
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length)).toBe(count);
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'reviewPayment'))).toBe(false);
});

test('failed watch registrations cannot cancel the initial balance query or disable a verified balance', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page, { watchConnected: false, deferredMethods: { balance: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#send-use-all')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.length)).toBe(1);
  await page.evaluate(address => {
    for (let index = 0; index < 4; index++) window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'disconnected' });
    window.testNative.releaseResponses();
  }, address);
  await page.clock.runFor(3000); await expect(page.locator('#send-use-all')).toBeEnabled();
  const count = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length);
  await page.evaluate(address => window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'disconnected' }), address);
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await page.clock.runFor(60000);
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length)).toBe(count);
});

test('a stale watch setup response cannot block resume catch-up or notifications for the same account', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page, { watchConnected: false, deferredMethods: { watchAccount: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.clock.runFor(3000);
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await page.evaluate(() => window.testNative.emit('App', 'appStateChange', { isActive: false }));
  await expect(page.locator('#send-use-all')).toBeDisabled();
  await page.evaluate(() => {
    window.testNative.watchConnected = true;
    window.testNative.emit('App', 'appStateChange', { isActive: true });
    window.testNative.releaseResponses();
  });
  await page.clock.runFor(3000); await expect(page.locator('#send-use-all')).toBeEnabled();
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'watchAccount').length)).toBe(2);
  await page.evaluate(address => {
    Object.assign(window.testNative.balance, { confirmed: '20000000000', available_confirmed: '20000000000', total: '20000000000' });
    window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'address' });
  }, address);
  await page.clock.runFor(2500); await expect(page.locator('#send-available')).toHaveText('Available: 2 CONN');
});

test('resume verifies funds even when the notification channel still has not connected', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page, { watchConnected: false });
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.clock.runFor(3000);
  await page.evaluate(() => window.testNative.emit('App', 'appStateChange', { isActive: false }));
  await expect(page.locator('#send-use-all')).toBeDisabled();
  await page.evaluate(() => {
    Object.assign(window.testNative.balance, { confirmed: '20000000000', available_confirmed: '20000000000', total: '20000000000' });
    window.testNative.emit('App', 'appStateChange', { isActive: true });
  });
  await page.clock.runFor(3000); await expect(page.locator('#send-use-all')).toBeEnabled();
  await expect(page.locator('#send-available')).toHaveText('Available: 2 CONN');
});

test('slow notification refresh keeps Use all enabled and events during a read are not lost', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.clock.runFor(3000);
  await page.evaluate(address => {
    window.testNative.deferredMethods.balance = true;
    window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'address' });
  }, address);
  await page.clock.runFor(300);
  await expect(page.locator('#send-balance-status')).toHaveText('Updating balance…');
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await page.evaluate(address => {
    Object.assign(window.testNative.balance, { confirmed: '30000000000', available_confirmed: '30000000000', total: '30000000000' });
    window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'address' });
    window.testNative.releaseResponses();
  }, address);
  await page.clock.runFor(2500);
  await expect(page.locator('#send-available')).toHaveText('Available: 3 CONN');
});

test('notifications wait for native review and a receipt refreshes available funds without another event', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.clock.runFor(3000);
  await page.locator('#send-address').fill(address); await page.locator('#send-use-all').click();
  await page.evaluate(() => { window.testNative.deferPayment = true; window.testNative.deferredMethods.reviewPayment = true; });
  await page.locator('#review-payment').click();
  const count = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length);
  await page.evaluate(address => window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'address' }), address);
  await page.clock.runFor(6000);
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length)).toBe(count);
  await page.evaluate(() => { for (const key of Object.keys(window.testNative.balance)) window.testNative.balance[key] = '0'; window.testNative.releaseResponses(); });
  await page.clock.runFor(2500);
  await expect(page.locator('#send-status')).toHaveText('submitted: ' + 'd'.repeat(64));
  await expect(page.locator('#send-available')).toHaveText('Available: 0 CONN');
  await expect(page.locator('#send-use-all')).toBeDisabled();
});

test('a failed notification refresh retries automatically with backoff rather than polling continuously', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.clock.runFor(3000);
  await page.evaluate(address => { window.testNative.rpcUnavailable = true; window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'address' }); }, address);
  await page.clock.runFor(500); await expect(page.locator('#send-use-all')).toBeDisabled();
  const count = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length);
  await page.evaluate(() => { window.testNative.rpcUnavailable = false; });
  await page.clock.runFor(59000);
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length)).toBe(count);
  await page.clock.runFor(2000); await expect(page.locator('#send-use-all')).toBeEnabled();
});

test('a failed manual refresh recovers automatically even when the subscription stays quiet', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.clock.runFor(3000);
  await page.evaluate(() => { window.testNative.rpcUnavailable = true; });
  await page.locator('#send-refresh-balance').click(); await expect(page.locator('#send-use-all')).toBeDisabled();
  const count = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length);
  await page.evaluate(() => { window.testNative.rpcUnavailable = false; });
  await page.clock.runFor(59000);
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').length)).toBe(count);
  await page.clock.runFor(2000); await expect(page.locator('#send-use-all')).toBeEnabled();
});

test('Send use all fills only available confirmed funds and enables fee deduction', async ({ page }) => {
  await openNativeWallet(page, { balance: { confirmed: '92345678901', immature: '70000000000', available_confirmed: '12345678901',
    pending_received: '30000000000', pending_spent: '10000000000', pending_delta: '20000000000', total: '112345678901' } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await expect(page.locator('#send-available')).toHaveText('Available: 1.2345678901 CONN');
  await expect(page.locator('#send-deduct-fees')).not.toBeChecked();
  await expect(page.locator('#send-fee-rate')).toHaveValue('1500');
  await page.locator('#send-address').fill(address);
  await page.locator('#send-use-all').click();
  await expect(page.locator('#send-amount')).toHaveValue('1.2345678901');
  await expect(page.locator('#send-deduct-fees')).toBeChecked();
  await expect(page.locator('#send-all-hint')).toBeVisible();
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'reviewPayment'))).toBe(false);
  await page.locator('#review-payment').click();
  await expect(page.locator('#send-status')).toContainText('native payment review cancelled');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment')))
    .toEqual([{ plugin: 'NativeWallet', method: 'reviewPayment', params: { address, amount: '1.2345678901', feeRate: '1500', subtractFeeFromAmount: true, useAllBalance: true } }]);
});

test('Send manual amount, independent deduction and custom fee modes stay separate from P2C', async ({ page }) => {
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address);
  await page.locator('#send-use-all').click();
  await page.locator('#send-amount').fill('0,5');
  await expect(page.locator('#send-all-hint')).toBeHidden();
  await expect(page.locator('#send-deduct-fees')).toBeChecked();
  await page.locator('.send-fee-settings summary').click();
  await page.locator('#send-fee-rate').fill('02500.');
  await page.locator('#review-payment').click();
  await expect(page.locator('#send-status')).toContainText('native payment review cancelled');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').at(-1).params))
    .toEqual({ address, amount: '0.5', feeRate: '2500', subtractFeeFromAmount: true, useAllBalance: false });
  await page.locator('#send-use-all').click();
  await page.locator('#send-deduct-fees').uncheck();
  await expect(page.locator('#send-all-hint')).toBeHidden();
  await page.locator('#send-amount').fill('0.4.'); // Invalid edit must not be accepted.
  await page.locator('#send-amount').fill('0.4');
  await page.locator('#review-payment').click();
  await expect(page.locator('#send-status')).toContainText('native payment review cancelled');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').at(-1).params))
    .toEqual({ address, amount: '0.4', feeRate: '2500', subtractFeeFromAmount: false, useAllBalance: false });
  await page.getByRole('button', { name: 'P2C', exact: true }).click();
  await page.locator('#p2c-domain').fill('example.com'); await page.locator('#p2c-amount').fill('1');
  await page.locator('#review-p2c').click();
  await expect(page.locator('#p2c-status')).toContainText('native P2C review cancelled');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewP2C').at(-1).params))
    .toEqual({ domain: 'example.com', amount: '1', expectedConnections: '1' });
});

test('Send rejects out of range fee rates and blocks invalid numeric edits before native review', async ({ page }) => {
  await openNativeWallet(page); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-amount').fill('1.');
  await page.locator('.send-fee-settings summary').click();
  for (const rate of ['', '0', '1200', '100001']) {
    await page.locator('#send-fee-rate').fill(rate); await page.locator('#review-payment').click();
    await expect(page.locator('#send-status')).toContainText('1,201 to 100,000');
  }
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'reviewPayment'))).toBe(false);
  await page.locator('#send-fee-rate').fill('1500');
  await page.locator('#send-fee-rate').pressSequentially('x');
  await expect(page.locator('#send-fee-rate')).toHaveValue('1500');
  await page.locator('#send-fee-rate').pressSequentially('.5');
  await expect(page.locator('#send-fee-rate')).toHaveValue('1500.');
  for (const rate of ['1201', '100000']) {
    await page.locator('#send-fee-rate').fill(rate); await page.locator('#review-payment').click();
    await expect(page.locator('#send-status')).toContainText('native payment review cancelled');
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').at(-1).params.feeRate)).toBe(rate);
  }
});

test('Use all fills a locked wallet draft but cannot review or sign, including after changing tabs', async ({ page }) => {
  await openNativeWallet(page, { locked: true }); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await expect(page.locator('#vault-status')).toContainText('Wallet locked');
  await page.locator('#send-address').fill(address); await page.locator('#send-use-all').click();
  await expect(page.locator('#send-amount')).toHaveValue('1'); await expect(page.locator('#send-deduct-fees')).toBeChecked();
  await expect(page.locator('#review-payment')).toBeDisabled();
  // Even a synthetic submit cannot bypass the native unlock requirement.
  await page.locator('#send-form').dispatchEvent('submit');
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'reviewPayment'))).toBe(false);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-refresh-balance').click();
  await expect(page.locator('#send-use-all')).toBeEnabled(); await expect(page.locator('#review-payment')).toBeDisabled();
  await page.locator('#unlock-wallet').click(); await expect(page.locator('#review-payment')).toBeEnabled();
});

for (const section of ['Send', 'P2C']) {
  const prefix = section === 'P2C' ? 'p2c-' : '';
  test(`${section} shows only the matching wallet action after unlock, lock, polling and navigation`, async ({ page }) => {
    await page.clock.install(); await openNativeWallet(page, { locked: true });
    await page.getByRole('button', { name: section, exact: true }).click();
    await expectWalletActions(page, true);
    await page.locator(`#${prefix}unlock-wallet`).click();
    await expectWalletActions(page, false);
    for (const destination of ['Receive', section === 'Send' ? 'P2C' : 'Send', section]) {
      await page.getByRole('button', { name: destination, exact: true }).click();
      await expectWalletActions(page, false);
    }
    await page.clock.runFor(2000); await expectWalletActions(page, false);
    await page.locator(`#${prefix}lock-wallet`).click();
    await expectWalletActions(page, true);
    await page.evaluate(() => { window.testNative.vault.locked = false; });
    await page.clock.runFor(1000); await expectWalletActions(page, false);
    await page.evaluate(() => { window.testNative.vault.locked = true; });
    await page.clock.runFor(1000); await expectWalletActions(page, true);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('button', { name: section, exact: true }).click();
    await expectWalletActions(page, true);
  });

  test(`${section} can cancel a pending unlock without offering Lock for a locked wallet`, async ({ page }) => {
    await openNativeWallet(page, { locked: true, deferredMethods: { unlock: true }, cancelPendingOnLock: true });
    await page.getByRole('button', { name: section, exact: true }).click();
    await page.locator(`#${prefix}unlock-wallet`).click();
    await expect(page.locator(`#${prefix}unlock-wallet`)).toBeVisible();
    await expect(page.locator(`#${prefix}unlock-wallet`)).toBeDisabled();
    await expect(page.locator(`#${prefix}lock-wallet`)).toBeVisible();
    await expect(page.locator(`#${prefix}lock-wallet`)).toHaveText('Cancel');
    await expect(page.locator(`#${prefix}lock-wallet`)).toBeEnabled();
    await page.locator(`#${prefix}lock-wallet`).click();
    await expectWalletActions(page, true);
    await expect(page.locator('#global-error')).toBeEmpty();
    expect(await page.evaluate(() => window.testNative.calls.filter(call => ['unlock', 'lock'].includes(call.method)).map(call => call.method)))
      .toEqual(['unlock', 'lock']);
    expect(await page.evaluate(() => window.testNative.vault.locked)).toBe(true);
  });

  test(`${section} keeps Lock available to cancel an active native review`, async ({ page }) => {
    await openNativeWallet(page, { cancelPendingOnLock: true });
    await page.getByRole('button', { name: section, exact: true }).click();
    const review = section === 'Send' ? 'reviewPayment' : 'reviewP2C';
    if (section === 'Send') {
      await page.locator('#send-address').fill(address); await page.locator('#send-amount').fill('0.1');
    } else {
      await page.locator('#p2c-domain').fill('example.com'); await page.locator('#p2c-amount').fill('0.1');
    }
    await page.evaluate(review => {
      window.testNative.deferPayment = true; window.testNative.deferP2C = true;
      window.testNative.deferredMethods[review] = true;
    }, review);
    await page.locator(section === 'Send' ? '#review-payment' : '#review-p2c').click();
    await expect(page.locator(`#${prefix}unlock-wallet`)).toBeHidden();
    await expect(page.locator(`#${prefix}lock-wallet`)).toHaveText('Lock');
    await expect(page.locator(`#${prefix}lock-wallet`)).toBeEnabled();
    await page.locator(`#${prefix}lock-wallet`).click();
    await expectWalletActions(page, true);
    await expect(page.locator(section === 'Send' ? '#send-progress' : '#p2c-progress')).toBeHidden();
    await expect(page.locator(section === 'Send' ? '#send-status' : '#p2c-status')).toBeEmpty();
    await expect(page.locator('#global-error')).toBeEmpty();
    expect(await page.evaluate(review => window.testNative.calls.filter(call => call.method === review).length, review)).toBe(1);
  });
}

test('an older locked state poll cannot restore Unlock after a successful unlock', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page, { locked: true });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(() => { window.testNative.deferredMethods = { getState: true, claimsState: true }; });
  await page.clock.runFor(1000);
  await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(item => item.method).sort()))
    .toEqual(['claimsState', 'getState']);
  await page.locator('#unlock-wallet').click(); await expectWalletActions(page, false);
  await page.evaluate(() => window.testNative.releaseResponses());
  await page.clock.runFor(1000); await expectWalletActions(page, false);
  await page.getByRole('button', { name: 'P2C', exact: true }).click();
  await expect(page.locator('#p2c-vault-status')).toContainText('Unlocked');
  await expectWalletActions(page, false);
});

test('Use all is unavailable for stale, offline, unavailable or zero balances', async ({ page }) => {
  await openNativeWallet(page, { locked: true }); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await page.evaluate(() => window.testNative.emit('Network', 'networkStatusChange', { connected: false, connectionType: 'none' }));
  await expect(page.locator('#send-use-all')).toBeDisabled();
  await page.evaluate(() => window.testNative.emit('Network', 'networkStatusChange', { connected: true, connectionType: 'wifi' }));
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await page.evaluate(() => { window.testNative.rpcUnavailable = true; });
  await page.locator('#send-refresh-balance').click(); await expect(page.locator('#send-use-all')).toBeDisabled();
  await page.evaluate(() => { window.testNative.rpcUnavailable = false; for (const key of Object.keys(window.testNative.balance)) window.testNative.balance[key] = '0'; });
  await page.locator('#send-refresh-balance').click();
  await expect(page.locator('#send-available')).toHaveText('Available: 0 CONN');
  await expect(page.locator('#send-use-all')).toBeDisabled();
});

test('Send Refresh repairs a history failure without querying history again', async ({ page }) => {
  await page.clock.install(); await openNativeWallet(page);
  await page.clock.runFor(3000);
  await page.evaluate(() => { window.testNative.historyFailures = 10; });
  await page.locator('#refresh').click();
  await expect(page.locator('#wallet-error')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#send-use-all')).toBeDisabled();
  const before = await page.evaluate(() => window.testNative.calls.length);
  await page.locator('#send-refresh-balance').click(); await expect(page.locator('#send-use-all')).toBeEnabled();
  await expect(page.locator('#send-available')).toHaveText('Available: 1 CONN');
  expect(await page.evaluate(before => window.testNative.calls.slice(before)
    .filter(call => call.method === 'queryPublic').map(call => call.params.method), before)).toEqual(['getchaintip', 'getaddressbalance']);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#send-use-all')).toBeEnabled();
});

test('explicit review cancellation restores Send controls without a red error or locking the vault', async ({ page }) => {
  const previousTxid = 'e'.repeat(64);
  await openNativeWallet(page, { lastPayment: { txid: previousTxid, status: 'check-required' } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-use-all').click();
  await page.evaluate(() => { window.testNative.cancelPayment = true; });
  await page.locator('#review-payment').click();
  await expect.poll(() => page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').length)).toBe(1);
  await expect(page.locator('#review-payment')).toBeEnabled(); await expect(page.locator('#send-progress')).toBeHidden();
  await expect(page.locator('#send-status')).toBeEmpty(); await expect(page.locator('#vault-status')).toContainText('Unlocked');
  await expect(page.locator('#last-payment')).toHaveCount(0);
  expect(await page.evaluate(async () => (await window.Capacitor.nativePromise('NativeWallet', 'getState')).lastPayment))
    .toEqual({ txid: previousTxid, status: 'check-required' });
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#send-use-all')).toBeEnabled();
  await page.locator('#send-refresh-balance').click(); await expect(page.locator('#send-use-all')).toBeEnabled();
  await page.locator('#send-use-all').click(); await expect(page.locator('#send-amount')).toHaveValue('1');
  // Do not swallow real native errors, even if their text happens to be Cancelled.
  await page.evaluate(() => { window.testNative.cancelPayment = false; window.testNative.paymentError = 'Cancelled.'; });
  await page.locator('#review-payment').click(); await expect(page.locator('#send-status')).toHaveText('Cancelled.');
});

test('Use all never silently increases a filled amount when balance refreshes', async ({ page }) => {
  await openNativeWallet(page); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-use-all').click();
  await page.evaluate(() => {
    Object.assign(window.testNative.balance, { confirmed: '20000000000', available_confirmed: '20000000000', total: '20000000000' });
    window.testNative.paymentError = 'TEST_ONLY: Available funds changed or are reserved. Refresh and review again.';
  });
  await page.locator('#send-refresh-balance').click(); await expect(page.locator('#send-available')).toHaveText('Available: 2 CONN');
  await expect(page.locator('#send-amount')).toHaveValue('1');
  await page.locator('#review-payment').click();
  await expect(page.locator('#send-status')).toContainText('Refresh and review again');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').at(-1).params.amount)).toBe('1');
  await page.locator('#send-use-all').click(); await expect(page.locator('#send-amount')).toHaveValue('2');
});

test('Send locks draft during review, prevents duplicates, and invalidates balance after a receipt', async ({ page }) => {
  await openNativeWallet(page); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-use-all').click();
  await page.evaluate(() => { window.testNative.deferPayment = true; window.testNative.deferredMethods.reviewPayment = true; });
  await page.locator('#review-payment').click();
  for (const id of ['review-payment', 'send-address', 'send-amount', 'send-fee-rate', 'send-deduct-fees', 'paste-payment', 'send-use-all', 'send-refresh-balance']) {
    await expect(page.locator('#' + id)).toBeDisabled();
  }
  await expect(page.locator('#send-progress')).toBeVisible(); await expect(page.locator('#lock-wallet')).toBeEnabled();
  await page.locator('#send-form').dispatchEvent('submit');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').length)).toBe(1);
  await page.evaluate(() => { window.testNative.failState = true; window.testNative.rpcUnavailable = true; window.testNative.releaseResponses(); });
  await expect(page.locator('#send-status')).toHaveText('submitted: ' + 'd'.repeat(64));
  await expect(page.locator('#global-error')).toContainText('Keep any transaction ID');
  await expect(page.locator('#send-progress')).toBeHidden(); await expect(page.locator('#send-use-all')).toBeDisabled();
  await expect(page.locator('#send-all-hint')).toBeHidden();
});

test('a payment cancelled before RPC transmission reports not-sent without an unknown outcome or automatic retry', async ({ page }) => {
  await openNativeWallet(page); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-amount').fill('0.1');
  await page.evaluate(() => {
    window.testNative.paymentResult = { txid: 'd'.repeat(64), status: 'not-sent',
      message: 'Cancelled before transmission. No payment was sent; review again to send.' };
  });
  await page.locator('#review-payment').click();
  await expect(page.locator('#send-status')).toContainText('not-sent: ' + 'd'.repeat(64));
  await expect(page.locator('#send-status')).toContainText('No payment was sent');
  await expect(page.locator('#send-status')).not.toContainText('unknown');
  await expect(page.locator('#review-payment')).toBeEnabled();
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').length)).toBe(1);
});

test('Many-output funding progress stays cancellable and ignores stale or unrelated events', async ({ page }) => {
  await openNativeWallet(page, { cancelPendingOnLock: true });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-use-all').click();
  await page.evaluate(() => { window.testNative.deferPayment = true; window.testNative.deferredMethods.reviewPayment = true; });
  await page.locator('#review-payment').click();
  const progress = { address, operation: 'reviewPayment', stage: 'funding', completed: 192, total: 1000, retryAfterMs: 0 };
  await page.evaluate(event => window.testNative.emit('NativeWallet', 'paymentPreparation', event), progress);
  await expect(page.locator('#send-progress')).toContainText('192 / 1000');
  await expect(page.locator('#send-progress')).toContainText('cancel with Lock');
  await page.evaluate(event => window.testNative.emit('NativeWallet', 'paymentPreparation', event), { ...progress, address: otherAddress, completed: 999 });
  await expect(page.locator('#send-progress')).toContainText('192 / 1000');
  await page.evaluate(event => window.testNative.emit('NativeWallet', 'paymentPreparation', event), { ...progress, operation: 'reviewP2C', completed: 999 });
  await expect(page.locator('#send-progress')).toContainText('192 / 1000');
  await page.evaluate(event => window.testNative.emit('NativeWallet', 'paymentPreparation', event), { ...progress, stage: 'waiting', retryAfterMs: 57000 });
  await expect(page.locator('#send-progress')).toContainText('57 seconds');
  await expect(page.locator('#lock-wallet')).toBeEnabled(); await page.locator('#lock-wallet').click();
  await expect(page.locator('#send-progress')).toBeHidden(); await expect(page.locator('#send-status')).toBeEmpty();
  await page.evaluate(event => window.testNative.emit('NativeWallet', 'paymentPreparation', event), progress);
  await expect(page.locator('#send-progress')).toBeHidden();
  await expect(page.locator('#unlock-wallet')).toBeVisible();
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').length)).toBe(1);
});

test.describe('Send batch receipts', () => {
  test('fee deduction shows the exact requested amount retained as spendable change', async ({ page }) => {
    const receipt = batchReceipt(['submitted', 'submitted']);
    receipt.requestedTotal = (BigInt(receipt.total) + BigInt(receipt.fee) + 30n).toString();
    await openNativeWallet(page, { paymentBatch: receipt });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#payment-batch-requested')).toHaveText('0.2000300032 CONN');
    await expect(page.locator('#payment-batch-total')).toHaveText('0.2000000002 CONN');
    await expect(page.locator('#payment-batch-fee')).toHaveText('0.00003 CONN');
    await expect(page.locator('#payment-batch-kept')).toHaveText('0.000000003 CONN');
  });
  for (const [statuses, outcome, acknowledgement] of [
    [['submitted', 'submitted'], 'All 2 transactions were submitted. Confirmation is pending.', 'Close batch result'],
    [['submitted', 'not-sent'], 'Only part of this payment was submitted.', 'I have checked these transactions'],
    [['check-required', 'not-sent'], 'Some transactions may have been sent, but their result is unknown.', 'I have checked these transactions'],
    [['not-sent', 'not-sent'], 'No transactions were sent.', 'Close batch result'],
  ]) test(`${statuses.join('/')} shows exact native outcomes and requires acknowledgement`, async ({ page }) => {
    await openNativeWallet(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(otherAddress); await page.locator('#send-amount').fill('0.2000000002');
    const receipt = batchReceipt(statuses);
    await page.evaluate(result => { window.testNative.paymentResult = result; }, receipt);
    await page.locator('#review-payment').click();
    await expect(page.locator('#payment-batch-status')).toContainText(outcome);
    await expect(page.locator('#payment-batch-total')).toHaveText('0.2000000002 CONN');
    await expect(page.locator('#payment-batch-fee')).toHaveText('0.00003 CONN');
    await expect(page.locator('#payment-batch-transactions li')).toHaveCount(2);
    await expect(page.locator('#payment-batch-transactions li').first()).toContainText(receipt.transactions[0].txid);
    await expect(page.locator('#payment-batch-dismiss')).toHaveText(acknowledgement);
    await expect(page.locator('#review-payment')).toBeDisabled();
    await expect(page.locator('#send-use-all')).toBeDisabled();
    await expect(page.locator('#send-amount')).toHaveValue(statuses.some(status => status !== 'not-sent') ? '' : '0.2000000002');
    await page.locator('#send-form').dispatchEvent('submit');
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').length)).toBe(1);
    await page.getByRole('button', { name: 'P2C', exact: true }).click();
    await expect(page.locator('#payment-batch')).toBeHidden();
    await expect(page.locator('#review-p2c')).toBeDisabled();
    await expect(page.locator('#p2c-batch-notice')).toBeVisible();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.locator('#payment-batch')).toBeHidden();
    await expect(page.getByText('Last outgoing transaction', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#payment-batch-dismiss').click();
    await expect(page.locator('#payment-batch')).toBeHidden();
    await expect(page.locator('#review-payment')).toBeEnabled();
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'dismissPaymentBatch').map(call => call.params)))
      .toEqual([{ batchId: receipt.batchId }]);
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment').length)).toBe(1);
  });

  test('unknown receipt survives refresh failure, reload and resume, and explorer receives only a txid', async ({ page }) => {
    await openNativeWallet(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(otherAddress); await page.locator('#send-use-all').click();
    const receipt = batchReceipt();
    await page.evaluate(result => {
      window.testNative.paymentResult = result; window.testNative.failState = true; window.testNative.paymentBatchError = true;
    }, receipt);
    await page.locator('#review-payment').click();
    await expect(page.locator('#payment-batch-status')).toContainText('Do not resend the whole payment');
    await expect(page.locator('#payment-batch-outcome')).toContainText('Submitted: 1 · 0.1000000001 CONN');
    await expect(page.locator('#payment-batch-outcome')).toContainText('Check required: 1 · 0.1000000001 CONN');
    await expect(page.locator('#payment-batch-outcome')).toContainText('Not sent: 1 · 0.1000000001 CONN');
    await expect(page.locator('#payment-batch-dismiss')).toBeDisabled();
    await expect(page.locator('#send-address')).toHaveValue(''); await expect(page.locator('#send-amount')).toHaveValue('');
    await expect(page.locator('#send-all-hint')).toBeHidden();
    await expect(page.locator('#payment-batch-load-error')).not.toContainText('private');
    await page.reload(); await waitReady(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#payment-batch')).toBeVisible();
    await expect(page.locator('#send-amount')).toHaveValue('');
    const reads = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'getPaymentBatch').length);
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'getPaymentBatch').length)).toBe(reads);
    await page.getByRole('button', { name: 'Check transaction 2 in explorer', exact: true }).click();
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'openTransaction').map(call => call.params)))
      .toEqual([{ txid: receipt.transactions[1].txid }]);
    await page.evaluate(() => {
      window.testNative.emit('App', 'appStateChange', { isActive: false });
      window.testNative.emit('App', 'appStateChange', { isActive: true });
    });
    await expect.poll(() => page.evaluate(() => window.testNative.calls.filter(call => call.method === 'getPaymentBatch').length)).toBe(reads + 1);
    await expect(page.locator('#payment-batch-status')).toContainText('Do not resend the whole payment');
    expect(await page.evaluate(() => window.testNative.calls.filter(call => ['reviewPayment', 'reviewP2C', 'sendrawtransaction'].includes(call.method)))).toEqual([]);
  });

  test('local receipt loading fails closed and invalid native summaries never render', async ({ page }) => {
    await openNativeWallet(page, { paymentBatch: { ...batchReceipt(), fee: '450001', message: '<script>forged</script>' } });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#payment-batch')).toBeHidden();
    await expect(page.locator('#payment-batch-load-error-text')).toContainText('Could not load a valid saved payment result');
    await expect(page.locator('#review-payment')).toBeDisabled();
    await expect(page.locator('#send')).not.toContainText('forged');
    await page.locator('#send-form').dispatchEvent('submit');
    expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'reviewPayment'))).toBe(false);
    await page.evaluate(() => { window.testNative.paymentBatch = null; });
    await page.locator('#payment-batch-reload').click();
    await expect(page.locator('#payment-batch-load-error')).toBeHidden();
    await expect(page.locator('#review-payment')).toBeEnabled();
  });

  test('global receipt remains reviewable while locked with no account and busy acknowledgement keeps it visible', async ({ page }) => {
    const receipt = { ...batchReceipt(), walletId: otherAddress };
    await fakeNative(page, { exists: false, accountAddress: null, locked: true, paymentBatch: receipt });
    await page.goto('/'); await waitReady(page);
    await expect(page.locator('#send')).toBeVisible();
    await expect(page.locator('#payment-batch')).toBeVisible();
    await expect(page.locator('#payment-batch-wallet')).toHaveText(otherAddress);
    await expect(page.locator('#payment-batch-dismiss')).toBeEnabled();
    await page.evaluate(() => { window.testNative.dismissBatchError = 'BUSY'; });
    await page.locator('#payment-batch-dismiss').click();
    await expect(page.locator('#payment-batch-action-error')).toContainText('native payment is still finishing');
    await expect(page.locator('#payment-batch')).toBeVisible();
    await page.evaluate(() => {
      const native = window.testNative;
      native.dismissBatchError = null;
      native.paymentBatch.status = 'submitted'; native.paymentBatch.submittedCount = 3;
      for (const part of native.paymentBatch.transactions) part.status = 'submitted';
    });
    await page.locator('#payment-batch-refresh').click();
    await expect(page.locator('#payment-batch-status')).toContainText('All 3 transactions were submitted');
    await expect(page.locator('#payment-batch-dismiss')).toHaveText('Close batch result');
    await page.locator('#payment-batch-dismiss').click();
    await expect(page.locator('#payment-batch')).toBeHidden();
    await expect(page.locator('#setup-panel')).toBeVisible();
    expect(await page.evaluate(() => window.testNative.calls.some(call => ['unlock', 'queryPublic', 'reviewPayment', 'reviewP2C', 'sendrawtransaction'].includes(call.method)))).toBe(false);
  });

  test('approved batch submission progress never presents earlier parts as unsent', async ({ page }) => {
    await openNativeWallet(page);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(otherAddress); await page.locator('#send-amount').fill('0.3');
    await page.evaluate(result => { window.testNative.paymentResult = result; window.testNative.deferredMethods.reviewPayment = true; }, batchReceipt());
    await page.locator('#review-payment').click();
    await page.evaluate(event => window.testNative.emit('NativeWallet', 'paymentPreparation', event),
      { address, operation: 'reviewPayment', stage: 'signing', completed: 1, total: 3, retryAfterMs: 0 });
    await expect(page.locator('#send-progress')).toContainText('Nothing has been submitted yet');
    await page.evaluate(event => window.testNative.emit('NativeWallet', 'paymentPreparation', event),
      { address, operation: 'reviewPayment', stage: 'broadcasting', completed: 1, total: 3, retryAfterMs: 0 });
    await expect(page.locator('#send-progress')).toContainText('Some parts may already be sent');
    await expect(page.locator('#send-progress')).not.toContainText('Nothing');
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#payment-batch')).toBeVisible();
    for (const width of [320, 390, 844]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'test-results/send-batch-receipt.png', fullPage: true });
  });
});

test('Paste resets sweep and deduction, and late clipboard results cannot replace a new draft', async ({ page }) => {
  await openNativeWallet(page); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-use-all').click();
  await page.evaluate(uri => { window.testNative.clipboardText = uri; }, `connectcoin:${address}?amount=0.3`);
  await page.locator('#paste-payment').click();
  await expect(page.locator('#send-amount')).toHaveValue('0.3'); await expect(page.locator('#send-deduct-fees')).not.toBeChecked();
  await expect(page.locator('#send-all-hint')).toBeHidden();
  await page.evaluate(() => { window.testNative.clipboardReader = () => new Promise(resolve => { window.releasePaste = resolve; }); });
  await page.locator('#paste-payment').click(); await page.locator('#send-amount').fill('0.2');
  await page.evaluate(uri => window.releasePaste(uri), `connectcoin:${address}?amount=0.9`);
  await expect(page.locator('#send-amount')).toHaveValue('0.2');
});

test('Send fee and balance controls fit a narrow mobile viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 }); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-use-all').click();
  await page.locator('.send-fee-settings summary').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('send-fees-mobile.png'), fullPage: true });
});

test('separate P2C section validates public fields and requests native review without starting claims', async ({ page }) => {
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'P2C', exact: true }).click();
  await expect(page.locator('[data-page=p2c]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#p2c')).toBeVisible();
  await expect(page.locator('#claims')).toBeHidden();
  await expect(page.locator('#send-form')).toBeHidden();
  await expect(page.locator('#p2c-form')).toContainText('not a payment to the website owner');
  await expect(page.locator('#p2c-probe-help')).toContainText('3-second network budget');
  await expect(page.locator('#p2c-probe-help')).toContainText('otherwise, all supported ECDSA / RSA-PSS schemes remain allowed');
  await expect(page.locator('#p2c-progress')).toBeHidden();
  await page.locator('#p2c-domain').fill('EXAMPLE.COM');
  await page.locator('#p2c-amount').fill('0.49');
  await page.locator('#p2c-expected').fill('9007199254740993');
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'reviewP2C' || /probe/i.test(call.method)))).toBe(false);
  await page.locator('#review-p2c').click();
  await expect(page.locator('#p2c-status')).toContainText('native P2C review cancelled');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewP2C')))
    .toEqual([{ plugin: 'NativeWallet', method: 'reviewP2C', params: { domain: 'example.com', amount: '0.49', expectedConnections: '9007199254740993' } }]);
  expect(await page.evaluate(() => window.testNative.calls.some(call => ['claimsStart', 'sendrawtransaction', 'reviewPayment'].includes(call.method)))).toBe(false);
  await expect(page.locator('#review-p2c')).toBeEnabled();
  await page.locator('#p2c-open-claims').click();
  await expect(page.locator('#claims')).toBeVisible();
  await expect(page.locator('#start-claims')).toBeEnabled();
});

test('invalid P2C requests stay in the form and never reach the native signer', async ({ page }) => {
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'P2C', exact: true }).click();
  await page.locator('#p2c-amount').fill('1.');
  for (const domain of ['https://example.com', '127.0.0.1', 'wallet.local', 'router.home.arpa', 'bücher.com']) {
    await page.locator('#p2c-domain').fill(domain);
    await page.locator('#review-p2c').click();
    await expect(page.locator('#p2c-status')).toContainText('public domain');
  }
  await page.locator('#p2c-domain').fill('example.com');
  await page.locator('#p2c-expected').fill('0');
  await page.locator('#review-p2c').click();
  await expect(page.locator('#p2c-status')).toContainText('positive whole number');
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'reviewP2C'))).toBe(false);
  await page.locator('#p2c-expected').fill('1000');
  await page.locator('#p2c-expected').pressSequentially('x');
  await expect(page.locator('#p2c-expected')).toHaveValue('1000');
  await page.locator('#p2c-expected').fill('1');
  await page.locator('#review-p2c').click();
  await expect(page.locator('#p2c-status')).toContainText('native P2C review cancelled');
  expect(await page.evaluate(() => window.testNative.calls.find(call => call.method === 'reviewP2C').params.amount)).toBe('1');
});

test('P2C review is blocked while locked and duplicate submissions cannot cross the bridge', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await openNativeWallet(page, { locked: true });
  await page.getByRole('button', { name: 'P2C', exact: true }).click();
  await expect(page.locator('#review-p2c')).toBeDisabled();
  await page.locator('#p2c-unlock-wallet').click();
  await page.locator('#p2c-domain').fill('example.com');
  await page.locator('#p2c-amount').fill('2');
  await page.evaluate(() => { window.testNative.deferP2C = true; window.testNative.deferredMethods.reviewP2C = true; });
  await page.locator('#review-p2c').click();
  await expect(page.locator('#review-p2c')).toBeDisabled();
  await expect(page.locator('#p2c-domain')).toBeDisabled();
  await expect(page.locator('#p2c-progress')).toBeVisible();
  await expect(page.locator('#p2c-lock-wallet')).toBeEnabled();
  await page.locator('#p2c-form').dispatchEvent('submit');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewP2C').length)).toBe(1);
  await page.evaluate(() => { window.testNative.failState = true; window.testNative.releaseResponses(); });
  await expect(page.locator('#p2c-status')).toHaveText('submitted: ' + 'c'.repeat(64));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#global-error')).toContainText('Keep any transaction ID');
  await expect(page.locator('#review-p2c')).toBeEnabled();
  await expect(page.locator('#p2c-progress')).toBeHidden();
});

test('P2C form fits a narrow screen and keeps ordinary payment drafts separate', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address);
  await page.locator('#send-amount').fill('3');
  await page.getByRole('button', { name: 'P2C', exact: true }).click();
  await page.locator('#p2c-domain').fill('example.com');
  await page.locator('#p2c-amount').fill('1');
  await page.locator('#p2c-expected').fill((1n << 256n).toString());
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('p2c-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#send-address')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('3');
  await page.getByRole('button', { name: 'P2C', exact: true }).click();
  await expect(page.locator('#p2c-domain')).toHaveValue('example.com');
  await expect(page.locator('#p2c-expected')).toHaveValue((1n << 256n).toString());
});

for (const status of ['submitted', 'check-required']) {
  test(`removed wallet notices stay absent across all sections and a restart with a ${status} receipt`, async ({ page }) => {
    const lastPayment = { txid: 'd'.repeat(64), status };
    await openNativeWallet(page, { lastPayment, claims: { activeConnections: 17, connectionsPerSecond: 9.5 } });
    for (const restarted of [false, true]) {
      if (restarted) { await page.reload(); await waitReady(page); }
      for (const section of ['Overview', 'Receive', 'Send', 'P2C', 'Claims']) {
        await page.getByRole('button', { name: section, exact: true }).click();
        await expect(page.locator('#' + section.toLowerCase())).toBeVisible();
        await expect(page.locator('#last-payment, #last-payment-status, #last-payment-txid, #claims-rate-hint')).toHaveCount(0);
        await expect(page.getByText('Last outgoing transaction', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Actual TCP starts in the last 10 seconds', { exact: false })).toHaveCount(0);
        await expect(page.getByText("Background mode has Android's mandatory service indication", { exact: false })).toHaveCount(0);
      }
      await expect(page.locator('#claims-stats')).toContainText('Actual connections / second (last 10s)');
      await expect(page.locator('#claims-connectionsPerSecond')).toHaveText('9.5');
      await expect(page.locator('#claims-activeConnections')).toHaveText('17');
      expect(await page.evaluate(async () => (await window.Capacitor.nativePromise('NativeWallet', 'getState')).lastPayment))
        .toEqual(lastPayment);
      expect(await page.evaluate(() => window.testNative.calls.some(call => ['reviewP2C', 'reviewPayment', 'sendrawtransaction', 'claimsStart'].includes(call.method)))).toBe(false);
    }
  });
}

test('native unknown-outcome errors retain the transaction ID in Send without a global receipt notice', async ({ page }) => {
  const txid = 'e'.repeat(64);
  await openNativeWallet(page, { lastPayment: { txid, status: 'check-required' } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-amount').fill('0.1');
  const error = `TEST_ONLY: Status needs checking: ${txid}. Check the previous transaction before sending again.`;
  await page.evaluate(error => { window.testNative.paymentError = error; }, error);
  await page.locator('#review-payment').click();
  await expect(page.locator('#send-status')).toHaveText(error);
  await expect(page.locator('#last-payment')).toHaveCount(0);
  expect(await page.evaluate(async () => (await window.Capacitor.nativePromise('NativeWallet', 'getState')).lastPayment))
    .toEqual({ txid, status: 'check-required' });
});

async function isolateClipboard(page) {
  // Copy tests must not overwrite the user's operating-system clipboard.
  await page.addInitScript(() => {
    window.testCopiedLink = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async value => { window.testCopiedLink = value; },
      readText: async () => window.testCopiedLink,
    } });
  });
}

async function rejectPaste(locator, text) {
  // A real ClipboardEvent tests the capture-phase paste restriction. We only
  // use this helper for rejected pastes, which must have no native insertion.
  return locator.evaluate((input, value) => {
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    const transfer = new DataTransfer(); transfer.setData('text/plain', value);
    return !input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, text);
}

async function expectQrMatches(page, uri) {
  const modules = QRCode.create(uri, { errorCorrectionLevel: 'M' }).modules;
  // Compare the actual PNG's black/white modules to an independent QR build.
  // Comparing just src changes would miss a QR published for an older URI.
  const pixels = await page.locator('#receive-qr').evaluate(async (image, size) => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const scale = canvas.width / (size + 8);
    return Array.from({ length: size * size }, (_, index) => {
      const x = Math.floor((index % size + 4.5) * scale);
      const y = Math.floor((Math.floor(index / size) + 4.5) * scale);
      return data[(y * canvas.width + x) * 4] < 128 ? 1 : 0;
    });
  }, modules.size);
  expect(pixels).toEqual(Array.from(modules.data));
}

async function freezeReceiveTimers(page) {
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2030-01-01T00:01:00Z'));
}

test('old-WebView fallback is static and does not load the wallet runtime', async ({ page }) => {
  await page.goto('/unsupported-webview.html');
  await expect(page.getByRole('heading', { name: 'Update Android System WebView' })).toBeVisible();
  await expect(page.locator('script')).toHaveCount(0);
  await expect(page.locator('input, textarea, button')).toHaveCount(0);
});

test('first launch uses ConnectWallet branding, English, and no private-key entry', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await waitReady(page);
  await expect(page.getByText('Your wallet,')).toBeVisible();
  await expect(page.locator('.brand-copy')).toHaveText('ConnectWalletMobile MAINNET');
  await expect(page.locator('#setup-panel .notice')).toHaveText('Recover receiving and change addresses from your recovery phrase. Keep a verified backup before replacing a wallet.');
  await expect(page.locator('#preview-notice')).toBeVisible();
  await expect(page.locator('#watch-form, #watch-address, #watch-submit, #forget')).toHaveCount(0);
  await expect(page.locator('#wallet-panel')).toBeHidden();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.locator('#create-wallet')).toBeDisabled();
  await expect(page.locator('#import-recovery')).toBeDisabled();
  await expect(page.locator('#import-wallet')).toBeDisabled();
  await expect(page.locator('body')).not.toContainText(/connection is not encrypted|Traffic is not encrypted|server-authenticated|Use a server you trust|independent full-node|not blockchain consensus/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/mobile-start.png', fullPage: true });
});

test('legacy watched address never restores browser wallet UI or receive requests', async ({ page }) => {
  await page.addInitScript(({ profileKey, otherAddress }) => {
    localStorage.setItem(profileKey, JSON.stringify({ version: 1, address: otherAddress, allowMobileData: true, allowBackground: true }));
  }, { profileKey, otherAddress });
  await page.goto('/');
  await waitReady(page);
  await expect(page.locator('#wallet-panel')).toBeHidden();
  await expect(page.locator('#current-address')).toBeEmpty();
  await expect(page.locator('#receive-address')).toBeEmpty();
  await expect(page.locator('#receive-uri')).toHaveValue('');
  await expect(page.locator('#receive-qr')).not.toHaveAttribute('src');
  await expect(page.locator('#watch-form, #watch-address, #watch-submit, #forget')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(otherAddress);
});

test('legacy foreign address cannot query or receive before a native wallet is unlocked', async ({ page }) => {
  await fakeNative(page, { locked: true, accountAddress: null, legacyAddress: otherAddress });
  await page.goto('/');
  await waitReady(page);
  await expect(page.locator('#wallet-panel')).toBeHidden();
  await expect(page.locator('#receive-uri')).toHaveValue('');
  await expect(page.locator('#receive-qr')).not.toHaveAttribute('src');
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic'))).toEqual([]);
  await page.locator('#open-native-wallet').click();
  await expect(page.locator('#current-address')).toHaveText(address);
  await expect(page.locator('#balance')).toHaveText('1');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}`);
  const queried = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'queryPublic').map(call => call.params.params.address).filter(Boolean));
  expect(queried.length).toBeGreaterThan(0);
  expect(new Set(queried)).toEqual(new Set([address]));
  await expect(page.locator('body')).not.toContainText(otherAddress);
});

test('already unlocked native account overrides a saved foreign address on startup', async ({ page }) => {
  await openNativeWallet(page, { legacyAddress: otherAddress });
  await expect(page.locator('#balance')).toHaveText('1');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}`);
  await expect(page.locator('#account-kind')).toContainText('NATIVE WALLET');
  const calls = await page.evaluate(() => window.testNative.calls);
  expect(calls.filter(call => call.method === 'queryPublic').some(call => JSON.stringify(call.params).includes(otherAddress))).toBe(false);
  expect(calls.some(call => ['create', 'importRecovery', 'importWallet', 'exportWallet', 'unlock', 'claimsStart', 'reviewPayment'].includes(call.method))).toBe(false);
});

for (const operation of ['create', 'unlock']) {
  test(`late native state and claims polls cannot erase a completed ${operation}`, async ({ page }) => {
    await fakeNative(page, { exists: operation === 'unlock', locked: true, accountAddress: null });
    await page.goto('/');
    await waitReady(page);
    await page.evaluate(() => {
      window.testNative.deferredMethods = { getState: true, claimsState: true };
      window.testNative.claims.status = 'STALE_POLL_MUST_NOT_APPEAR';
    });
    await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(item => item.method).sort()))
      .toEqual(['claimsState', 'getState']);
    await page.evaluate(() => { window.testNative.claims.status = 'stopped'; });
    await page.locator(operation === 'create' ? '#create-wallet' : '#open-native-wallet').click();
    await expect(page.locator('#current-address')).toHaveText(address);
    await expect(page.locator('#balance')).toHaveText('1');
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}`);
    await page.evaluate(async () => {
      window.testPostActionStates = [];
      const observe = () => window.testPostActionStates.push({
        address: document.getElementById('current-address').textContent,
        hidden: document.getElementById('wallet-panel').hidden,
        claims: document.getElementById('claims-status').textContent,
      });
      new MutationObserver(observe).observe(document.getElementById('wallet-panel'), { childList: true, attributes: true, subtree: true });
      window.testNative.releaseResponses();
      // Let the resolved bridge promises update the UI before a new polling tick
      // could hide a regression by returning the now-current native account.
      await new Promise(resolve => requestAnimationFrame(resolve));
      observe();
    });
    await expect(page.locator('#current-address')).toHaveText(address);
    await expect(page.locator('#wallet-panel')).toBeVisible();
    await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}`);
    await expect(page.locator('#claims-status')).not.toContainText('STALE_POLL_MUST_NOT_APPEAR');
    const states = await page.evaluate(() => window.testPostActionStates);
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      expect(state.address).toBe(address);
      expect(state.hidden).toBe(false);
      expect(state.claims).not.toContain('STALE_POLL_MUST_NOT_APPEAR');
    }
  });
}

for (const enabled of [true, false]) {
  test(`${enabled ? 'active' : 'errored but requested'} background claims can stop after activity recreation without unlocking`, async ({ page }) => {
    await fakeNative(page, { exists: true, locked: true, accountAddress: null,
      claims: { enabled, requested: true, status: enabled ? 'claiming' : 'error', policyStatus: 'allowed' } });
    await page.goto('/');
    await waitReady(page);
    await expect(page.locator('#wallet-panel')).toBeHidden();
    await expect(page.locator('#background-claims')).toBeVisible();
    await expect(page.locator('#background-claims-status')).toContainText(enabled ? 'claiming' : 'error');
    await expect(page.locator('#stop-background-claims')).toBeEnabled();
    await page.locator('#stop-background-claims').click();
    await expect(page.locator('#background-claims')).toBeHidden();
    await expect(page.locator('#wallet-panel')).toBeHidden();
    await expect(page.locator('#current-address')).toBeEmpty();
    const calls = await page.evaluate(() => window.testNative.calls);
    expect(calls.filter(call => call.method === 'claimsStop')).toEqual([{ plugin: 'NativeWallet', method: 'claimsStop', params: {} }]);
    expect(calls.some(call => ['queryPublic', 'unlock', 'create', 'importRecovery', 'importWallet', 'exportWallet', 'reviewPayment', 'claimsStart'].includes(call.method))).toBe(false);
    expect(await page.evaluate(() => window.testNative.vault.locked)).toBe(true);
  });
}

for (const [id, method] of [['create-wallet', 'create'], ['import-recovery', 'importRecovery'], ['import-wallet', 'importWallet']]) {
  test(`${method} remains available for an existing wallet and cancellation preserves the original native state`, async ({ page }) => {
    const lastPayment = { txid: 'e'.repeat(64), status: 'check-required' };
    await fakeNative(page, { exists: true, locked: true, accountAddress: null, unlockAddress: otherAddress,
      lastPayment, deferredMethods: { [method]: true } });
    await page.goto('/'); await waitReady(page);
    const original = await page.evaluate(() => window.testNative.vault);
    for (const control of ['create-wallet', 'import-recovery', 'import-wallet', 'open-native-wallet']) {
      await expect(page.locator('#' + control)).toBeVisible();
      await expect(page.locator('#' + control)).toBeEnabled();
    }
    await page.locator('#' + id).click();
    await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(item => item.method))).toEqual([method]);
    for (const control of ['create-wallet', 'import-recovery', 'import-wallet', 'open-native-wallet']) {
      await expect(page.locator('#' + control)).toBeDisabled();
    }
    expect(await page.evaluate(() => window.testNative.vault)).toEqual(original);
    await page.evaluate(method => window.testNative.cancelResponses([method]), method);
    await expect(page.locator('#' + id)).toBeEnabled();
    await expect(page.locator('#setup-panel')).toBeVisible();
    await expect(page.locator('#wallet-panel')).toBeHidden();
    await expect(page.locator('#global-error')).toBeEmpty();
    expect(await page.evaluate(async () => window.Capacitor.nativePromise('NativeWallet', 'getState'))).toEqual(original);
    const calls = await page.evaluate(() => window.testNative.calls);
    expect(calls.filter(call => call.method === method)).toEqual([{ plugin: 'NativeWallet', method, params: {} }]);
    expect(calls.some(call => ['queryPublic', 'claimsStart', 'reviewPayment', 'reviewP2C', 'unlock'].includes(call.method))).toBe(false);
  });

  test(`${method} adopts the replacement account only after native setup completes on existing-wallet startup`, async ({ page }) => {
    await fakeNative(page, { exists: true, locked: true, accountAddress: null, unlockAddress: otherAddress,
      legacyAddress: address, deferredMethods: { [method]: true } });
    await page.goto('/'); await waitReady(page);
    const original = await page.evaluate(() => window.testNative.vault);
    await page.locator('#' + id).click();
    await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(item => item.method))).toEqual([method]);
    await expect(page.locator('#setup-panel')).toBeVisible();
    await expect(page.locator('#wallet-panel')).toBeHidden();
    expect(await page.evaluate(() => window.testNative.vault)).toEqual(original);
    expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'queryPublic'))).toBe(false);
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#current-address')).toHaveText(otherAddress);
    await expect(page.locator('#balance')).toHaveText('1');
    await expect(page.locator('#setup-panel')).toBeHidden();
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${otherAddress}`);
    const calls = await page.evaluate(() => window.testNative.calls);
    expect(calls.filter(call => call.method === method)).toEqual([{ plugin: 'NativeWallet', method, params: {} }]);
    expect(calls.filter(call => call.method === 'queryPublic' && call.params.params.address)
      .every(call => call.params.params.address === otherAddress)).toBe(true);
    expect(calls.some(call => ['claimsStart', 'reviewPayment', 'reviewP2C', 'unlock'].includes(call.method))).toBe(false);
    await expect(page.locator('body')).not.toContainText(address);
  });

  test(`${method} cannot carry another account's Receive, Send or P2C drafts into the replacement wallet`, async ({ page }) => {
    await page.clock.install(); await openNativeWallet(page, { unlockAddress: otherAddress });
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await page.locator('#receive-amount').fill('0.1');
    await page.locator('#receive-label').fill('Old wallet');
    await page.locator('#receive-message').fill('Old request');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(address); await page.locator('#send-use-all').click();
    await page.locator('.send-fee-settings summary').click(); await page.locator('#send-fee-rate').fill('2000');
    await page.getByRole('button', { name: 'P2C', exact: true }).click();
    await page.locator('#p2c-domain').fill('example.com'); await page.locator('#p2c-amount').fill('0.2');
    await page.locator('#p2c-expected').fill('100');
    // Simulate losing the public account on native vault recreation while
    // retaining the existing encrypted wallet and this renderer instance.
    await page.evaluate(() => { Object.assign(window.testNative.vault, { locked: true, account: null }); });
    await page.clock.runFor(1000); await expect(page.locator('#setup-panel')).toBeVisible();
    await page.locator('#' + id).click();
    await expect(page.locator('#current-address')).toHaveText(otherAddress);
    await page.clock.runFor(500);
    for (const field of ['receive-amount', 'receive-label', 'receive-message', 'send-address', 'send-amount', 'p2c-domain', 'p2c-amount']) {
      await expect(page.locator('#' + field)).toHaveValue('');
    }
    await expect(page.locator('#send-deduct-fees')).not.toBeChecked();
    await expect(page.locator('#send-fee-rate')).toHaveValue('1500');
    await expect(page.locator('#p2c-expected')).toHaveValue('1');
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${otherAddress}`);
    expect(await page.evaluate(() => window.testNative.calls.some(call => ['claimsStart', 'reviewPayment', 'reviewP2C'].includes(call.method)))).toBe(false);
  });

  test(`${method} adopts only the resulting native account, without a renderer recovery input`, async ({ page }) => {
    await fakeNative(page, { exists: false, locked: true, accountAddress: null, legacyAddress: otherAddress });
    await page.goto('/');
    await waitReady(page);
    await expect(page.locator('#setup-panel')).toBeVisible();
    await expect(page.locator('#wallet-panel')).toBeHidden();
    await expect(page.locator('#watch-form, #watch-address, #watch-submit, #forget, input[type=password]')).toHaveCount(0);
    expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'queryPublic'))).toBe(false);
    await page.locator(`#${id}`).click();
    await expect(page.locator('#current-address')).toHaveText(address);
    await expect(page.locator('#balance')).toHaveText('1');
    expect(await page.evaluate(name => window.testNative.calls.filter(call => call.method === name), method))
      .toEqual([{ plugin: 'NativeWallet', method, params: {} }]);
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}`);
    await expect(page.locator('body')).not.toContainText(otherAddress);
  });
}

test.describe('wallet security and backup', () => {
  const actions = [['changePassword', 'change-wallet-password'], ['viewRecoveryPhrase', 'view-recovery-phrase']];

  test('requires Android and an existing wallet, with no web secret fields', async ({ page }) => {
    await page.goto('/'); await waitReady(page); await page.locator('#open-settings').click();
    await expect(page.getByRole('heading', { name: 'Security & backup' })).toBeVisible();
    for (const [, id] of actions) await expect(page.locator(`#${id}`)).toBeDisabled();
    await expect(page.locator('#wallet-security-help')).toContainText('mobile app');
    await expect(page.locator('input[type=password], input[type=file], [autocomplete="current-password"], [autocomplete="new-password"]')).toHaveCount(0);
    await fakeNative(page, { exists: false, locked: true, accountAddress: null });
    await page.reload(); await waitReady(page); await page.locator('#open-settings').click();
    for (const [, id] of actions) {
      await expect(page.locator(`#${id}`)).toBeDisabled();
      await page.locator(`#${id}`).dispatchEvent('click');
    }
    await expect(page.locator('#wallet-security-help')).toContainText('Create or import');
    expect(await page.evaluate(() => window.testNative.calls.some(call => ['changePassword', 'viewRecoveryPhrase'].includes(call.method)))).toBe(false);
  });

  for (const [method, id] of actions) {
    test(`${method} authenticates from locked startup without an exposed public account`, async ({ page }) => {
      await fakeNative(page, { exists: true, locked: true, accountAddress: null });
      await page.goto('/'); await waitReady(page); await page.locator('#open-settings').click();
      await expect(page.locator(`#${id}`)).toBeEnabled();
      await page.locator(`#${id}`).click();
      await expect(page.locator('#wallet-security-status')).toContainText(method === 'changePassword' ? 'Password changed.' : 'Recovery phrase view closed.');
      await expect(page.locator('#current-address')).toBeEmpty();
      expect(await page.evaluate(method => window.testNative.calls.filter(call => call.method === method), method))
        .toEqual([{ plugin: 'NativeWallet', method, params: {} }]);
      expect(await page.evaluate(() => window.testNative.calls.some(call => ['queryPublic', 'unlock', 'reviewPayment', 'reviewP2C', 'claimsStart'].includes(call.method)))).toBe(false);
    });

    for (const locked of [false, true]) {
      test(`${method} preserves ${locked ? 'locked' : 'unlocked'} wallet funds and drafts and excludes duplicate native dialogs`, async ({ page }) => {
        await page.clock.install();
        await openNativeWallet(page, { locked, history: [confirmedHistory], deferredMethods: { [method]: true } });
        await expect(page.locator('#balance')).toHaveText('1');
        await page.getByRole('button', { name: 'Receive', exact: true }).click();
        await page.locator('#receive-amount').fill('0.3'); await page.locator('#receive-label').fill('Keep request');
        await page.locator('#receive-message').fill('Keep message'); await page.clock.runFor(1500);
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await page.locator('#send-address').fill(otherAddress); await page.locator('#send-amount').fill('0.25');
        await page.locator('#send-deduct-fees').check();
        await page.locator('.send-fee-settings summary').click(); await page.locator('#send-fee-rate').fill('2000');
        await page.getByRole('button', { name: 'P2C', exact: true }).click();
        await page.locator('#p2c-domain').fill('example.com'); await page.locator('#p2c-amount').fill('0.5'); await page.locator('#p2c-expected').fill('42');
        const before = await walletDraftSnapshot(page);
        const account = await page.evaluate(() => window.testNative.vault.account);
        const history = await page.locator('#history').textContent();
        await page.locator('#open-settings').click();
        await page.locator('#settings-theme').selectOption('light');
        await page.clock.pauseAt(new Date(Date.now() + 60000));
        await page.evaluate(() => { window.testNative.calls = []; });
        await page.locator(`#${id}`).click();
        for (const [, otherId] of actions) {
          await expect(page.locator(`#${otherId}`)).toBeDisabled();
          await page.locator(`#${otherId}`).dispatchEvent('click');
        }
        await expect(page.locator('#save-settings')).toBeDisabled();
        await expect(page.locator('#review-payment')).toBeDisabled();
        await expect(page.locator('#review-p2c')).toBeDisabled();
        await page.evaluate(() => window.testNative.releaseResponses());
        await expect(page.locator(`#${id}`)).toBeEnabled();
        await expect(page.locator('#save-settings')).toBeEnabled();
        await expect(page.locator('#wallet-security-error')).toBeEmpty();
        await expect(page.locator('#wallet-security-status')).toHaveText(method === 'changePassword'
          ? 'Password changed. Unlock with your new password. Export a new backup; older backups keep their old password.'
          : 'Recovery phrase view closed.');
        expect(await walletDraftSnapshot(page)).toEqual(before);
        expect(await page.evaluate(() => window.testNative.vault.account)).toEqual(account);
        await expect(page.locator('#balance')).toHaveText('1');
        await expect(page.locator('#history')).toHaveText(history);
        await expect(page.locator('#review-payment')).toHaveJSProperty('disabled', method === 'changePassword' || locked);
        await expect(page.locator('#review-p2c')).toHaveJSProperty('disabled', method === 'changePassword' || locked);
        const calls = await page.evaluate(() => window.testNative.calls);
        expect(calls.filter(call => ['changePassword', 'viewRecoveryPhrase'].includes(call.method))).toEqual([{ plugin: 'NativeWallet', method, params: {} }]);
        expect(calls.some(call => ['queryPublic', 'watchAccount', 'unlock', 'reviewPayment', 'reviewP2C', 'claimsStart', 'saveSettings'].includes(call.method))).toBe(false);
      });
    }

    for (const code of ['CANCELLED', 'WRONG_PASSWORD', 'BUSY']) {
      test(`${method} handles ${code} with safe feedback and the latest native lock state`, async ({ page }) => {
        await openNativeWallet(page, { securityErrors: { [method]: code } });
        await expect(page.locator('#receive-qr')).toHaveAttribute('src', /^data:image/);
        await page.getByRole('button', { name: 'Send', exact: true }).click();
        await page.locator('#send-address').fill(otherAddress); await page.locator('#send-amount').fill('0.7');
        const before = await walletDraftSnapshot(page);
        await page.locator('#open-settings').click(); await page.locator(`#${id}`).click();
        await expect(page.locator(`#${id}`)).toBeEnabled();
        await expect(page.locator('#wallet-security-status')).toBeEmpty();
        if (code === 'CANCELLED') await expect(page.locator('#wallet-security-error')).toBeEmpty();
        else await expect(page.locator('#wallet-security-error')).toContainText(code === 'BUSY' ? 'Wait for the current wallet operation' : 'Check your');
        await expect(page.locator('body')).not.toContainText('TEST_ONLY: private');
        expect(await walletDraftSnapshot(page)).toEqual(before);
        await expect(page.locator('#review-payment')).toHaveJSProperty('disabled', method === 'changePassword' && code !== 'BUSY');
      });
    }

    test(`${method} ignores a late native response after manual Lock`, async ({ page }) => {
      await openNativeWallet(page, { deferredMethods: { [method]: true } });
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.locator('#send-address').fill(otherAddress); await page.locator('#send-amount').fill('0.7');
      await page.locator('#open-settings').click(); await page.locator(`#${id}`).click();
      await page.locator('#settings-back').click(); await page.locator('#lock-wallet').click();
      await page.evaluate(() => window.testNative.releaseResponses());
      await expect(page.locator('#review-payment')).toBeDisabled();
      await expect(page.locator('#vault-status')).toContainText('Wallet locked');
      await expect(page.locator('#send-address')).toHaveValue(otherAddress); await expect(page.locator('#send-amount')).toHaveValue('0.7');
      await page.locator('#open-settings').click();
      await expect(page.locator(`#${id}`)).toBeEnabled();
      await expect(page.locator('#wallet-security-status')).toBeEmpty();
      await expect(page.locator('#wallet-security-error')).toBeEmpty();
    });
  }

  test('password storage uncertainty preserves both-password recovery instructions without native details', async ({ page }) => {
    await openNativeWallet(page, { securityErrors: { changePassword: 'STORAGE_UNCERTAIN' } });
    await page.locator('#open-settings').click(); await page.locator('#change-wallet-password').click();
    await expect(page.locator('#wallet-security-error')).toContainText('Wallet storage could not be verified.');
    await expect(page.locator('#wallet-security-error')).toHaveText('Wallet storage could not be verified. Keep both your old and new passwords and your existing encrypted backups. The wallet file may use either password. Reopen the app before unlocking. Do not replace the wallet.');
    await expect(page.locator('#wallet-security-status')).toBeEmpty();
    await expect(page.locator('#review-payment')).toBeDisabled();
    await expect(page.locator('body')).not.toContainText('TEST_ONLY: private');
  });

  test('security actions stay unavailable during scanning and while the app is inactive', async ({ page }) => {
    await openNativeWallet(page, { deferredMethods: { scanPaymentQr: true } });
    await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.locator('#scan-payment').click();
    await page.locator('#open-settings').click();
    for (const [, id] of actions) { await expect(page.locator(`#${id}`)).toBeDisabled(); await page.locator(`#${id}`).dispatchEvent('click'); }
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#change-wallet-password')).toBeEnabled();
    await page.evaluate(() => window.testNative.emit('App', 'appStateChange', { isActive: false }));
    for (const [, id] of actions) { await expect(page.locator(`#${id}`)).toBeDisabled(); await page.locator(`#${id}`).dispatchEvent('click'); }
    expect(await page.evaluate(() => window.testNative.calls.some(call => ['changePassword', 'viewRecoveryPhrase'].includes(call.method)))).toBe(false);
  });

  test('recovery phrase completion is transient and native pause never restores unlocked review', async ({ page }) => {
    await page.clock.install(); await openNativeWallet(page);
    await page.locator('#open-settings').click(); await page.locator('#view-recovery-phrase').click();
    await expect(page.locator('#wallet-security-status')).toHaveText('Recovery phrase view closed.');
    await page.clock.runFor(5000); await expect(page.locator('#wallet-security-status')).toBeEmpty();
    await page.locator('#view-recovery-phrase').click(); await page.locator('#settings-back').click();
    await expect(page.locator('#wallet-security-status')).toBeEmpty();
    await page.locator('#open-settings').click();
    await page.evaluate(() => { window.testNative.deferredMethods.viewRecoveryPhrase = true; });
    await page.locator('#view-recovery-phrase').click();
    await page.evaluate(() => {
      window.testNative.vault.locked = true;
      window.testNative.emit('App', 'appStateChange', { isActive: false });
      window.testNative.releaseResponses();
    });
    await expect(page.locator('#wallet-security-status')).toBeEmpty();
    await page.evaluate(() => window.testNative.emit('App', 'appStateChange', { isActive: true }));
    await expect(page.locator('#view-recovery-phrase')).toBeEnabled();
    await expect(page.locator('#review-payment')).toBeDisabled();
    await expect(page.locator('#vault-status')).toContainText('Wallet locked');
  });

  test('a pre-change unlocked poll cannot undo the password-change lock', async ({ page }) => {
    await page.clock.install(); await openNativeWallet(page);
    await page.evaluate(() => { window.testNative.deferredMethods = { getState: true, claimsState: true }; });
    await page.clock.runFor(1100);
    await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(item => item.method).sort())).toEqual(['claimsState', 'getState']);
    await page.locator('#open-settings').click(); await page.locator('#change-wallet-password').click();
    await expect(page.locator('#wallet-security-status')).toContainText('Password changed.');
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#review-payment')).toBeDisabled();
    await expect(page.locator('#vault-status')).toContainText('Wallet locked');
  });
});

test('wallet file export is hidden without a native vault and available on locked startup without revealing an account', async ({ page }) => {
  await fakeNative(page, { exists: false, locked: true, accountAddress: null });
  await page.goto('/'); await waitReady(page);
  await expect(page.locator('#import-wallet')).toHaveText('Import wallet file');
  await expect(page.locator('#import-recovery')).toHaveText('Import recovery phrase');
  await expect(page.locator('#wallet-files')).toBeHidden();
  await expect(page.locator('#export-wallet')).toBeDisabled();
  await expect(page.locator('input[type=file], input[type=password]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/wallet-import-startup.png', fullPage: true });
  await page.evaluate(() => { window.testNative.vault.exists = true; });
  await expect(page.locator('#export-wallet')).toBeVisible();
  await expect(page.locator('#export-wallet')).toBeEnabled();
  await page.locator('#export-wallet').click();
  await expect(page.locator('#wallet-file-status')).toHaveText('Encrypted wallet file exported.');
  await expect(page.locator('#setup-panel')).toBeVisible();
  await expect(page.locator('#current-address')).toBeEmpty();
  const calls = await page.evaluate(() => window.testNative.calls);
  expect(calls.filter(call => call.method === 'exportWallet')).toEqual([{ plugin: 'NativeWallet', method: 'exportWallet', params: {} }]);
  expect(calls.some(call => ['queryPublic', 'unlock', 'create', 'importWallet', 'claimsStart', 'reviewPayment'].includes(call.method))).toBe(false);
});

for (const locked of [false, true]) {
  test(`wallet file export preserves ${locked ? 'locked' : 'unlocked'} wallet, drafts and claims without restarting RPC`, async ({ page }) => {
    await page.clock.install();
    await openNativeWallet(page, { locked, deferredMethods: { exportWallet: true },
      claims: { enabled: true, requested: true, status: 'claiming', policyStatus: 'allowed', submitted: 12 } });
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await page.locator('#receive-amount').fill('0.3'); await page.locator('#receive-label').fill('Keep request');
    await page.locator('#receive-message').fill('Unchanged by export');
    await page.clock.runFor(1500);
    await expect(page.locator('#receive-uri')).toHaveValue(new RegExp(`^connectcoin:${address}`));
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(otherAddress); await page.locator('#send-amount').fill('0.25');
    await page.locator('#send-deduct-fees').check();
    await page.locator('.send-fee-settings summary').click(); await page.locator('#send-fee-rate').fill('2000');
    await page.getByRole('button', { name: 'P2C', exact: true }).click();
    await page.locator('#p2c-domain').fill('example.com'); await page.locator('#p2c-amount').fill('0.5');
    await page.locator('#p2c-expected').fill('42');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    const before = await walletDraftSnapshot(page);
    const nativeBefore = await page.evaluate(() => ({ vault: window.testNative.vault, claims: window.testNative.claims }));
    await page.clock.pauseAt(new Date(Date.now() + 60000));
    await page.evaluate(() => { window.testNative.calls = []; });
    await page.locator('#export-wallet').click();
    await expect(page.locator('#export-wallet')).toBeDisabled();
    await expect(page.locator('#manage-import-wallet')).toBeDisabled();
    await page.evaluate(() => document.getElementById('export-wallet').dispatchEvent(new Event('click')));
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#wallet-file-status')).toHaveText('Encrypted wallet file exported.');
    await expect(page.locator('#export-wallet')).toBeEnabled();
    expect(await walletDraftSnapshot(page)).toEqual(before);
    expect(await page.evaluate(() => ({ vault: window.testNative.vault, claims: window.testNative.claims }))).toEqual(nativeBefore);
    expect(await page.evaluate(() => window.testNative.calls)).toEqual([{ plugin: 'NativeWallet', method: 'exportWallet', params: {} }]);
  });
}

for (const mode of ['cancelled', 'failed', 'unconfirmed']) {
  test(`wallet file export ${mode} leaves identity untouched and exposes no native details`, async ({ page }) => {
    await openNativeWallet(page, { exportError: mode === 'unconfirmed' ? null : mode === 'cancelled' ? 'CANCELLED' : 'NATIVE_IO',
      exportResult: mode === 'unconfirmed' ? {} : { exported: true } });
    const before = await page.evaluate(() => window.testNative.vault);
    await page.locator('#export-wallet').click();
    await expect(page.locator('#export-wallet')).toBeEnabled();
    await expect(page.locator('#wallet-file-status')).toBeEmpty();
    if (mode === 'cancelled') await expect(page.locator('#wallet-file-error')).toBeEmpty();
    else await expect(page.locator('#wallet-file-error')).toHaveText('Could not export the wallet file. Choose a destination and try again.');
    await expect(page.locator('body')).not.toContainText('TEST_ONLY: private');
    expect(await page.evaluate(() => window.testNative.vault)).toEqual(before);
    expect(await page.evaluate(() => window.testNative.calls.some(call => ['unlock', 'lock', 'claimsStart', 'reviewPayment', 'reviewP2C'].includes(call.method)))).toBe(false);
  });
}

test('late wallet export success cannot override an explicit lock or clear its drafts', async ({ page }) => {
  await openNativeWallet(page, { deferredMethods: { exportWallet: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(otherAddress); await page.locator('#send-amount').fill('0.7');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.locator('#export-wallet').click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#lock-wallet').click();
  await expect(page.locator('#vault-status')).toContainText('Wallet locked');
  await page.evaluate(() => window.testNative.releaseResponses());
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.7');
  await expect(page.locator('#vault-status')).toContainText('Wallet locked');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.locator('#export-wallet')).toBeEnabled();
  await expect(page.locator('#wallet-file-status')).toBeEmpty();
  await expect(page.locator('#wallet-file-error')).toBeEmpty();
});

test('wallet export picker lifecycle reconciles native locking without discarding the payment draft', async ({ page }) => {
  await openNativeWallet(page, { deferredMethods: { exportWallet: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(otherAddress); await page.locator('#send-amount').fill('0.7');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.locator('#export-wallet').click();
  await page.evaluate(() => {
    window.testNative.vault.locked = true;
    window.testNative.emit('App', 'appStateChange', { isActive: false });
    window.testNative.emit('App', 'appStateChange', { isActive: true });
    window.testNative.releaseResponses();
  });
  await expect(page.locator('#export-wallet')).toBeEnabled();
  await expect(page.locator('#wallet-file-status')).toHaveText('Encrypted wallet file exported.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#vault-status')).toContainText('Wallet locked');
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.7');
  expect(await page.evaluate(() => window.testNative.calls.some(call => ['unlock', 'lock', 'claimsStart', 'reviewPayment'].includes(call.method)))).toBe(false);
});

test('Overview Import wallet file delegates directly to native file import and clears same-wallet drafts only after success', async ({ page }) => {
    await openNativeWallet(page, { deferredMethods: { importWallet: true } });
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await page.locator('#receive-amount').fill('0.3'); await page.locator('#receive-label').fill('Old request');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#send-address').fill(otherAddress); await page.locator('#send-amount').fill('0.8');
    await page.locator('#send-deduct-fees').check();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.locator('#manage-import-wallet').click();
    await expect(page.locator('#manage-import-wallet')).toBeDisabled();
    await expect(page.locator('#send-address')).toHaveValue(otherAddress);
    await expect(page.locator('#receive-label')).toHaveValue('Old request');
    await page.evaluate(() => window.testNative.releaseResponses());
    await expect(page.locator('#manage-import-wallet')).toBeEnabled();
    await expect(page.locator('#current-address')).toHaveText(address);
    for (const id of ['send-address', 'send-amount', 'receive-label', 'receive-amount']) await expect(page.locator('#' + id)).toHaveValue('');
    await expect(page.locator('#send-deduct-fees')).not.toBeChecked();
    await expect(page.locator('input[type=file], input[type=password]')).toHaveCount(0);
    expect(await page.evaluate(() => window.testNative.imports)).toEqual(['encrypted-file']);
    expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'importWallet')))
      .toEqual([{ plugin: 'NativeWallet', method: 'importWallet', params: {} }]);
    expect(await page.evaluate(() => window.testNative.calls.some(call => ['importRecovery', 'claimsStart', 'reviewPayment'].includes(call.method)))).toBe(false);
});

test('startup shows separate recovery-phrase and wallet-file buttons with native-only input on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await fakeNative(page, { exists: false, locked: true, accountAddress: null });
  await page.goto('/'); await waitReady(page);
  await expect(page.locator('#create-wallet')).toHaveText('Create wallet');
  await expect(page.locator('#import-recovery')).toHaveText('Import recovery phrase');
  await expect(page.locator('#import-wallet')).toHaveText('Import wallet file');
  for (const id of ['create-wallet', 'import-recovery', 'import-wallet']) await expect(page.locator('#' + id)).toBeEnabled();
  await expect(page.locator('#open-native-wallet')).toBeHidden();
  await expect(page.locator('input[type=file], input[type=password]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => window.testNative.imports)).toEqual([]);
  await page.screenshot({ path: 'test-results/wallet-separate-imports-startup.png', fullPage: true });
  await page.evaluate(() => window.testNative.emit('App', 'appStateChange', { isActive: false }));
  for (const id of ['create-wallet', 'import-recovery', 'import-wallet']) await expect(page.locator('#' + id)).toBeDisabled();
  await page.evaluate(() => window.testNative.emit('App', 'appStateChange', { isActive: true }));
  for (const id of ['create-wallet', 'import-recovery', 'import-wallet']) await expect(page.locator('#' + id)).toBeEnabled();
});

test('recovery phrase import has its own sanitized failure feedback and never opens file import', async ({ page }) => {
  await fakeNative(page, { exists: false, locked: true, accountAddress: null, importError: 'INVALID_RECOVERY' });
  await page.goto('/'); await waitReady(page);
  await page.locator('#import-recovery').click();
  await expect(page.locator('#global-error')).toHaveText('Could not import the recovery phrase. Check the words and new wallet password and try again.');
  await expect(page.locator('body')).not.toContainText('TEST_ONLY: private');
  await expect(page.locator('#setup-panel')).toBeVisible();
  const calls = await page.evaluate(() => window.testNative.calls);
  expect(calls.filter(call => call.method === 'importRecovery')).toEqual([{ plugin: 'NativeWallet', method: 'importRecovery', params: {} }]);
  expect(calls.some(call => ['importWallet', 'queryPublic', 'claimsStart', 'reviewPayment'].includes(call.method))).toBe(false);
});

test('a cancelled native file import preserves drafts and a failed import shows only safe text', async ({ page }) => {
  await openNativeWallet(page, { deferredMethods: { importWallet: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(otherAddress); await page.locator('#send-amount').fill('0.2');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.locator('#manage-import-wallet').click();
  await page.evaluate(() => window.testNative.cancelResponses(['importWallet']));
  await expect(page.locator('#manage-import-wallet')).toBeEnabled();
  await expect(page.locator('#global-error')).toBeEmpty();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.2');
  await page.evaluate(() => { window.testNative.importError = 'INVALID_WALLET_FILE'; });
  await page.locator('#manage-import-wallet').click();
  await expect(page.locator('#global-error')).toHaveText('Could not import the wallet file. Check the file and its password and try again.');
  await expect(page.locator('body')).not.toContainText('TEST_ONLY: private');
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.2');
});

test('uncertain wallet storage requires reopening instead of encouraging an import retry', async ({ page }) => {
  await openNativeWallet(page, { importError: 'STORAGE_UNCERTAIN' });
  await page.locator('#manage-import-wallet').click();
  await expect(page.locator('#global-error')).toHaveText('Wallet storage could not be verified. Keep your saved encrypted backup and recovery phrase safe. Reopen the app before trying another import.');
  await expect(page.locator('body')).not.toContainText('TEST_ONLY: private');
  await expect(page.locator('#current-address')).toHaveText(address);
});

test('wallet backup controls fit a narrow screen without exposing browser file or password inputs', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openNativeWallet(page);
  await page.locator('#wallet-files').scrollIntoViewIfNeeded();
  await expect(page.locator('#export-wallet')).toBeVisible();
  await expect(page.locator('#manage-import-wallet')).toBeVisible();
  await expect(page.locator('input[type=file], input[type=password]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#wallet-files').screenshot({ path: 'test-results/wallet-file-controls.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/wallet-file-overview.png', fullPage: true });
});

test('wallet file controls cannot open another native picker while a QR scanner is pending', async ({ page }) => {
  await openNativeWallet(page, { deferredMethods: { scanPaymentQr: true } });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#scan-payment').click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.locator('#export-wallet')).toBeDisabled();
  await expect(page.locator('#manage-import-wallet')).toBeDisabled();
  await page.evaluate(() => window.testNative.releaseResponses());
  await expect(page.locator('#export-wallet')).toBeEnabled();
  await expect(page.locator('#manage-import-wallet')).toBeEnabled();
  expect(await page.evaluate(() => window.testNative.calls.some(call => ['exportWallet', 'importWallet'].includes(call.method)))).toBe(false);
});

test('native-owned receive works with bounded RPC errors and conservative saved claims preferences', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await isolateClipboard(page);
  await openNativeWallet(page, { rpcUnavailable: true });
  await expect(page.locator('#wallet-error')).toContainText('Check your connection');
  await expect(page.locator('#balance')).toHaveText('—');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.locator('#receive-qr')).toBeVisible();
  await expect(page.locator('#receive-address')).toHaveText(address);
  await page.getByRole('button', { name: 'Copy payment link', exact: true }).click();
  await expect(page.locator('#copy-status')).toHaveText('Payment link copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`connectcoin:${address}`);
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#mobile-data')).not.toBeChecked();
  await expect(page.locator('#background')).not.toBeChecked();
  await page.locator('#mobile-data').check();
  await page.locator('#background').check();
  await expect(page.locator('#claims-status')).toContainText('stopped');
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'claimsStart'))).toBe(false);
  await expect(page.locator('#global-error')).toBeEmpty();
  await page.screenshot({ path: 'test-results/mobile-claims.png', fullPage: true });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('TEST_ONLY_NATIVE_CLAIMS_POLICY'))).toContain('"allowBackground":true');
  await page.reload();
  await waitReady(page);
  await expect(page.locator('#current-address')).toHaveText(address);
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#mobile-data')).toBeChecked();
  await expect(page.locator('#background')).toBeChecked();
  expect(await page.evaluate(key => localStorage.getItem(key), profileKey)).toBeNull();
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.plugin === 'Preferences'))).toEqual([]);
  await expect(page.locator('#forget')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('fits small devices and landscape', async ({ page }) => {
  await openNativeWallet(page);
  for (const size of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    for (const section of ['Overview', 'Receive', 'Send', 'Claims']) {
      await page.getByRole('button', { name: section, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
});

test('native clipboard works without the browser Clipboard API and reads only after Paste', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
  await openNativeWallet(page, { clipboardText: address });
  expect(address).toMatch(/^cc1p/);
  for (const section of ['Receive', 'P2C', 'Send']) await page.getByRole('button', { name: section, exact: true }).click();
  await page.clock.runFor(3000);
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'readPaymentClipboard'))).toEqual([]);
  await page.locator('#paste-payment').click();
  await expect(page.locator('#send-address')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('');
  await page.evaluate(uri => { window.testNative.clipboardText = uri; }, `connectcoin:${otherAddress}?amount=0.25&label=Invoice`);
  await page.locator('#paste-payment').click();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('0.25');
  await expect(page.locator('#payment-paste-error')).toBeEmpty();
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'readPaymentClipboard'))).toEqual([
    { plugin: 'NativeWallet', method: 'readPaymentClipboard', params: {} },
    { plugin: 'NativeWallet', method: 'readPaymentClipboard', params: {} },
  ]);
  expect(await page.evaluate(() => window.testNative.calls.some(call => ['reviewPayment', 'sendrawtransaction'].includes(call.method)))).toBe(false);
});

test('native clipboard failures offer manual paste and preserve the draft without browser fallback', async ({ page }) => {
  await page.addInitScript(address => {
    window.browserClipboardReads = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      readText: async () => { window.browserClipboardReads++; return address; },
    } });
  }, otherAddress);
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-amount').fill('0.2');
  await page.evaluate(() => { window.testNative.clipboardError = 'CLIPBOARD_UNAVAILABLE'; });
  await page.locator('#paste-payment').click();
  await expect(page.locator('#payment-paste-error')).toHaveText('Could not read the clipboard. Paste directly into the address field.');
  await expect(page.locator('#send-address')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('0.2');
  await expect(page.locator('#send-status')).toBeEmpty();
  expect(await page.evaluate(() => window.browserClipboardReads)).toBe(0);
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'reviewPayment'))).toBe(false);
  await page.evaluate(address => { window.testNative.clipboardError = null; window.testNative.clipboardText = address; }, otherAddress);
  await page.locator('#paste-payment').click();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#payment-paste-error')).toBeEmpty();
});

test('owned wallet pastes a mainnet payment without signing or broadcasting automatically', async ({ page }) => {
  await isolateClipboard(page);
  await openReceive(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#review-payment')).toBeEnabled();
  await page.evaluate(value => { window.testNative.clipboardText = value; }, `connectcoin:${otherAddress}?amount=1.2345678901`);
  await page.locator('#paste-payment').click();
  await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await expect(page.locator('#send-amount')).toHaveValue('1.2345678901');
  await page.evaluate(value => { window.testNative.clipboardText = value; }, address);
  await page.locator('#paste-payment').click();
  await expect(page.locator('#send-address')).toHaveValue(address);
  await expect(page.locator('#send-amount')).toHaveValue('');
  const invalidChecksum = address.slice(0, -1) + (address.endsWith('q') ? 'p' : 'q');
  for (const invalid of ['', ' ', testnet, `connectcoin:${testnet}?amount=1`, invalidChecksum, 'not-an-address', 'cc1p<script>alert(1)</script>', 'NEVER A VALID SECRET']) {
    await page.evaluate(value => { window.testNative.clipboardText = value; }, invalid);
    await page.locator('#paste-payment').click();
    await expect(page.locator('#payment-paste-error')).toHaveText('Copy a valid ConnectCoin address or "connectcoin:" payment link.');
    await expect(page.locator('#send-address')).toHaveValue(address);
    if (invalid.trim()) await expect(page.locator('#payment-paste-error')).not.toContainText(invalid);
    await expect(page.locator('#send-status')).toBeEmpty();
  }
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'reviewPayment' || call.method === 'sendrawtransaction'))).toEqual([]);
  await page.locator('#lock-wallet').click();
  await expect(page.locator('#review-payment')).toBeDisabled();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
});

test('Paste feedback holds for three seconds and fades for one without balance updates restarting it', async ({ page }) => {
  await isolateClipboard(page); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await freezeReceiveTimers(page);
  const feedback = page.locator('#payment-paste-error');
  await page.locator('#paste-payment').click();
  await expect(feedback).toHaveText('Copy a valid ConnectCoin address or "connectcoin:" payment link.');
  await expect(feedback).toHaveAttribute('role', 'status');
  await expect(page.locator('#paste-payment')).toHaveAttribute('aria-describedby', 'payment-paste-error');
  expect(await feedback.evaluate(node => node.previousElementSibling.id)).toBe('paste-payment');
  await page.clock.runFor(2500);
  await page.evaluate(address => window.testNative.emit('NativeWallet', 'walletChanged', { address, reason: 'address' }), address);
  await page.clock.runFor(499);
  await expect(feedback).not.toHaveClass(/is-fading/); await expect(feedback).toHaveCSS('opacity', '1');
  await page.clock.runFor(1);
  await expect(feedback).toHaveClass(/is-fading/);
  await expect(feedback).toHaveCSS('transition-property', 'opacity');
  await expect(feedback).toHaveCSS('transition-duration', '1s');
  await page.clock.runFor(999); await expect(feedback).not.toBeEmpty();
  await page.clock.runFor(1); await expect(feedback).toBeEmpty();
  await expect(feedback).not.toHaveClass(/is-fading/);
  await expect(page.locator('#send-status')).toBeEmpty();
});

test('Paste feedback visibly fades and is removed using real browser timers', async ({ page }) => {
  await isolateClipboard(page); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#paste-payment').click();
  const feedback = page.locator('#payment-paste-error');
  await expect(feedback).not.toBeEmpty(); await expect(feedback).toHaveCSS('opacity', '1');
  await expect(feedback).toHaveClass(/is-fading/, { timeout: 4500 });
  await expect.poll(() => feedback.evaluate(node => {
    const opacity = Number(getComputedStyle(node).opacity);
    return opacity > 0 && opacity < 1;
  }), { timeout: 900, intervals: [25] }).toBe(true);
  await expect(feedback).toBeEmpty({ timeout: 2000 });
});

test('repeated Paste restarts hold and fade, and a valid paste cancels feedback', async ({ page }) => {
  await isolateClipboard(page); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await freezeReceiveTimers(page);
  const feedback = page.locator('#payment-paste-error');
  await page.locator('#paste-payment').click(); await page.clock.runFor(2000);
  await page.locator('#paste-payment').click(); await page.clock.runFor(2999);
  await expect(feedback).not.toHaveClass(/is-fading/); await expect(feedback).not.toBeEmpty();
  await page.clock.runFor(501); await expect(feedback).toHaveClass(/is-fading/);
  await page.locator('#paste-payment').click();
  await expect(feedback).not.toHaveClass(/is-fading/); await expect(feedback).toHaveCSS('opacity', '1');
  await page.clock.runFor(2999); await expect(feedback).not.toHaveClass(/is-fading/);
  await page.evaluate(address => { window.testNative.clipboardText = address; }, otherAddress);
  await page.locator('#paste-payment').click();
  await expect(feedback).toBeEmpty(); await expect(page.locator('#send-address')).toHaveValue(otherAddress);
  await page.clock.runFor(5000); await expect(feedback).toBeEmpty();
});

test('Paste feedback never replaces or clears payment errors and transaction receipts', async ({ page }) => {
  await isolateClipboard(page); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address); await page.locator('#send-amount').fill('0.1');
  await page.locator('#review-payment').click();
  const status = page.locator('#send-status');
  await expect(status).toContainText('native payment review cancelled');
  const error = await status.textContent();
  await freezeReceiveTimers(page);
  await page.locator('#paste-payment').click(); await page.clock.runFor(4000);
  await expect(page.locator('#payment-paste-error')).toBeEmpty(); await expect(status).toHaveText(error);
  await page.evaluate(() => { window.testNative.deferPayment = true; });
  await page.locator('#review-payment').click(); await expect(status).toHaveText('submitted: ' + 'd'.repeat(64));
  await page.locator('#paste-payment').click(); await page.clock.runFor(4000);
  await expect(page.locator('#payment-paste-error')).toBeEmpty(); await expect(status).toHaveText('submitted: ' + 'd'.repeat(64));
});

test('late Paste results cannot revive errors or replace a newer clipboard result or draft', async ({ page }) => {
  await openNativeWallet(page); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#send-address').fill(address);
  await page.evaluate(() => {
    window.pendingPastes = [];
    window.testNative.clipboardReader = () => new Promise((resolve, reject) => window.pendingPastes.push({ resolve, reject }));
  });
  await page.locator('#paste-payment').click(); await page.locator('#paste-payment').click();
  // Same empty amount/deduction on purpose: only the paste revision distinguishes these requests.
  await page.evaluate(address => window.pendingPastes[1].resolve(address), address);
  await expect(page.locator('#send-address')).toHaveValue(address);
  await page.evaluate(() => window.pendingPastes[0].reject(new Error('TEST_ONLY_CLIPBOARD_DENIED')));
  await expect(page.locator('#payment-paste-error')).toBeEmpty();
  await page.locator('#paste-payment').click(); await page.locator('#send-amount').fill('0.2');
  await page.evaluate(() => window.pendingPastes[2].resolve('invalid clipboard'));
  await expect(page.locator('#payment-paste-error')).toBeEmpty();
  await page.locator('#paste-payment').click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(address => window.pendingPastes[3].resolve(address), otherAddress);
  await expect(page.locator('#send-address')).toHaveValue(address);
  await page.locator('#paste-payment').click();
  await page.evaluate(() => {
    window.testNative.emit('App', 'appStateChange', { isActive: false });
    window.testNative.emit('App', 'appStateChange', { isActive: true });
    window.pendingPastes[4].resolve('invalid clipboard');
  });
  await expect(page.locator('#payment-paste-error')).toBeEmpty();
  await page.locator('#paste-payment').click(); await page.locator('#lock-wallet').click();
  await expect(page.locator('#paste-payment')).toBeDisabled();
  await page.evaluate(() => window.pendingPastes[5].resolve('invalid clipboard'));
  await expect(page.locator('#payment-paste-error')).toBeEmpty();
});

test('Paste feedback respects reduced motion and clears on leaving Send', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 320, height: 740 });
  await isolateClipboard(page); await openNativeWallet(page);
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await freezeReceiveTimers(page);
  await page.locator('#paste-payment').click(); await page.clock.runFor(3000);
  const feedback = page.locator('#payment-paste-error');
  await expect(feedback).toHaveClass(/is-fading/);
  await expect(feedback).toHaveCSS('transition-duration', '0s'); await expect(feedback).toHaveCSS('opacity', '0');
  await page.clock.runFor(1000); await expect(feedback).toBeEmpty();
  await page.locator('#paste-payment').click(); await expect(feedback).not.toBeEmpty();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(feedback).toBeEmpty();
});

test('claims timeout diagnostics fit the screen and clear on recovery without changing counters', async ({ page }) => {
  await page.clock.install();
  await openNativeWallet(page, { claims: { enabled: true, requested: true, running: true, policyStatus: 'allowed',
    status: 'retrying', attempts: 7046, submitted: 48, unknown: 0, lastError: 'RPC_TIMEOUT',
    lastRpcError: { code: 'RPC_TIMEOUT', method: 'getblockbounties', phase: 'read', elapsedMs: 120005, queuedMs: 17, bytesReceived: 12345 } } });
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#claims-error')).toContainText('RPC_TIMEOUT · getblockbounties');
  await expect(page.locator('#claims-error')).toContainText('Receiving the response');
  await expect(page.locator('#claims-error')).toContainText('12,345 bytes');
  await expect(page.locator('#claims-submitted')).toHaveText('48');
  await expect(page.locator('#stop-claims')).toBeEnabled();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { window.testNative.claims.lastError = ''; window.testNative.claims.lastRpcError = null; window.testNative.claims.status = 'claiming'; });
  await page.clock.runFor(2500);
  await expect(page.locator('#claims-error')).toBeEmpty();
  await expect(page.locator('#claims-submitted')).toHaveText('48');
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'claimsStart'))).toBe(false);
});

test('a claim awaiting RPC allowance stays pending without an error and the stop control remains available', async ({ page }) => {
  await page.clock.install();
  await openNativeWallet(page, { claims: { enabled: true, requested: true, running: true, policyStatus: 'allowed',
    status: 'claiming', attempts: 80000, submitted: 48, unknown: 0, lastError: '', lastRpcError: null,
    receiptTxid: 'a'.repeat(64), receiptStatus: 'pending' } });
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await page.clock.runFor(2500);
  await expect(page.locator('#claims-error')).toBeEmpty();
  await expect(page.locator('#claims-receipt')).toContainText('pending:');
  await expect(page.locator('#claims-submitted')).toHaveText('48');
  await expect(page.locator('#stop-claims')).toBeEnabled();
  await page.evaluate(() => { window.testNative.claims.receiptStatus = 'submitted'; window.testNative.claims.submitted = 49; });
  await page.clock.runFor(2500);
  await expect(page.locator('#claims-error')).toBeEmpty();
  await expect(page.locator('#claims-submitted')).toHaveText('49');
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'claimsStart'))).toBe(false);
});

test('claims requires an explicit native start and passes only the owned reward address', async ({ page }) => {
  await openReceive(page);
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#start-claims')).toBeEnabled();
  await expect(page.locator('#stop-claims')).toBeDisabled();
  for (const id of ['attempts', 'valid', 'invalid', 'targetHits', 'submitted', 'unknown', 'connectionsPerSecond', 'eligible']) {
    await expect(page.locator('#claims-' + id)).toHaveText('0');
  }
  await expect(page.locator('#claims-receipt')).toBeHidden();
  await expect(page.locator('#check-claim')).toBeHidden();
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'claimsStart'))).toBe(false);
  await page.locator('#start-claims').click();
  await expect(page.locator('#stop-claims')).toBeEnabled();
  expect(await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'claimsStart')))
    .toEqual([{ plugin: 'NativeWallet', method: 'claimsStart', params: { address } }]);
  await page.locator('#stop-claims').click();
  await expect(page.locator('#stop-claims')).toBeDisabled();
  await expect(page.locator('#start-claims')).toBeEnabled();
});

test('receive amount normalizes comma and final decimal separator while blocking letters and excess precision', async ({ page }) => {
  await openReceive(page);
  const amount = page.locator('#receive-amount');
  await amount.fill('1,');
  await expect(amount).toHaveValue('1.');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}?amount=1`);
  await expect(page.locator('#receive-error')).toBeEmpty();
  await amount.fill('1,2345678901');
  await expect(amount).toHaveValue('1.2345678901');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}?amount=1.2345678901`);
  await amount.pressSequentially('9abc+-e.,');
  await expect(amount).toHaveValue('1.2345678901');
  expect(await rejectPaste(amount, '2')).toBe(true);
  await expect(amount).toHaveValue('1.2345678901');
  await expect(page.locator('#receive-error')).toContainText('Nothing was pasted');
  await amount.fill('100000000.');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}?amount=100000000`);
  await expect(page.locator('#receive-error')).toBeEmpty();
});

test('receive label and message enforce Unicode code-point limits and reject oversized paste', async ({ page }) => {
  await openReceive(page);
  const label = page.locator('#receive-label'), message = page.locator('#receive-message');
  const labelLimit = '😀'.repeat(50) + 'a'.repeat(50);
  await label.fill(labelLimit);
  await expect(label).toHaveValue(labelLimit);
  await expect(page.locator('#label-count')).toHaveText('100/100');
  await label.pressSequentially('Z');
  await expect(label).toHaveValue(labelLimit);
  expect(await rejectPaste(label, 'extra')).toBe(true);
  await expect(label).toHaveValue(labelLimit);
  await expect(page.locator('#receive-error')).toContainText('100 characters');
  await expect(page.locator('#receive-error')).not.toContainText('extra');
  await label.fill('');
  const messageLimit = '😀'.repeat(50) + 'b'.repeat(150);
  await message.fill(messageLimit);
  await expect(message).toHaveValue(messageLimit);
  await expect(page.locator('#message-count')).toHaveText('200/200');
  await message.pressSequentially('Z');
  await expect(message).toHaveValue(messageLimit);
  expect(await rejectPaste(message, 'private-pasted-value'.repeat(100))).toBe(true);
  await expect(message).toHaveValue(messageLimit);
  await expect(page.locator('#receive-error')).toContainText('200 characters');
  await expect(page.locator('#receive-error')).not.toContainText('private-pasted-value');
  await message.fill('Order 42\nThank you');
  await expect(page.locator('#message-count')).toHaveText('18/200');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}?message=Order%2042%0AThank%20you`);
  await expect(page.locator('#receive-metadata-notice')).toContainText('not written to the blockchain');
});

test('only the newest request publishes QR, URI and copy together after rapid changes', async ({ page }) => {
  await isolateClipboard(page);
  await openReceive(page);
  await freezeReceiveTimers(page);
  await page.evaluate(() => {
    window.testReceiveStates = [];
    new MutationObserver(() => window.testReceiveStates.push({
      uri: document.getElementById('receive-uri').value,
      src: document.getElementById('receive-qr').getAttribute('src'),
      hidden: document.getElementById('qr-card').hidden,
      disabled: document.getElementById('copy-link').disabled,
    })).observe(document.getElementById('receive'), { attributes: true, subtree: true });
  });
  await page.locator('#receive-amount').fill('1.');
  await expect(page.locator('#copy-link')).toBeDisabled();
  await expect(page.locator('#receive-uri')).toHaveValue('');
  await expect(page.locator('#receive-qr')).not.toHaveAttribute('src');
  await page.clock.runFor(119);
  await page.locator('#receive-amount').fill('2,50');
  await page.locator('#receive-label').fill('Newest & only');
  await page.locator('#receive-message').fill('Order 2');
  await expect(page.locator('#copy-link')).toBeDisabled();
  await expect(page.locator('#qr-card')).toBeHidden();
  await page.clock.runFor(120);
  const uri = `connectcoin:${address}?amount=2.5&label=Newest%20%26%20only&message=Order%202`;
  await expect(page.locator('#copy-link')).toBeEnabled();
  await expect(page.locator('#receive-uri')).toHaveValue(uri);
  await expectQrMatches(page, uri);
  await page.locator('#copy-link').click();
  await expect(page.locator('#copy-status')).toHaveText('Payment link copied.');
  expect(await page.evaluate(() => window.testCopiedLink)).toBe(uri);
  const states = await page.evaluate(() => window.testReceiveStates);
  expect(states.some(state => state.disabled && state.hidden && state.uri === '' && state.src === null)).toBe(true);
  expect(states.some(state => !state.disabled)).toBe(true);
  for (const state of states.filter(state => !state.disabled)) {
    expect(state.uri).toBe(uri);
    expect(state.hidden).toBe(false);
    expect(state.src).toMatch(/^data:image\/png;base64,/);
  }
  await page.clock.runFor(1000);
  await expect(page.locator('#receive-uri')).toHaveValue(uri);
  await expectQrMatches(page, uri);
});

test('invalid requests remove the previously valid QR and disable every copy path', async ({ page }) => {
  await isolateClipboard(page);
  await openReceive(page);
  await page.locator('#receive-amount').fill('3');
  await expect(page.locator('#copy-link')).toBeEnabled();
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}?amount=3`);
  await page.locator('#copy-link').click();
  const previousCopy = await page.evaluate(() => window.testCopiedLink);
  for (const value of ['0.', '100000001']) {
    await page.locator('#receive-amount').fill(value);
    await expect(page.locator('#copy-link')).toBeDisabled();
    await expect(page.locator('#receive-uri')).toHaveValue('');
    await expect(page.locator('#receive-qr')).not.toHaveAttribute('src');
    await expect(page.locator('#qr-card')).toBeHidden();
    await expect(page.locator('#receive-error')).toContainText('greater than 0');
    await expect(page.locator('#copy-status')).toBeEmpty();
    // Even a programmatic click must not copy an old request from a closure.
    await page.locator('#copy-link').dispatchEvent('click');
    expect(await page.evaluate(() => window.testCopiedLink)).toBe(previousCopy);
  }
  await page.locator('#receive-amount').fill('');
  await page.locator('#receive-label').fill('😀'.repeat(100));
  await expect(page.locator('#label-count')).toHaveText('100/100');
  await expect(page.locator('#receive-error')).toContainText('too long for a QR code');
  await expect(page.locator('#copy-link')).toBeDisabled();
  await expect(page.locator('#receive-uri')).toHaveValue('');
  await expect(page.locator('#receive-qr')).not.toHaveAttribute('src');
});

test('clear details and reload restore an address-only request without saving metadata', async ({ page }) => {
  await openReceive(page);
  const draft = { 'receive-amount': '4,', 'receive-label': 'Private local draft', 'receive-message': 'Not persisted' };
  for (const [id, value] of Object.entries(draft)) await page.locator(`#${id}`).fill(value);
  await expect(page.locator('#receive-uri')).toHaveValue(new RegExp('amount=4&label='));
  await page.locator('#clear-request').click();
  for (const id of Object.keys(draft)) await expect(page.locator(`#${id}`)).toHaveValue('');
  await expect(page.locator('#label-count')).toHaveText('0/100');
  await expect(page.locator('#message-count')).toHaveText('0/200');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}`);
  await expectQrMatches(page, `connectcoin:${address}`);
  for (const [id, value] of Object.entries(draft)) await page.locator(`#${id}`).fill(value);
  const saved = await page.evaluate(key => localStorage.getItem(key) || '', profileKey);
  expect(saved).not.toContain(address);
  expect(saved).not.toContain('Private local draft');
  expect(saved).not.toContain('Not persisted');
  await page.reload();
  await waitReady(page);
  await expect(page.locator('#current-address')).toHaveText(address);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  for (const id of Object.keys(draft)) await expect(page.locator(`#${id}`)).toHaveValue('');
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${address}`);
});

test('native account removal or change cancels a queued QR and drops the previous draft', async ({ page }) => {
  await openReceive(page);
  await freezeReceiveTimers(page);
  await page.locator('#receive-label').fill('Old address draft');
  await page.locator('#receive-message').fill('Do not reuse');
  await page.evaluate(() => window.testNative.setAccount(null, true));
  await page.clock.runFor(1000);
  await expect(page.locator('#setup-panel')).toBeVisible();
  await expect(page.locator('#receive-uri')).toHaveValue('');
  await expect(page.locator('#receive-qr')).not.toHaveAttribute('src');
  await expect(page.locator('#copy-link')).toBeDisabled();
  await page.evaluate(value => window.testNative.setAccount(value), otherAddress);
  await page.clock.runFor(1000);
  await expect(page.locator('#current-address')).toHaveText(otherAddress);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  for (const id of ['receive-amount', 'receive-label', 'receive-message']) await expect(page.locator(`#${id}`)).toHaveValue('');
  await page.clock.runFor(1000);
  await expect(page.locator('#receive-uri')).toHaveValue(`connectcoin:${otherAddress}`);
  await expectQrMatches(page, `connectcoin:${otherAddress}`);
  await expect(page.locator('#receive-error')).toBeEmpty();
});

test('claims ceilings default to 100, show actual activity separately and never start automatically', async ({ page }) => {
  await openNativeWallet(page, { claims: { activeConnections: 17, connectionsPerSecond: 9.5 } });
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#claims-rate-limit')).toHaveValue('100');
  await expect(page.locator('#claims-concurrency')).toHaveValue('100');
  await expect(page.locator('#apply-claims-limits')).toBeDisabled();
  await expect(page.locator('#claims-activeConnections')).toHaveText('17');
  await expect(page.locator('#claims-connectionsPerSecond')).toHaveText('9.5');
  await expect(page.locator('#claims-stats')).toContainText('Actual connections / second (last 10s)');
  await expect(page.locator('#claims-connectionsPerSecond')).not.toHaveAttribute('aria-describedby', 'claims-rate-hint');
  await expect(page.locator('#claims-rate-hint')).toHaveCount(0);
  await expect(page.locator('#claims-limits-hint')).toContainText('not a guaranteed');
  expect(await page.evaluate(() => window.testNative.calls.some(call => ['claimsStart', 'claimsLimits'].includes(call.method)))).toBe(false);
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const id of ['claims-rate-limit', 'claims-concurrency', 'apply-claims-limits']) {
    const bounds = await page.locator('#' + id).boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  }
});

test('claims ceilings validate before saving and restore independent native preferences on reload', async ({ page }) => {
  await openNativeWallet(page, { claims: { connectionsPerSecondLimit: 12, concurrency: 8, allowMobileData: true } });
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#claims-rate-limit')).toHaveValue('12');
  await expect(page.locator('#claims-concurrency')).toHaveValue('8');
  for (const value of ['0', '101', '1.5', '']) {
    await page.locator('#claims-rate-limit').fill(value);
    await page.locator('#apply-claims-limits').click();
    await expect(page.locator('#claims-limits-error')).toContainText('whole numbers from 1 to 100');
  }
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'claimsLimits'))).toBe(false);
  await page.locator('#claims-rate-limit').fill('50');
  await page.locator('#claims-concurrency').fill('24');
  await page.locator('#apply-claims-limits').click();
  await expect(page.locator('#claims-limits-status')).toContainText('Saved ceilings: 50/second · 24 simultaneous');
  await expect(page.locator('#claims-limits-error')).toBeEmpty();
  await expect(page.locator('#mobile-data')).toBeChecked();
  const calls = await page.evaluate(() => window.testNative.calls);
  expect(calls.filter(call => call.method === 'claimsLimits')).toEqual([
    { plugin: 'NativeWallet', method: 'claimsLimits', params: { connectionsPerSecondLimit: 50, concurrency: 24 } },
  ]);
  expect(calls.some(call => ['claimsStart', 'claimsPolicy'].includes(call.method))).toBe(false);
  await page.reload();
  await waitReady(page);
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#claims-rate-limit')).toHaveValue('50');
  await expect(page.locator('#claims-concurrency')).toHaveValue('24');
  expect(await page.evaluate(() => window.testNative.calls.some(call => ['claimsStart', 'claimsLimits'].includes(call.method)))).toBe(false);
});

test('polling preserves draft limits and saving while claims run does not restart or block Stop', async ({ page }) => {
  await openNativeWallet(page, { claims: { enabled: true, requested: true, running: true, status: 'claiming', activeConnections: 10 } });
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await page.locator('#claims-rate-limit').fill('25');
  await page.locator('#claims-concurrency').fill('15');
  const before = await page.evaluate(() => window.testNative.calls.filter(call => call.method === 'claimsState').length);
  await expect.poll(() => page.evaluate(() => window.testNative.calls.filter(call => call.method === 'claimsState').length)).toBeGreaterThan(before);
  await expect(page.locator('#claims-rate-limit')).toHaveValue('25');
  await expect(page.locator('#claims-concurrency')).toHaveValue('15');
  await expect(page.locator('#claims-limits-status')).toContainText('Unsaved changes');
  await page.evaluate(() => { window.testNative.deferredMethods.claimsLimits = true; });
  await page.locator('#apply-claims-limits').click();
  await expect(page.locator('#apply-claims-limits')).toBeDisabled();
  await expect(page.locator('#claims-rate-limit')).toBeDisabled();
  await expect(page.locator('#stop-claims')).toBeEnabled();
  await page.locator('#stop-claims').click();
  await page.evaluate(() => window.testNative.releaseResponses());
  await expect(page.locator('#claims-limits-status')).toContainText('Saved ceilings: 25/second · 15 simultaneous');
  await expect(page.locator('#claims-status')).toContainText('stopped');
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'claimsStart'))).toBe(false);
});

test('old native polls cannot overwrite freshly saved claims limits', async ({ page }) => {
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await page.evaluate(() => { window.testNative.deferredMethods = { getState: true, claimsState: true }; });
  await expect.poll(() => page.evaluate(() => window.testNative.pendingResponses.map(item => item.method).sort())).toEqual(['claimsState', 'getState']);
  await page.locator('#claims-rate-limit').fill('7');
  await page.locator('#claims-concurrency').fill('3');
  await page.locator('#apply-claims-limits').click();
  await expect(page.locator('#claims-limits-status')).toContainText('Saved ceilings: 7/second · 3 simultaneous');
  await page.evaluate(() => window.testNative.releaseResponses());
  await expect(page.locator('#claims-rate-limit')).toHaveValue('7');
  await expect(page.locator('#claims-concurrency')).toHaveValue('3');
});

test('failed save keeps draft limits available for retry without starting claims', async ({ page }) => {
  await openNativeWallet(page);
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await page.locator('#claims-rate-limit').fill('4');
  await page.locator('#claims-concurrency').fill('2');
  await page.evaluate(() => { window.testNative.failLimits = true; });
  await page.locator('#apply-claims-limits').click();
  await expect(page.locator('#claims-limits-error')).toContainText('could not save');
  await expect(page.locator('#claims-rate-limit')).toHaveValue('4');
  await expect(page.locator('#claims-concurrency')).toHaveValue('2');
  await expect(page.locator('#apply-claims-limits')).toBeEnabled();
  await page.evaluate(() => { window.testNative.failLimits = false; });
  await page.locator('#apply-claims-limits').click();
  await expect(page.locator('#claims-limits-status')).toContainText('Saved ceilings: 4/second · 2 simultaneous');
  expect(await page.evaluate(() => window.testNative.calls.some(call => call.method === 'claimsStart'))).toBe(false);
});

test('unknown saved limits and browser preview cannot apply phantom defaults', async ({ page }) => {
  await page.goto('/');
  await waitReady(page);
  await expect(page.locator('#apply-claims-limits')).toBeDisabled();
  await expect(page.locator('#claims-rate-limit')).toBeDisabled();
  await openNativeWallet(page, { claims: { connectionsPerSecondLimit: null, concurrency: null } });
  await page.getByRole('button', { name: 'Claims', exact: true }).click();
  await expect(page.locator('#claims-limits-status')).toContainText('Waiting for saved');
  await expect(page.locator('#apply-claims-limits')).toBeDisabled();
  await expect(page.locator('#claims-rate-limit')).toBeDisabled();
  await page.locator('#claims-limits-form').dispatchEvent('submit');
  expect(await page.evaluate(() => window.testNative.calls.some(call => ['claimsStart', 'claimsLimits'].includes(call.method)))).toBe(false);
});

test('payment request fields, long links and QR fit the smallest supported viewport', async ({ page }) => {
  await isolateClipboard(page);
  await openReceive(page);
  await page.locator('#receive-amount').fill('12345678.1234567890');
  await page.locator('#receive-label').fill('a'.repeat(100));
  await page.locator('#receive-message').fill('b'.repeat(200));
  await expect(page.locator('#copy-link')).toBeEnabled();
  for (const size of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const id of ['receive-amount', 'receive-label', 'receive-message', 'receive-uri', 'copy-link']) {
      const bounds = await page.locator(`#${id}`).boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width);
    }
    await page.locator('#copy-link').click();
    await expect(page.locator('#copy-status')).toHaveText('Payment link copied.');
    expect(await page.evaluate(() => window.testCopiedLink)).toBe(await page.locator('#receive-uri').inputValue());
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.screenshot({ path: 'test-results/mobile-receive-small.png', fullPage: true });
});
