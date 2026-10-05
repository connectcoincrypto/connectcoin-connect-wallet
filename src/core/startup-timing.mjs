import { performance } from 'node:perf_hooks';

const validEpoch = epoch => Number.isSafeInteger(epoch) && epoch >= 0;

/** Local timing only: retain no password, wallet data, addresses or transactions. */
export class StartupTiming {
  constructor({ record, now = () => performance.now() } = {}) {
    if (typeof record !== 'function' || typeof now !== 'function') throw new TypeError('Startup timing callbacks are required.');
    this.record = record; this.now = now;
    this.nextRunId = 0; this.active = null;
  }
  time() {
    try { const value = this.now(); return Number.isFinite(value) ? value : null; }
    catch { return null; }
  }
  log(event, stage, run, at) {
    const details = { stage, runId: run.runId,
      ...(at === undefined ? {} : { durationMs: Math.max(0, at - run.started), durationScope: 'run' }) };
    // Diagnostics must never control unlock, refresh or renderer behavior.
    try { Promise.resolve(this.record(event, details)).catch(() => {}); } catch {}
  }
  begin() {
    this.cancel();
    const started = this.time();
    if (started === null || this.nextRunId >= Number.MAX_SAFE_INTEGER) return null;
    const run = { runId: ++this.nextRunId, started, epoch: null, ready: false };
    this.active = run;
    this.log('wallet.unlock_started', 'lifecycle', run);
    return run.runId;
  }
  observe({ epoch, unlocked, ready } = {}) {
    const run = this.active;
    if (!run || !validEpoch(epoch) || typeof unlocked !== 'boolean' || typeof ready !== 'boolean') return;
    if (run.epoch !== null) {
      if (epoch < run.epoch) return; // Delayed state from a previous security context.
      if (epoch > run.epoch) { this.cancel(); return; }
    }
    if (!unlocked) {
      // Network state may still report locked while asynchronous vault decryption
      // is running. Explicit lock/failure paths cancel unbound attempts instead.
      if (run.epoch !== null) this.cancel();
      return;
    }
    const at = this.time();
    if (at === null) { this.cancel(); return; }
    if (run.epoch === null) {
      run.epoch = epoch;
      this.log('wallet.unlocked', 'lifecycle', run, at);
    }
    if (ready && !run.ready) {
      run.ready = true;
      this.log('wallet.snapshot_ready', 'refresh', run, at);
    }
  }
  rendered(epoch) {
    const run = this.active;
    if (!run || !validEpoch(epoch) || run.epoch !== epoch || !run.ready) return;
    const at = this.time();
    this.active = null;
    if (at !== null) this.log('wallet.render_ready', 'lifecycle', run, at);
  }
  cancel() { this.active = null; }
}
