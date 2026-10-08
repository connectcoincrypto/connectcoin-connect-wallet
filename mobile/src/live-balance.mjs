import { validateTip } from './model.mjs';

// Subscription events are hints, never authoritative balances. Only the
// existing validated, generation-guarded RPC reads publish account data.
// Timers exist only for pending changes/retries, not periodic balance polling.
export class LiveBalance {
  constructor({ session, allowed, now = () => performance.now(),
    setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = timer => clearTimeout(timer) }) {
    Object.assign(this, { session, allowed, now, setTimer, clearTimer });
    this.address = ''; this.epoch = 0; this.dirty = false; this.connected = false;
    this.full = false;
    this.timer = null; this.running = false; this.nextAt = 0;
  }
  sync() {
    if (this.address === this.session.state.address) return;
    this.address = this.session.state.address; this.epoch++;
    this.connected = false; this.dirty = false; this.full = false; this.nextAt = 0;
    this.cancelTimer();
  }
  cancelTimer() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
  pause() { this.cancelTimer(); this.connected = false; }
  notify(event) {
    this.sync();
    if (!this.address || !event || event.address !== this.address ||
        !['connected', 'disconnected', 'address', 'tip'].includes(event.reason)) return;
    if (event.reorg !== undefined && typeof event.reorg !== 'boolean' ||
        event.resync_required !== undefined && typeof event.resync_required !== 'boolean') return;
    if (event.reason === 'tip' && !event.tip) return;
    let reset = event.reorg === true || event.resync_required === true;
    if (event.tip) {
      try {
        const tip = validateTip(event.tip);
        const currentTip = this.session.displayTip ?? this.session.state.balance?.tip ?? this.session.state.tip;
        // The registration ACK is a snapshot taken before the other addresses
        // finish subscribing. A concurrent balance read may already be newer.
        // An older unflagged ACK is not a rollback; still request journal catch-up
        // below. Explicit resets and live tip events retain their reorg checks.
        const olderAck = event.reason === 'connected' && !reset && currentTip && tip.height < currentTip.height;
        if (!olderAck) reset = this.session.observeTip(tip, { reset });
      } catch { return; }
    } else if (reset) {
      this.session.disconnectWatch();
    }
    if (event.reason === 'tip') {
      if (reset) this.request({ full: true });
      return;
    }
    if (event.reason === 'disconnected') {
      const wasConnected = this.connected;
      this.connected = false;
      // One lost established watch invalidates old-chain reads/projection.
      // Repeated failed registrations must not starve separate startup queries.
      if (wasConnected) { this.session.disconnectWatch(); this.request({ full: true }); }
      return;
    }
    // Native only emits address hints for its validated, address-only watch.
    // They also recover a connected hint missed while the renderer was paused.
    this.connected = true;
    this.request({ full: true });
  }
  request({ failed = false, full = false } = {}) {
    this.sync(); if (!this.address) return;
    this.full ||= full;
    this.dirty = true;
    if (failed) this.nextAt = Math.max(this.nextAt, this.now() + 60000);
    this.wake();
  }
  wake() {
    this.sync();
    if (!this.dirty || !this.allowed() || !this.session.active || !this.session.connected) {
      this.cancelTimer(); return;
    }
    if (this.running || this.timer !== null) return;
    const delay = Math.max(250, this.nextAt - this.now(), this.session.pendingRefreshes || this.session.state.busy ? 500 : 0);
    this.timer = this.setTimer(() => { this.timer = null; void this.flush(); }, delay);
  }
  async flush() {
    this.sync();
    if (!this.dirty || !this.allowed() || !this.session.active || !this.session.connected) return;
    if (this.running || this.session.pendingRefreshes || this.session.state.busy || this.now() < this.nextAt) { this.wake(); return; }
    const epoch = this.epoch, generation = this.session.generation;
    const full = this.full;
    this.running = true; this.dirty = false; this.full = false;
    let refreshed = false;
    try {
      refreshed = await this.session.refresh(full ? { reloadLoaded: true } : { balanceOnly: true });
    } catch { /* Session normally converts failures into a safe public error. */ }
    finally {
      this.running = false;
      if (epoch === this.epoch) {
        // At most one follow-up for notifications received during a read.
        // Generic RPC errors conceal quota details: use a conservative retry.
        const invalidated = this.session.generation !== generation + 1;
        this.nextAt = this.now() + (refreshed || invalidated ? 2000 : 60000);
        if (!refreshed) { this.dirty = true; this.full ||= full; }
        else if (this.session.historyNeedsBaseline()) { this.dirty = true; this.full = true; }
      }
      this.wake();
    }
  }
}
