const integer = (value, min, max) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;

function hostname(value) {
  if (typeof value !== 'string') return false;
  const host = value.trim();
  if (!host || host.length > 253 || host.includes('%')) return false;
  if (host.includes(':')) {
    try { return new URL(`http://[${host}]/`).hostname.startsWith('['); } catch { return false; }
  }
  if (/^(?:\d+\.){3}\d+$/.test(host)) return host.split('.').every(part => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 255);
  return /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(host);
}

// Only these preferences may leave the renderer. Payment and secret form
// drafts are deliberately outside this allowlist. Invalid edits remain drafts.
export function preferenceBatch(config, draft, { rpcReady = false } = {}) {
  const patch = {}, entries = [];
  const take = (section, key, value, saved, group) => {
    entries.push({ section, key, raw: draft[section][key] });
    if (value === saved) return;
    if (group) (patch[group] ??= {})[key] = value;
    else patch[key] = value;
  };
  for (const [key, max] of [['maxConnectionsPerSecond', 256], ['maxConcurrent', 256], ['lookbackBlocks', 600]]) {
    if (integer(draft.claims[key], 1, max)) take('claims', key, Number(draft.claims[key]), config.claims?.[key], 'claims');
  }
  for (const [key, min, max] of [['autoLockMinutes', 1, 60], ['feeRate', 1201, 100000]]) {
    if (integer(draft.settings[key], min, max)) take('settings', key, Number(draft.settings[key]), config[key]);
  }
  if (rpcReady && ['host', 'port'].some(key => Object.hasOwn(draft.settings, key))) {
    const host = draft.settings.host ?? config.rpc.host;
    const port = draft.settings.port ?? config.rpc.port;
    if (hostname(host) && integer(port, 1, 65535)) {
      const endpoint = { host: host.trim().toLowerCase(), port: Number(port) };
      if (endpoint.host !== config.rpc.host || endpoint.port !== config.rpc.port) patch.rpc = endpoint;
      for (const key of ['host', 'port']) if (Object.hasOwn(draft.settings, key)) entries.push({ section: 'settings', key, raw: draft.settings[key] });
    }
  }
  return { patch, entries };
}

export function acknowledgePreferences(draft, { entries }) {
  for (const { section, key, raw } of entries) if (draft[section][key] === raw) delete draft[section][key];
}

// One write at a time; a newer draft is read after the previous write settles.
// Retry only the IPC guard's explicit no-action-taken response, never a write
// or network error whose outcome may be uncertain.
export function createPreferenceSaver({ snapshot, save, saved, failed, blocked = () => false, delay = 600, retryDelay = 120 }) {
  let timer = null, saving = null;
  const schedule = (milliseconds = delay) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (blocked()) { schedule(); return; }
      void flush().catch(failed);
    }, milliseconds);
  };
  const flush = async () => {
    clearTimeout(timer); timer = null;
    if (saving) { await saving; return flush(); }
    const batch = snapshot();
    if (!batch.entries.length) return;
    const operation = (async () => {
      let result;
      if (Object.keys(batch.patch).length) {
        try { result = await save(batch.patch); }
        catch (error) {
          if (error?.message !== 'Another wallet action is in progress. Please wait.') throw error;
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          // The user may have replaced a valid value with an invalid draft
          // while IPC was busy. Re-read it before any write is attempted.
          return;
        }
      }
      saved(result, batch);
    })();
    saving = operation;
    try { await operation; } finally { if (saving === operation) saving = null; }
    return flush();
  };
  return { schedule, flush, hasPending: () => Boolean(saving || snapshot().entries.length) };
}
