import { parseMainnetAddress, validateTip, validateBalance, validateHistory, mergeHistory } from './model.mjs';

// All callers validate the pinned network before comparing these immutable
// block attributes. A matching hash alone must not hide contradictory metadata.
function sameTip(left, right) {
  return left?.hash === right.hash && left?.height === right.height && left?.mediantime === right.mediantime;
}

export function publicError(error) {
  if (String(error?.code) === '-32029' || error?.code === 'RATE_LIMIT') return 'Too many requests. Wait one minute before trying again.';
  if (String(error?.code) === '-32011') return 'History changed. Refresh to start a new page sequence.';
  if (String(error?.code) === '-32001') return 'The node is not ready. Try again later.';
  if (error?.code === 'UNAVAILABLE') return 'Live queries require the mobile app. Browser preview has no RPC connection.';
  return 'Could not verify the server response. Check your connection and try again.';
}

// No keys, signing, broadcasting, timers or retries. Every response belongs to
// one foreground generation, so a late response cannot restore an old address.
export class WalletSession {
  constructor({ query, cancelAll = async () => {}, onChange = () => {} }) {
    Object.assign(this, { query, cancelAll, onChange });
    this.generation = 0;
    // Unlike state.busy, this counts outstanding queries from invalidated
    // generations too. A scheduler must not fill the shared native RPC queue
    // simply because a foreground/account change hid an older request.
    this.pendingRefreshes = 0;
    this.active = true;
    this.connected = true;
    this.displayTip = null; this.confirmationsStale = true;
    this.state = { address: '', balance: null, tip: null, history: [], cursor: null, historyStale: false, busy: false, error: '', updatedAt: null, stale: false };
  }
  getState() {
    return { ...this.state, displayTip: this.displayTip ? { ...this.displayTip } : null,
      history: this.state.history.map(row => ({ ...row,
        ...(!this.confirmationsStale && !this.state.stale && this.displayTip && row.status === 'confirmed' && row.block_height <= this.displayTip.height
          ? { confirmations: this.displayTip.height - row.block_height + 1 } : {}),
      })) };
  }
  emit() { this.onChange(this.getState()); }
  // A tip is display metadata, never a new balance/history snapshot or cursor.
  // Return true only when an explicit reset or detectable replacement needs reads.
  observeTip(value, { reset = false } = {}) {
    const tip = validateTip(value), previous = this.displayTip ?? this.state.balance?.tip ?? this.state.tip;
    // Duplicate subscription hints still pass full tip validation. Only avoid
    // repeating the identical display publication: connected/address handling
    // in LiveBalance remains responsible for its independent journal catch-up.
    if (!reset && this.displayTip && sameTip(this.displayTip, tip)) return false;
    const replaced = previous && (tip.height < previous.height || tip.height === previous.height && !sameTip(previous, tip));
    if (reset || replaced) {
      // Duplicate reset hints must not continually cancel the replacement read.
      if (!(this.confirmationsStale && this.state.historyStale && this.displayTip && sameTip(this.displayTip, tip))) {
        void this.invalidate(); this.state.historyStale = true; this.state.cursor = null;
      }
      this.displayTip = tip; this.emit(); return true;
    }
    this.displayTip = tip; this.emit(); return false;
  }
  acceptReadTip(tip, { history = false } = {}) {
    if (!this.displayTip || tip.height > this.displayTip.height || sameTip(this.displayTip, tip)) this.displayTip = { ...tip };
    if (history) this.confirmationsStale = false;
  }
  historyNeedsBaseline() { return this.confirmationsStale && this.state.historyStale; }
  disconnectWatch() {
    void this.invalidate(); this.state.historyStale = true; this.emit();
  }
  invalidate() {
    this.generation++;
    this.confirmationsStale = true; this.displayTip = null;
    this.state.busy = false;
    this.state.stale = Boolean(this.state.updatedAt);
    // Native cancellation is scheduled before any following query on the bridge.
    return Promise.resolve(this.cancelAll()).catch(() => {});
  }
  async loadAccount(text) {
    const address = parseMainnetAddress(text);
    const cancelled = this.invalidate();
    const generation = this.generation;
    this.state = { address, balance: null, tip: null, history: [], cursor: null, historyStale: false, busy: false, error: '', updatedAt: null, stale: false };
    this.emit();
    await cancelled;
    if (generation !== this.generation) return false;
    return this.refresh();
  }
  clearAccount() {
    this.invalidate();
    this.state = { address: '', balance: null, tip: null, history: [], cursor: null, historyStale: false, busy: false, error: '', updatedAt: null, stale: false };
    this.emit();
  }
  setEnvironment({ active = this.active, connected = this.connected } = {}) {
    const changed = active !== this.active || connected !== this.connected;
    this.active = active; this.connected = connected;
    if (changed) this.invalidate();
    this.emit();
  }
  async refresh({ more = false, balanceOnly = false, reloadLoaded = false } = {}) {
    if (!this.active || !this.connected || !this.state.address || this.state.busy || (more && (!this.state.cursor || balanceOnly))) return false;
    const generation = ++this.generation;
    const address = this.state.address;
    const cursor = more ? this.state.cursor : null;
    const wantedRows = reloadLoaded && !more ? Math.min(2000, this.state.history.length) : 0;
    this.pendingRefreshes++;
    this.state.busy = true; this.state.error = ''; this.emit();
    const current = () => generation === this.generation && this.active && this.connected;
    const checkKnownTip = tip => {
      // Reusing a block hash must never change its immutable metadata, even
      // when both independent responses repeat the same contradictory value.
      if ([this.state.balance?.tip, this.state.tip, this.displayTip].some(previous =>
        previous?.hash === tip.hash && !sameTip(previous, tip))) {
        throw Object.assign(new Error('Contradictory block metadata'), { code: '-32011' });
      }
    };
    try {
      // A fresh balance/history response already includes its validated tip.
      // Only pagination needs a preflight: reject a stale cursor before asking
      // for up to 500 rows which cannot be combined with the loaded history.
      let tip = null;
      if (more) {
        tip = validateTip(await this.query('getchaintip', {}));
        if (!current()) return false;
        if (!sameTip(this.state.tip, tip)) {
          this.state.cursor = null;
          this.state.historyStale = true;
          this.state.stale = true;
          throw Object.assign(new Error('History tip changed'), { code: '-32011' });
        }
      }
      if (balanceOnly) {
        const balance = validateBalance(await this.query('getaddressbalance', { address }), address);
        if (!current()) return false;
        tip = balance.tip; checkKnownTip(tip);
        // A manual/lightweight read can discover a replacement before the tip
        // stream does. Do not project old history onto that different branch.
        // A merely newer display tip during this read is not itself a rollback.
        const replaced = [this.state.balance?.tip, this.state.tip].some(previous => previous &&
          (tip.height < previous.height || tip.height === previous.height && !sameTip(previous, tip))) ||
          this.displayTip && tip.height === this.displayTip.height && !sameTip(this.displayTip, tip);
        if (replaced) {
          this.confirmationsStale = true; this.displayTip = { ...tip };
          this.state.historyStale = true; this.state.cursor = null;
        }
        // A lightweight balance update must not silently replace the history
        // pagination anchor with a tip its existing rows were never read at.
        this.state = { ...this.state, balance, updatedAt: Date.now(), stale: false, error: '',
          historyStale: this.state.historyStale || !sameTip(this.state.tip, tip) };
        this.acceptReadTip(tip);
        return true;
      }
      // Wait for both physical reads even if one fails. Otherwise a scheduler
      // could start another refresh while the sibling request is still live.
      const results = await Promise.allSettled([
        this.query('getaddressbalance', { address }),
        this.query('getaddresshistory', { address, ...(cursor ? { cursor } : {}) }),
      ]);
      if (!current()) return false;
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      const [balanceResult, historyResult] = results.map(result => result.value);
      const balance = validateBalance(balanceResult, address);
      const history = validateHistory(historyResult, address);
      if (!tip) tip = balance.tip;
      checkKnownTip(tip);
      // Separate RPC calls are not an atomic snapshot. Avoid combining blocks
      // or paginating through a reorg; the user can refresh without a retry loop.
      if (!sameTip(balance.tip, tip) || !sameTip(history.tip, tip)) {
        this.state.cursor = null;
        throw Object.assign(new Error('History tip changed'), { code: '-32011' });
      }
      if (cursor && history.next_cursor === cursor) {
        this.state.cursor = null;
        throw Object.assign(new Error('Repeated history cursor'), { code: '-32011' });
      }
      let rows = mergeHistory(more ? this.state.history : [], history.items), nextCursor = history.next_cursor;
      const cursors = new Set(cursor ? [cursor] : []);
      let accumulated = null;
      // Revalidate the loaded portion on address events without discarding it
      // after the first page. Bound requests and publish only a consistent set.
      for (let pages = 1; (accumulated?.size ?? rows.length) < wantedRows && nextCursor && pages < 20; pages++) {
        if (cursors.has(nextCursor)) throw Object.assign(new Error('Repeated history cursor'), { code: '-32011' });
        cursors.add(nextCursor);
        const page = validateHistory(await this.query('getaddresshistory', { address, cursor: nextCursor }), address);
        if (!current()) return false;
        if (!sameTip(page.tip, tip) || page.next_cursor && cursors.has(page.next_cursor)) {
          throw Object.assign(new Error('History tip changed'), { code: '-32011' });
        }
        // These pages are freshly validated private copies. Retain last-wins
        // duplicates without revalidating/copying/sorting all prior pages on
        // each iteration; the complete merge still validates before publication.
        accumulated ??= new Map(rows.map(row => [row.txid, row]));
        for (const row of page.items) accumulated.set(row.txid, row);
        nextCursor = page.next_cursor;
      }
      if (accumulated) {
        const collected = [...accumulated.values()];
        // Before the last page there are fewer than 2000 unique rows; one page
        // adds at most 500. Keep each merge input within its original limit and
        // let the unchanged final ordering/truncation select the same 2000.
        rows = mergeHistory(collected.slice(0, 2000), collected.slice(2000));
      }
      if (rows.length < wantedRows && nextCursor) throw Object.assign(new Error('History reload exceeded its page limit'), { code: '-32011' });
      this.state = { ...this.state, balance, tip, history: rows, cursor: rows.length >= 2000 ? null : nextCursor,
        historyStale: more ? this.state.historyStale : false, updatedAt: Date.now(), stale: false, error: '' };
      this.acceptReadTip(tip, { history: true });
      return true;
    } catch (error) {
      if (current()) {
        this.state.error = publicError(error);
        this.state.stale = Boolean(this.state.updatedAt);
        if (String(error?.code) === '-32011') {
          this.state.historyStale = true;
          if (!balanceOnly) this.state.cursor = null;
        }
      }
      return false;
    } finally {
      this.pendingRefreshes--;
      if (current()) { this.state.busy = false; this.emit(); }
    }
  }
}
