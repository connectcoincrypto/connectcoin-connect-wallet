import { WalletSession, publicError } from './session.mjs';
import { formatConn, parseMainnetAddress, validateHistory, validateTip } from './model.mjs';
import { addressSetKey, addressSyncFromCheckpoints, setAddressBaseline, updateAddressSync, syncUtxoRow } from './hd-sync.mjs';
import { readDisplayCache, createDisplayCache } from './hd-display-cache.mjs';

const MAX_ACCOUNTS = 10000, MAX_ROWS = 200000, MAX_ADDRESS_ROWS = 20000, MAX_PAGES = 512;
const COIN_LIMIT = 1_000_000_000_000_000_000n;
export const HD_READ_CONCURRENCY = 16;
const cancelled = () => Object.assign(new Error('Wallet changed.'), { code: 'RPC_CANCELLED' });
const invalid = () => new Error('Could not verify the HD wallet snapshot.');
const sameLocation = (a, b) => a.status === b.status && a.block_height === b.block_height && a.block_hash === b.block_hash;

function recoverySeeds(value, accounts, walletId) {
  const allowed = new Set(accounts.map(account => account.address)), pages = new Map(), checkpoints = [];
  if (!value || value.walletId !== walletId || !Array.isArray(value.groups) || value.groups.length > accounts.length ||
      new TextEncoder().encode(JSON.stringify(value)).length > 8 * 1024 * 1024) return { pages, checkpoints };
  for (const group of value.groups) {
    if (!Array.isArray(group.addresses) || !group.addresses.length || group.addresses.length > 100 ||
        !Array.isArray(group.histories) || group.histories.length !== group.addresses.length) throw invalid();
    addressSyncFromCheckpoints({ network: 'main', addresses: group.addresses, checkpoints: [group] });
    const requested = new Set(group.addresses);
    for (const raw of group.histories) {
      if (!allowed.has(raw.address) || !requested.delete(raw.address) || pages.has(raw.address)) throw invalid();
      pages.set(raw.address, validateHistory(raw, raw.address, { allowEmptyContinuation: true }));
    }
    if (requested.size) throw invalid();
    checkpoints.push({ addresses: [...group.addresses], sync: group.sync });
  }
  return { pages, checkpoints };
}

export function nativeHdAccounts(info) {
  if (info?.accountScope !== 'hd-wallet') return null;
  if (!Array.isArray(info.accounts) || !info.accounts.length || info.accounts.length > MAX_ACCOUNTS ||
      !info.hd || typeof info.hd.complete !== 'boolean' || typeof info.hd.recovering !== 'boolean') throw invalid();
  const addresses = new Set(), paths = new Set();
  const accounts = info.accounts.map(item => {
    if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index > 0x7fffffff ||
        ![0, 1].includes(item.change) || item.network !== 'main' ||
        item.path !== `m/44'/0'/0'/${item.change}/${item.index}`) throw invalid();
    const address = parseMainnetAddress(item.address), path = `${item.change}:${item.index}`;
    if (address !== item.address || addresses.has(address) || paths.has(path)) throw invalid();
    addresses.add(address); paths.add(path);
    return { address, index: item.index, change: item.change, path: item.path };
  });
  const first = accounts.find(item => item.index === 0 && item.change === 0);
  if (!first || info.walletId !== first.address || !addresses.has(info.account?.address) ||
      !accounts.some(item => item.address === info.account.address && item.change === 0 && item.index === info.account.index)) throw invalid();
  return accounts;
}

function utxoPage(page, address) {
  if (!page || page.address !== address || page.unit !== 'connects' || page.live !== true ||
      !Array.isArray(page.items) || page.items.length > 500 || !Object.hasOwn(page, 'next_cursor')) throw invalid();
  const tip = validateTip(page.tip);
  if (page.next_cursor !== null && (typeof page.next_cursor !== 'string' || page.next_cursor.length > 1024 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(page.next_cursor))) throw invalid();
  const keys = new Set();
  const items = page.items.map(raw => {
    const row = syncUtxoRow(raw), key = `${row.txid}:${row.vout}`;
    const count = row.status === 'confirmed' ? tip.height - row.block_height + 1 : 0;
    if (keys.has(key) || count !== row.confirmations || count < 0 ||
        row.mature !== (!row.coinbase || count >= 100)) throw invalid();
    keys.add(key); return row;
  });
  return { items, next_cursor: page.next_cursor };
}

// Sixteen rolling workers, with cancellation checked before each physical query.
// Wait for every sibling even on failure: no abandoned work can fill RPC queues.
async function parallel(items, work, check) {
  let next = 0, failed;
  const checkpoint = () => { check(); if (failed) throw failed; };
  await Promise.all(Array.from({ length: Math.min(HD_READ_CONCURRENCY, items.length) }, async () => {
    try {
      while (!failed && next < items.length) { checkpoint(); const item = items[next++]; await work(item, checkpoint); }
    } catch (error) { failed ??= error; }
  }));
  if (failed) throw failed;
  check();
}

export function hdSnapshot(sync, accounts, walletId) {
  const totals = { confirmed: 0n, immature: 0n, available_confirmed: 0n, pending_received: 0n, pending_spent: 0n };
  const history = new Map(), outpoints = new Set(), fundingAddresses = new Set();
  for (const account of accounts) {
    const rows = sync.addresses.get(account.address);
    if (!rows) throw invalid();
    for (const row of rows.history.values()) {
      const previous = history.get(row.txid);
      if (previous && !sameLocation(previous, row)) throw invalid();
      const confirmations = row.status === 'confirmed' ? sync.tip.height - row.block_height + 1 : 0;
      if (confirmations < (row.status === 'confirmed' ? 1 : 0)) throw invalid();
      history.set(row.txid, { ...row, confirmations,
        received: ((previous ? BigInt(previous.received) : 0n) + BigInt(row.received)).toString(),
        spent: ((previous ? BigInt(previous.spent) : 0n) + BigInt(row.spent)).toString(),
        balance_delta: ((previous ? BigInt(previous.balance_delta) : 0n) + BigInt(row.balance_delta)).toString(),
        addresses: [...(previous?.addresses ?? []), account.address] });
    }
    for (const row of rows.utxos.values()) {
      const key = `${row.txid}:${row.vout}`, amount = BigInt(row.amount);
      if (outpoints.has(key)) throw invalid(); // One output cannot belong to two different keys.
      outpoints.add(key);
      if (row.status === 'confirmed') {
        const count = sync.tip.height - row.block_height + 1;
        if (count < 1) throw invalid();
        const mature = !row.coinbase || count >= 100;
        if (!mature && row.pending_spent_by) throw invalid();
        totals.confirmed += amount;
        if (!mature) totals.immature += amount;
        if (row.pending_spent_by) totals.pending_spent += amount;
        else if (mature) {
          totals.available_confirmed += amount;
          if (amount > 0n) fundingAddresses.add(account.address);
        }
      } else if (!row.pending_spent_by) totals.pending_received += amount;
    }
  }
  totals.pending_delta = totals.pending_received - totals.pending_spent;
  totals.total = totals.confirmed + totals.pending_delta;
  for (const [key, value] of Object.entries(totals)) {
    if (value > COIN_LIMIT || value < (key === 'pending_delta' ? -COIN_LIMIT : 0n)) throw invalid();
  }
  const ordered = [...history.values()].sort((a, b) => a.status !== b.status ? (a.status === 'pending' ? -1 : 1)
    : (b.block_height ?? 0) - (a.block_height ?? 0) || a.txid.localeCompare(b.txid));
  for (const row of ordered) for (const field of ['received', 'spent', 'balance_delta']) formatConn(row[field]);
  return { balance: { address: walletId, tip: sync.tip, unit: 'connects',
    ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value.toString()])) }, history: ordered,
    fundingAddresses: [...fundingAddresses] };
}

export class HdWalletSession extends WalletSession {
  constructor(options) {
    super(options);
    this.readCache = options.readCache ?? (async () => null);
    this.writeCache = options.writeCache ?? (async () => {});
    this.readRecoverySnapshots = options.readRecoverySnapshots ?? (async () => null);
    this.recoveryConsumed = false;
    this.hd = false; this.accounts = []; this.accountKey = ''; this.journal = null;
    this.fullHistory = []; this.visibleRows = 500;
  }
  async loadWallet(info) {
    const accounts = nativeHdAccounts(info);
    if (!accounts) {
      this.hd = false; this.accounts = []; this.accountKey = ''; this.journal = null;
      if (info.account?.address !== this.state.address) return this.loadAccount(info.account.address);
      return true;
    }
    const key = addressSetKey(accounts.map(item => item.address));
    const changedWallet = !this.hd || info.walletId !== this.state.address;
    const changedSet = key !== this.accountKey;
    const complete = info.hd.complete && !info.hd.recovering;
    const becameReady = complete && this.state.hdComplete !== true;
    if (changedWallet || changedSet || !complete && this.state.hdComplete !== false) {
      this.invalidate(); this.journal = null;
    }
    if (changedWallet || !complete && this.state.hdComplete !== false) this.recoveryConsumed = false;
    if (changedWallet) {
      this.fullHistory = []; this.visibleRows = 500;
      this.state = { address: info.walletId, balance: null, tip: null, history: [], cursor: null,
        historyStale: false, busy: false, error: '', updatedAt: null, stale: false, cached: false, progress: null,
        partial: false, verifiedAddresses: [], fundingAddresses: [] };
    }
    this.hd = true; this.accounts = accounts; this.accountKey = key;
    this.state = { ...this.state, receiveAddress: info.account.address, hdComplete: complete, scope: 'hd',
      addressCount: accounts.length, ...(changedSet && !changedWallet ? { stale: true } : {}) };
    this.emit();
    if (changedWallet) {
      const generation = this.generation;
      let saved;
      try { saved = readDisplayCache(await this.readCache(info.walletId), { walletId: info.walletId, accounts }); } catch { /* Cache is optional. */ }
      if (generation !== this.generation || key !== this.accountKey || info.walletId !== this.state.address) return false;
      if (saved) {
        this.state = { ...this.state, ...saved, tip: saved.balance.tip, cached: true, stale: true, historyStale: true };
        this.confirmationsStale = true;
        this.emit();
      }
    }
    if ((changedWallet || changedSet || becameReady) && complete) return this.refresh();
    return complete;
  }
  clearAccount() {
    this.hd = false; this.accounts = []; this.accountKey = ''; this.journal = null; this.fullHistory = []; this.recoveryConsumed = false;
    return super.clearAccount();
  }
  invalidate() {
    this.state.progress = null;
    this.state.verifiedAddresses = [];
    this.state.fundingAddresses = [];
    return super.invalidate();
  }
  getState() {
    return { ...super.getState(), verifiedAddresses: [...(this.state.verifiedAddresses ?? [])],
      fundingAddresses: [...(this.state.fundingAddresses ?? [])] };
  }
  observeTip(value, options) {
    const reset = super.observeTip(value, options);
    if (reset) {
      this.journal = null;
      // A real chain reset needs a fresh baseline, not discovery snapshots
      // from before the reset. Ordinary cancellation can still reuse them.
      this.recoveryConsumed = true;
    }
    return reset;
  }
  async baseline({ rpc, accounts, address, check, progress, publishPartial, reuse = true }) {
    let seeds = { pages: new Map(), checkpoints: [] };
    if (reuse && !this.recoveryConsumed) {
      // Reading hints is not consuming them. A disconnect, backgrounding or
      // address-set update can invalidate this attempt before it completes.
      // Keep them eligible until a snapshot commits or their cursor expires.
      try { seeds = recoverySeeds(await this.readRecoverySnapshots(), accounts, address); }
      catch { /* Old native builds or discarded public hints use a fresh baseline. */ }
      check();
    }
    const checkpoints = [...seeds.checkpoints];
    const missing = accounts.filter(account => !seeds.pages.has(account.address)).map(account => account.address);
    for (let offset = 0; offset < missing.length; offset += 100) {
      check(); const addresses = missing.slice(offset, offset + 100);
      checkpoints.push({ addresses, sync: await rpc.request('getaddresschanges', { addresses }) });
    }
    const candidate = addressSyncFromCheckpoints({ network: 'main', addresses: accounts.map(account => account.address), checkpoints });
    let totalRows = 0, completed = 0, publishing = false, lastPublished = 0, lastPublication = 0;
    const ready = new Set();
    let previousPartial = null, previouslyReady = new Set();
    // A publisher borrows its baseline worker instead of creating a seventeenth
    // RPC stream. Coalesce quick completions, but expose the first verified
    // address even if another address is waiting for the minute quota.
    const publishReady = async checkpoint => {
      if (!publishPartial || publishing || completed === accounts.length) return;
      publishing = true;
      try {
        // Hold this worker briefly instead of dropping a throttled publication:
        // the next funded address must become usable even if all other workers
        // now wait a full quota window and no further completion wakes us.
        const delay = completed === 1 || completed % HD_READ_CONCURRENCY === 0 ? 0 : Math.max(0, 250 - (Date.now() - lastPublication));
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        checkpoint();
        if (completed === accounts.length) return;
        do {
          if (lastPublished) {
            const coalesce = Math.max(0, 250 - (Date.now() - lastPublication));
            if (coalesce) await new Promise(resolve => setTimeout(resolve, coalesce));
          }
          checkpoint();
          if (completed === accounts.length) return;
          const selected = accounts.filter(account => ready.has(account.address));
          const selectedSet = new Set(selected.map(account => account.address));
          // Cursors are bound to their ORIGINAL group, not an arbitrary subset.
          // Replay whole overlapping groups in a private copy, then aggregate
          // only addresses whose complete history AND UTXO pages were loaded.
          // Never advance candidate's cursors before the remaining baselines.
          const batches = [], rows = new Map(), initialBatches = [];
          for (const original of candidate.batches) {
            if (!original.addresses.some(item => selectedSet.has(item))) continue;
            const batchKey = addressSetKey(original.addresses);
            const retained = previousPartial?.batches.find(batch => addressSetKey(batch.addresses) === batchKey);
            const unchanged = retained && original.addresses.every(item => selectedSet.has(item) === previouslyReady.has(item));
            batches.push(unchanged ? retained : original);
            for (const item of original.addresses) rows.set(item, (unchanged ? previousPartial : candidate).addresses.get(item));
            if (!unchanged) initialBatches.push(batchKey);
          }
          const seed = { ...candidate, batches, addresses: rows };
          const reconciled = await updateAddressSync(seed, { rpc, check: checkpoint, initialBatches });
          checkpoint();
          publishPartial(reconciled, selected);
          previousPartial = reconciled; previouslyReady = selectedSet;
          lastPublished = selected.length; lastPublication = Date.now();
        } while (completed > lastPublished && completed < accounts.length);
      } catch (error) {
        // Its candidate covers only partial baseline groups: it must NEVER be
        // promoted to the full wallet journal by refresh's retry handling.
        if (error.code !== 'ADDRESS_SYNC_BUSY') throw error;
        lastPublication = Date.now();
      } finally { publishing = false; }
    };
    progress('snapshot', completed);
    try { await parallel(accounts, async (account, checkpoint) => {
      const values = {};
      const seed = seeds.pages.get(account.address);
      // A fully empty recovery history has no outputs at that checkpoint. The
      // original journal catches every later arrival/spend, even at the same tip.
      const emptyRecovery = seed && seed.items.length === 0 && seed.next_cursor === null;
      for (const [kind, method] of [['history', 'getaddresshistory'], ['utxos', 'getaddressutxos']]) {
        if (kind === 'utxos' && emptyRecovery) { values.utxos = []; continue; }
        let cursor = null; const seen = new Set(), rows = [];
        for (let pages = 0; ; pages++) {
          checkpoint();
          if (pages >= MAX_PAGES) throw new Error('This address exceeds the mobile history page limit. Its funds were not verified.');
          const result = pages === 0 && kind === 'history' && seed ? seed : await rpc.request(method, {
            address: account.address, ...(cursor ? { cursor } : {}), ...(kind === 'utxos' ? { include_pending_spent: true } : {}) });
          checkpoint();
          const page = kind === 'history' ? validateHistory(result, account.address, { allowEmptyContinuation: true }) : utxoPage(result, account.address);
          rows.push(...page.items); totalRows += page.items.length;
          if (rows.length > MAX_ADDRESS_ROWS || totalRows > MAX_ROWS) throw new Error('Wallet history exceeds the mobile resource limit. Unverified funds were not included.');
          cursor = page.next_cursor;
          if (!cursor) break;
          if (seen.has(cursor)) throw invalid();
          seen.add(cursor);
        }
        values[kind] = rows;
      }
      setAddressBaseline(candidate, account.address, values);
      ready.add(account.address);
      progress('snapshot', ++completed);
      await publishReady(checkpoint);
    }, check); } catch (error) {
      if (seeds.pages.size && String(error.code) === '-32011') error.recoveryBaselineExpired = true;
      throw error;
    }
    return { candidate, reused: seeds.pages.size > 0 };
  }
  async refresh(options = {}) {
    if (!this.hd) return super.refresh(options);
    if (!this.active || !this.connected || !this.state.hdComplete || this.state.busy || this.pendingRefreshes) return false;
    if (options.more && this.state.cursor) {
      this.generation++;
      this.visibleRows = Math.min(2000, this.visibleRows + 500);
      this.state.history = this.fullHistory.slice(0, this.visibleRows);
      this.state.cursor = this.fullHistory.length > this.visibleRows && this.visibleRows < 2000 ? `hd:${this.visibleRows}` : null;
      this.emit(); return true;
    }
    const generation = ++this.generation, key = this.accountKey, address = this.state.address;
    const accounts = [...this.accounts];
    const current = () => generation === this.generation && key === this.accountKey && this.active && this.connected && this.state.hdComplete;
    const check = () => { if (!current()) throw cancelled(); };
    const rpc = { request: async (method, params) => { check(); const result = await this.query(method, params); check(); return result; } };
    const progress = (phase, completed) => { check(); this.state.progress = { phase, completed, total: accounts.length }; this.emit(); };
    const publishPartial = (sync, selected) => {
      check();
      const snapshot = hdSnapshot(sync, selected, address);
      this.fullHistory = snapshot.history;
      this.state = { ...this.state, balance: snapshot.balance, tip: sync.tip,
        history: snapshot.history.slice(0, this.visibleRows), cursor: null,
        historyStale: false, updatedAt: Date.now(), stale: false, error: '', cached: false,
        partial: true, verifiedAddresses: selected.map(account => account.address), fundingAddresses: snapshot.fundingAddresses };
      this.acceptReadTip(sync.tip, { history: true });
      this.emit();
    };
    const discardPartial = () => {
      if (this.state.partial) { this.state.stale = true; this.state.verifiedAddresses = []; this.state.fundingAddresses = []; this.emit(); }
    };
    this.pendingRefreshes++; this.state.busy = true; this.state.error = ''; this.emit();
    let candidate = this.journal;
    try {
      let reused = false;
      if (!candidate) {
        try { ({ candidate, reused } = await this.baseline({ rpc, accounts, address, check, progress, publishPartial })); }
        catch (error) {
          if (!error.recoveryBaselineExpired) throw error;
          check();
          this.recoveryConsumed = true;
          discardPartial();
          ({ candidate } = await this.baseline({ rpc, accounts, address, check, progress, publishPartial, reuse: false }));
        }
      }
      progress('changes', 0);
      try { candidate = await updateAddressSync(candidate, { rpc, check }); }
      catch (error) {
        if (!reused || String(error.code) !== '-32011') throw error;
        check();
        this.recoveryConsumed = true;
        discardPartial();
        ({ candidate } = await this.baseline({ rpc, accounts, address, check, progress, publishPartial, reuse: false }));
        progress('changes', 0);
        candidate = await updateAddressSync(candidate, { rpc, check });
      }
      check();
      const snapshot = hdSnapshot(candidate, accounts, address);
      this.recoveryConsumed = true;
      this.journal = candidate; this.fullHistory = snapshot.history;
      this.state = { ...this.state, balance: snapshot.balance, tip: candidate.tip,
        history: snapshot.history.slice(0, this.visibleRows),
        cursor: snapshot.history.length > this.visibleRows && this.visibleRows < 2000 ? `hd:${this.visibleRows}` : null,
        historyStale: false, updatedAt: Date.now(), stale: false, error: '', cached: false, progress: null,
        partial: false, verifiedAddresses: accounts.map(account => account.address), fundingAddresses: snapshot.fundingAddresses };
      this.acceptReadTip(candidate.tip, { history: true });
      const saved = createDisplayCache(this.state, accounts);
      if (saved) void Promise.resolve().then(() => { if (current()) return this.writeCache(address, saved); }).catch(() => {});
      return true;
    } catch (error) {
      if (current()) {
        this.state.error = error.code === 'ADDRESS_SYNC_BUSY' ? 'Synchronizing address changes. The previous balance remains unverified; retry shortly.' : publicError(error);
        this.state.stale = true;
        if (error.code === 'ADDRESS_SYNC_BUSY' && error.candidate) this.journal = error.candidate;
        else if (String(error.code) === '-32011') { this.journal = null; this.state.historyStale = true; }
      }
      return false;
    } finally { this.pendingRefreshes--; if (current()) { this.state.busy = false; this.state.progress = null; this.emit(); } }
  }
}
