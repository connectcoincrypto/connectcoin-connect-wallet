import { validateTip } from './config.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [null, Object.prototype].includes(Object.getPrototypeOf(value));
const identifier = value => typeof value === 'string' && value.length >= 1 && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
const cursor = value => typeof value === 'string' && value.length >= 1 && value.length <= 4096;
const address = value => typeof value === 'string' && value.length >= 8 && value.length <= 90 && /^[A-Za-z0-9]+$/.test(value);
const capacityError = () => Object.assign(new Error('RPC address subscription capacity reached. Confirmed balances still refresh on block events; use Refresh for pending changes on untracked addresses.'), { code: 'LIVE_UPDATE_ADDRESS_CAPACITY' });

/** Notifications are wakeups, never authoritative balances, bounties or cursors. */
export class LiveUpdates {
  constructor({ rpc, network, isActive, getAddresses, onChange, onError = () => {},
    setTimer = setTimeout, clearTimer = clearTimeout, retryMinMs = 1000, retryMaxMs = 30000 }) {
    Object.assign(this, { rpc, network, isActive, getAddresses, onChange, onError, setTimer, clearTimer, retryMinMs, retryMaxMs });
    this.started = false; this.closed = false; this.generation = 0;
    this.registrations = new Map(); this.ids = new Map(); this.abort = new AbortController();
    this.running = null; this.requested = false; this.retryTimer = null; this.retryDelay = retryMinMs;
    this.baseReady = false; this.addressCapacity = false;
    this.addressBatch = false; this.addressPending = false; this.addressCatchup = false; this.addressTimer = null;
    this.connected = () => { this.invalidate(); this.requested = true; this.kick(); };
    this.disconnected = () => { this.invalidate(); this.requested = false; this.retry(); };
    this.notification = message => this.notify(message);
  }
  active() { return this.started && !this.closed && this.isActive(); }
  current(generation) { return this.active() && this.generation === generation; }
  report(error) {
    if (!this.active()) return;
    try { Promise.resolve(this.onError(error)).catch(() => {}); } catch {}
  }
  change(flags) {
    if (!this.active()) return;
    try { Promise.resolve(this.onChange({ wallet: false, bounties: false, reset: false, catchup: false, ...flags })).catch(error => this.report(error)); }
    catch (error) { this.report(error); }
  }
  invalidate() {
    this.generation++; this.abort.abort(); this.abort = new AbortController();
    this.registrations.clear(); this.ids.clear(); this.baseReady = false; this.addressCapacity = false;
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    if (this.addressTimer !== null) this.clearTimer(this.addressTimer);
    this.addressTimer = null; this.addressBatch = false; this.addressPending = false; this.addressCatchup = false;
  }
  addressChange(catchup = false) {
    if (!this.active()) return;
    if (!this.addressBatch) { this.change({ wallet: true, catchup }); return; }
    // Any real notification in a batch makes the entire wakeup real; the caller
    // may acknowledge subscription catch-ups covered by subsequent reads, but
    // must never accidentally acknowledge an actual change this way.
    this.addressCatchup = this.addressPending ? this.addressCatchup && catchup : catchup;
    this.addressPending = true;
    // Address registration is paced and may span several quota windows. Batch
    // its catch-up wakeups, but do not hold existing addresses' pending changes
    // hostage to a slow/queued subscription. This timer exists only while dirty.
    if (this.addressTimer === null) {
      const generation = this.generation;
      this.addressTimer = this.setTimer(() => {
        this.addressTimer = null;
        if (this.current(generation)) this.flushAddresses();
      }, 2000);
      this.addressTimer?.unref?.();
    }
  }
  flushAddresses() {
    if (this.addressTimer !== null) this.clearTimer(this.addressTimer);
    this.addressTimer = null;
    if (!this.addressPending) return;
    const catchup = this.addressCatchup;
    this.addressPending = false; this.addressCatchup = false; this.change({ wallet: true, catchup });
  }
  start() {
    if (this.closed || this.started) return;
    this.started = true;
    this.rpc.on('connected', this.connected); this.rpc.on('disconnected', this.disconnected);
    this.rpc.on('notification', this.notification);
    this.requested = true; this.kick();
  }
  updateAddresses() {
    if (!this.active()) return;
    this.requested = true; this.kick();
  }
  async watchAddress(value) {
    if (!address(value)) throw new Error('Invalid wallet address for live updates.');
    // Await registration before reading an address's history, so the following
    // read itself closes the subscription gap. Recovery derives accounts lazily.
    // The owner must include derived public accounts in getAddresses().
    for (let pass = 0; pass < 8; pass++) {
      if (!this.active()) throw Object.assign(new Error('Wallet live updates stopped.'), { name: 'AbortError', code: 'ABORT_ERR' });
      if (!this.addresses().has(value)) throw new Error('Wallet address is not available for live updates.');
      if (this.registrations.has(`address:${value}`)) return true;
      if (this.addressCapacity) return false;
      this.updateAddresses();
      const pending = this.running;
      if (!pending) throw new Error('RPC live updates are reconnecting; retry the wallet refresh.');
      await pending;
      // Allow the worker's finally to install a requested next pass if this
      // address was derived after the previous batch took its snapshot.
      await Promise.resolve();
    }
    throw new Error('RPC live updates changed while subscribing; retry the wallet refresh.');
  }
  retry() {
    if (!this.active() || this.retryTimer !== null) return;
    const wait = this.retryDelay;
    this.retryDelay = Math.min(this.retryMaxMs, this.retryDelay * 2);
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; this.requested = true; this.kick(); }, wait);
    this.retryTimer?.unref?.();
  }
  kick() {
    if (!this.active() || this.running || this.retryTimer !== null || !this.requested) return;
    this.requested = false;
    const work = Promise.resolve().then(() => this.ensure());
    this.running = work;
    void work.catch(error => { if (this.active()) { this.report(error); this.retry(); } }).finally(() => {
      if (this.running === work) this.running = null;
      this.kick();
    });
  }
  addresses() {
    const values = this.getAddresses();
    if (!Array.isArray(values) || values.some(value => !address(value))) throw new Error('Invalid wallet addresses for live updates.');
    return new Set(values);
  }
  async subscribe(key, kind, params, generation) {
    if (this.registrations.has(key)) return;
    const result = await this.rpc.request(`subscribe${kind}`, params, { signal: this.abort.signal });
    if (!this.current(generation)) return;
    if (!plain(result) || !identifier(result.subscription_id) || !cursor(result.cursor)) throw new Error('Invalid RPC subscription response.');
    validateTip(result.tip, this.network);
    if (this.ids.has(result.subscription_id)) throw new Error('Duplicate RPC subscription identifier.');
    const registration = { id: result.subscription_id, kind, address: params.address };
    this.registrations.set(key, registration); this.ids.set(registration.id, registration);
    // A notification can precede the promise continuation which installs its ID.
    // Catch up after installing the subscription, not before it.
    if (kind === 'address') this.addressChange(true);
  }
  async ensure() {
    if (!this.active()) return;
    // Establish the socket before taking the generation: initial connection emits
    // connected synchronously and invalidates registrations for any former socket.
    await this.rpc.connect();
    if (!this.active()) return;
    const generation = this.generation;
    try {
      await this.subscribe('tip', 'tip', {}, generation);
      if (!this.current(generation)) return;
      await this.subscribe('bounties', 'bounties', {}, generation);
      if (!this.current(generation)) return;
      if (!this.baseReady) {
        this.baseReady = true;
        this.change({ wallet: true, bounties: true, catchup: true });
      }
      const desired = this.addresses();
      for (const [key, registration] of this.registrations) {
        if (registration.kind !== 'address' || desired.has(registration.address)) continue;
        await this.rpc.request('unsubscribe', { subscription_id: registration.id }, { signal: this.abort.signal });
        if (!this.current(generation)) return;
        this.registrations.delete(key); this.ids.delete(registration.id);
        // Releasing one of our own slots is a reason to attempt a replacement.
        this.addressCapacity = false;
      }
      if (!this.addressCapacity) {
        this.addressBatch = true;
        let registered = 0;
        for (const value of desired) {
          if (!this.current(generation)) return;
          const key = `address:${value}`;
          if (this.registrations.has(key)) continue;
          // Server default: 100 subscriptions per IP, including our two base
          // subscriptions. Other clients behind the same IP may reduce capacity.
          if (this.registrations.size >= 100) {
            this.addressCapacity = true; this.report(capacityError()); break;
          }
          try {
            await this.subscribe(key, 'address', { address: value }, generation);
            if (!this.current(generation)) return;
            if (++registered % 8 === 0) this.flushAddresses();
          }
          catch (error) {
            if (!this.current(generation)) return;
            if (error?.code !== -32005) throw error;
            this.addressCapacity = true; this.report(capacityError()); break;
          }
        }
      }
      if (this.current(generation)) this.retryDelay = this.retryMinMs;
    } catch (error) {
      // Replies and failures from an old socket must not replace IDs or schedule
      // work for a locked wallet/new connection. Disconnect already queued retry.
      if (this.current(generation)) throw error;
    } finally {
      if (this.current(generation)) { this.addressBatch = false; this.flushAddresses(); }
    }
  }
  notify(message) {
    if (!this.active() || !plain(message) || !identifier(message.subscription_id)) return;
    const registration = this.ids.get(message.subscription_id);
    if (!registration || message.kind !== registration.kind) return;
    try {
      validateTip(message.tip, this.network);
      if (message.reorg !== undefined && typeof message.reorg !== 'boolean') return;
      if (message.resync_required !== undefined && typeof message.resync_required !== 'boolean') return;
      const reset = message.reorg === true || message.resync_required === true;
      if (message.kind === 'address') {
        if (message.address !== registration.address || message.refresh !== true || !this.addresses().has(message.address)) return;
        if (reset) this.change({ wallet: true, bounties: true, reset: true });
        else this.addressChange();
      } else if (message.kind === 'tip') {
        this.change({ wallet: true, bounties: true, reset });
      } else if (message.kind === 'bounties') {
        if (!cursor(message.cursor) || (message.resync_required !== true && (!Array.isArray(message.changes) || message.changes.length > 10000))) return;
        this.change({ wallet: reset, bounties: true, reset });
      }
    } catch (error) { this.report(error); }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.invalidate(); this.requested = false;
    this.rpc.off('connected', this.connected); this.rpc.off('disconnected', this.disconnected);
    this.rpc.off('notification', this.notification);
  }
}
