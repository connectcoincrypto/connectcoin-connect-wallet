/** Coalesce invalidations without losing an event received during an async read.
 * Timers only batch events or retry failed work; success never schedules a poll.
 */
export class EventRefresh {
  constructor({ run, isActive, onError = () => {}, delayMs = 25, retryMs = 1000, maxRetryMs = 30000 }) {
    Object.assign(this, { run, isActive, onError, delayMs, retryMs, maxRetryMs });
    this.dirty = false; this.closed = false; this.running = null; this.timer = null; this.failures = 0;
  }
  request() {
    if (this.closed || !this.isActive()) return;
    this.dirty = true;
    if (!this.running && !this.timer) this.schedule(this.delayMs);
  }
  schedule(delay) {
    if (this.closed || !this.isActive() || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.drain(); }, delay);
    this.timer.unref?.();
  }
  async drain() {
    if (this.closed || !this.isActive() || !this.dirty || this.running) return;
    this.dirty = false;
    let delay = this.delayMs;
    const operation = Promise.resolve().then(() => {
      if (!this.closed && this.isActive()) return this.run();
    });
    this.running = operation;
    try { await operation; this.failures = 0; }
    catch (error) {
      if (!this.closed && this.isActive() && error?.name !== 'AbortError') {
        this.dirty = true;
        delay = Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(this.failures++, 10));
        try { this.onError(error); } catch { /* Diagnostics cannot control recovery. */ }
      }
    } finally {
      if (this.running === operation) this.running = null;
      if (this.dirty) this.schedule(delay);
    }
  }
  close() { this.closed = true; this.dirty = false; clearTimeout(this.timer); this.timer = null; }
}
