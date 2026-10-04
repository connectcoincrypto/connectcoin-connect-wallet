import { Worker } from 'node:worker_threads';
import { validatePaymentFundingPayload } from './transaction.mjs';

const cancelled = () => Object.assign(new Error('Payment review cancelled.'), { name: 'AbortError' });

// This trusted Node worker performs only local verification/signing. It never
// receives an RPC client and cannot broadcast a payment. Nothing secret is
// returned to the main process or renderer, or saved to a temporary file.
export function buildPaymentInWorker(input, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(cancelled());
  try { validatePaymentFundingPayload(input); }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./payment-worker.mjs', import.meta.url));
    let settled = false;
    const finish = (error, payment) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Termination also stops synchronous crypto immediately on cancel/lock.
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(payment);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(new Error('Payment signing exceeded its time limit. No transaction was sent.')), 30000);
    worker.once('error', () => finish(new Error('Local payment signing failed. No transaction was sent.')));
    worker.once('exit', () => finish(new Error('Local payment signing stopped before completion. No transaction was sent.')));
    worker.once('message', result => {
      if (signal?.aborted) { abort(); return; }
      if (result?.error) finish(new Error(result.error));
      else if (result?.payment) finish(null, result.payment);
      else finish(new Error('Invalid local payment signing response.'));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage(input); }
    catch { finish(new Error('Could not start local payment signing. No transaction was sent.')); }
  });
}
