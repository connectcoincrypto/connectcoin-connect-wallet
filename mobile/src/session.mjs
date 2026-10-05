import { parseWatchAddress, validateTip, validateBalance, validateHistory, mergeHistory } from './model.mjs';

// All callers validate the pinned network before comparing these immutable
// block attributes. A matching hash alone must not hide contradictory metadata.
function sameTip(left, right) {
  return left?.hash === right.hash && left?.height === right.height && left?.mediantime === right.mediantime;
}

export function publicError(error) {
  if (String(error?.code) === '-32029' || error?.code === 'RATE_LIMIT') return 'Too many requests. Wait one minute before trying again.';
  if (String(error?.code) === '-32011') return 'History changed. Refresh to start a new page sequence.';
  if (String(error?.code) === '-32001') return 'The node is not ready. Try again later.';
  if (error?.code === 'UNAVAILABLE') return 'Live queries require the Android app. Browser preview has no RPC connection.';
  return 'Could not verify the server response. Check your connection and try again.';
}

// No keys, signing, broadcasting, timers or retries. Every response belongs to
// one foreground generation, so a late response cannot restore an old address.
export class WatchSession {
  constructor({ query, cancelAll = async () => {}, onChange = () => {} }) {
    Object.assign(this, { query, cancelAll, onChange });
    this.generation = 0;
    this.active = true;
    this.connected = true;
    this.state = { address: '', balance: null, tip: null, history: [], cursor: null, busy: false, error: '', updatedAt: null, stale: false };
  }
  emit() { this.onChange({ ...this.state, history: [...this.state.history] }); }
  invalidate() {
    this.generation++;
    this.state.busy = false;
    this.state.stale = Boolean(this.state.updatedAt);
    // Native cancellation is scheduled before any following query on the bridge.
    return Promise.resolve(this.cancelAll()).catch(() => {});
  }
  async watch(text) {
    const address = parseWatchAddress(text);
    const cancelled = this.invalidate();
    const generation = this.generation;
    this.state = { address, balance: null, tip: null, history: [], cursor: null, busy: false, error: '', updatedAt: null, stale: false };
    this.emit();
    await cancelled;
    if (generation !== this.generation) return false;
    return this.refresh();
  }
  forget() {
    this.invalidate();
    this.state = { address: '', balance: null, tip: null, history: [], cursor: null, busy: false, error: '', updatedAt: null, stale: false };
    this.emit();
  }
  setEnvironment({ active = this.active, connected = this.connected } = {}) {
    const changed = active !== this.active || connected !== this.connected;
    this.active = active; this.connected = connected;
    if (changed) this.invalidate();
    this.emit();
  }
  async refresh({ more = false } = {}) {
    if (!this.active || !this.connected || !this.state.address || this.state.busy || (more && !this.state.cursor)) return false;
    const generation = ++this.generation;
    const address = this.state.address;
    const cursor = more ? this.state.cursor : null;
    this.state.busy = true; this.state.error = ''; this.emit();
    const current = () => generation === this.generation && this.active && this.connected;
    try {
      const tip = validateTip(await this.query('getchaintip', {}));
      if (!current()) return false;
      if (more && !sameTip(this.state.tip, tip)) {
        this.state.cursor = null;
        this.state.stale = true;
        throw Object.assign(new Error('History tip changed'), { code: '-32011' });
      }
      const [balanceResult, historyResult] = await Promise.all([
        this.query('getaddressbalance', { address }),
        this.query('getaddresshistory', { address, ...(cursor ? { cursor } : {}) }),
      ]);
      if (!current()) return false;
      const balance = validateBalance(balanceResult, address);
      const history = validateHistory(historyResult, address);
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
      const rows = mergeHistory(more ? this.state.history : [], history.items);
      this.state = { ...this.state, balance, tip, history: rows, cursor: rows.length >= 2000 ? null : history.next_cursor,
        updatedAt: Date.now(), stale: false, error: '' };
      return true;
    } catch (error) {
      if (current()) {
        this.state.error = publicError(error);
        this.state.stale = Boolean(this.state.updatedAt);
        if (String(error?.code) === '-32011') this.state.cursor = null;
      }
      return false;
    } finally {
      if (current()) { this.state.busy = false; this.emit(); }
    }
  }
}
