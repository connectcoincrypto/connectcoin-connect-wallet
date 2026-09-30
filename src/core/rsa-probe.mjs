import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { getClaimsHelper, validateClaimContext } from './claims.mjs';
import { normalizeDomain } from './transaction.mjs';

const MAX_PROCESSES = 4;
const MAX_INPUT_BYTES = 1024;
const MAX_OUTPUT_BYTES = 2048;
const MAX_STDERR_BYTES = 8192;
const activeProcesses = new Set();
const RESPONSE_KEYS = ['type', 'domain', 'rootVersion', 'validationTime', 'verified'];
const ENVIRONMENT_NAMES = new Set(['path', 'systemroot', 'systemdrive', 'windir', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'localappdata', 'appdata', 'user', 'username', 'lang', 'lc_all', 'tz']);

function aborted() {
  const error = new Error('RSA capability probe cancelled');
  error.name = 'AbortError';
  return error;
}

function requestContext({ domain, rootVersion = 1, validationTime } = {}) {
  const context = validateClaimContext({
    domain: normalizeDomain(domain), txid: '00'.repeat(32), input_index: 0,
    connection_work_target: '00'.repeat(32), root_certificates_version: rootVersion,
    signature_algorithms_mask: 1, validation_time: validationTime,
  });
  return Object.freeze({ domain: context.domain, rootVersion, validationTime });
}

function verifiedResponse(output, request) {
  // Decode only after collecting the complete, bounded frame; UTF-8 characters
  // may be split across chunks. No extra line, whitespace or frame is accepted.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output);
  if (!/^\{[^\r\n]*\}\r?\n$/.test(text)) return false;
  const message = JSON.parse(text);
  if (!message || Array.isArray(message) || Object.keys(message).length !== RESPONSE_KEYS.length || RESPONSE_KEYS.some(key => !Object.hasOwn(message, key))) return false;
  // This protocol is a flat object. Count key tokens too, so duplicate keys
  // cannot turn an earlier negative result into a later positive result.
  if ([...text.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)].length !== RESPONSE_KEYS.length) return false;
  return message.type === 'rsa-probe' && message.domain === request.domain &&
    message.rootVersion === request.rootVersion && message.validationTime === request.validationTime && message.verified === true;
}

/** A bounded, advisory TLS probe. Only the public request crosses this boundary. */
export function createRsaProbe({ resourcesPath, helper, basePath, spawnProcess = spawn, deadlineMs = 3000, now = () => performance.now() } = {}) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 3000) throw new Error('Invalid RSA probe deadline');
  return async function probe(input, { signal } = {}) {
    const started = now();
    if (signal?.aborted) throw aborted();
    const request = requestContext(input);
    const inputFrame = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(inputFrame) > MAX_INPUT_BYTES) throw new Error('RSA probe request limit exceeded');
    const runtime = helper === undefined ? getClaimsHelper({ basePath, resourcesPath }) : helper;
    if (signal?.aborted) throw aborted();
    if (now() - started >= deadlineMs) return { verified: false, status: 'timeout' };
    if (!runtime) return { verified: false, status: 'unavailable' };
    if (activeProcesses.size >= MAX_PROCESSES) return { verified: false, status: 'busy' };
    const token = Symbol('rsa-probe');
    activeProcesses.add(token);

    return new Promise((accept, reject) => {
      let child;
      let timer;
      let settled = false;
      let exited = false;
      let spawned = false;
      let exitCode;
      let outputBytes = 0;
      let stderrBytes = 0;
      const chunks = [];
      const release = () => activeProcesses.delete(token);
      const finish = (status, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else accept({ verified: status === 'verified', status });
      };
      const kill = () => {
        // A failed or delayed kill must not extend the caller's deadline. Keep
        // its concurrency token until an actual exit/close, even after return.
        try { if (child && !exited && !child.killed) child.kill('SIGKILL'); } catch { /* Retain the token while the process may still be alive. */ }
      };
      const stop = (status, error) => { finish(status, error); kill(); };
      const onAbort = () => stop(undefined, aborted());
      const expired = () => now() - started >= deadlineMs;
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => stop('timeout'), Math.max(0, deadlineMs - (now() - started)));

      try {
        if (signal?.aborted) { onAbort(); release(); return; }
        const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => ENVIRONMENT_NAMES.has(key.toLowerCase())));
        // A stale helper rejects the required-policy suffix before any DNS/TLS.
        // Keep one process and the existing end-to-end deadline; no fallback.
        child = spawnProcess(runtime.command, [...(runtime.args ?? []), '--probe-rsa', '--require-rsa-exponent-64'], {
          shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...environment, PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1' },
        });
        child.once('spawn', () => { spawned = true; });
        child.once('exit', code => { exitCode = code; exited = true; release(); });
        child.once('error', error => {
          // Node reports failed spawn without a PID or an exit event. There is
          // then no live process consuming a slot; later errors retain it.
          if (!spawned && !child.pid) { exited = true; release(); }
          stop(error?.code === 'ENOENT' ? 'unavailable' : 'failed');
        });
        child.stdout.on('data', chunk => {
          if (settled) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          outputBytes += bytes.length;
          if (outputBytes > MAX_OUTPUT_BYTES) { stop('failed'); return; }
          chunks.push(bytes);
        });
        child.stderr.on('data', chunk => {
          if (settled) return;
          stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
          if (stderrBytes > MAX_STDERR_BYTES) stop('failed');
        });
        child.stdin.on('error', () => stop('failed'));
        child.stdout.on('error', () => stop('failed'));
        child.stderr.on('error', () => stop('failed'));
        child.once('close', (code, terminationSignal) => {
          exited = true;
          release();
          if (settled) return;
          if (signal?.aborted) { onAbort(); return; }
          if (expired()) { finish('timeout'); return; }
          if (code !== 0 || terminationSignal || (exitCode !== undefined && exitCode !== 0)) { finish('failed'); return; }
          try { finish(verifiedResponse(Buffer.concat(chunks, outputBytes), request) ? 'verified' : 'failed'); }
          catch { finish('failed'); }
        });
        // Account for synchronous startup work before sending anything, and
        // honor an abort that arrived while spawnProcess was returning.
        if (settled) { kill(); return; }
        if (signal?.aborted) { onAbort(); return; }
        if (expired()) { stop('timeout'); return; }
        child.stdin.end(inputFrame);
      } catch (error) {
        if (!child) release();
        stop(error?.code === 'ENOENT' ? 'unavailable' : 'failed');
      }
    });
  };
}
