const STEPS = new Set([
  'electron-launch', 'first-window', 'welcome-heading', 'window-title',
  'application-name', 'brand-label', 'brand-image',
]);
const PAGE_EVENTS = {
  domcontentloaded: 'domContentLoadedCount', load: 'loadCount',
  pageerror: 'pageErrorCount', requestfailed: 'failedRequestCount',
  crash: 'crashCount', close: 'closeCount',
};

// Test-only startup observations: fixed labels, durations and event counts.
// Never read event payloads, page contents, URLs, console output or exceptions.
// Failure reporting makes no IPC calls, so a stuck renderer/main process cannot
// delay the original failure or turn a diagnostics timeout into its cause.
export function createUiStartupDiagnostics({ log = console.log, now = () => performance.now() } = {}) {
  const counts = { pageObserved: 0, ...Object.fromEntries(Object.values(PAGE_EVENTS).map(key => [key, 0])) };
  let observedPage;
  const listeners = [];
  function report(step, status, started) {
    try {
      const durationMs = Math.max(0, Math.round(now() - started));
      log(`UI startup: ${JSON.stringify({ step, status, durationMs,
        ...(status === 'failed' ? counts : {}) })}`);
    } catch { /* Diagnostics must preserve the operation's result or failure. */ }
  }
  return {
    async run(step, operation) {
      if (!STEPS.has(step)) throw new TypeError('Unknown UI startup step.');
      const started = now();
      report(step, 'started', started);
      try {
        const result = await operation();
        report(step, 'completed', started);
        return result;
      } catch (error) {
        report(step, 'failed', started);
        throw error;
      }
    },
    observePage(page) {
      if (observedPage) throw new Error('UI startup page is already observed.');
      observedPage = page;
      counts.pageObserved = 1;
      // Counts begin at attachment; zero does not prove an earlier event never
      // happened. These are supporting observations, not readiness assertions.
      for (const [event, key] of Object.entries(PAGE_EVENTS)) {
        const listener = () => { counts[key] = Math.min(Number.MAX_SAFE_INTEGER, counts[key] + 1); };
        page.on(event, listener);
        listeners.push([event, listener]);
      }
    },
    dispose() {
      for (const [event, listener] of listeners) observedPage.off(event, listener);
      listeners.length = 0;
    },
  };
}
