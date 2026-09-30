import { buildPaymentUri } from '../core/payment-uri.mjs';
import { numericInputValue } from './numeric-value.mjs';

// Keep QR encoding off the renderer and coalesce typing. A late response must
// never pair an old QR with a new address, request, or unlocked wallet session.
export function createReceiveRequestPreview({ generate, onChange, delay = 200 }) {
  let key = null;
  let sequence = 0;
  let timer;
  let current = { address: '', uri: '', qrDataUrl: null, error: '', pending: false };
  const clear = () => {
    clearTimeout(timer); sequence++; key = null;
    current = { address: '', uri: '', qrDataUrl: null, error: '', pending: false };
  };
  return {
    clear,
    get value() { return current; },
    update({ address, securityEpoch, ...draft }) {
      draft.amount = numericInputValue(draft.amount);
      const nextKey = JSON.stringify([securityEpoch, address, draft.amount, draft.label, draft.message]);
      if (nextKey === key) return current;
      clearTimeout(timer); key = nextKey;
      const revision = ++sequence;
      current = { address: address ?? '', uri: '', qrDataUrl: null, error: '', pending: false };
      if (!address) return current;
      try { current.uri = buildPaymentUri({ address, ...draft }); }
      catch (error) { current.error = error.message; return current; }
      current.pending = true;
      const uri = current.uri;
      timer = setTimeout(async () => {
        try {
          const result = await generate(draft);
          if (revision !== sequence) return;
          if (result?.address !== address || result?.uri !== uri ||
              typeof result.qrDataUrl !== 'string' || !/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(result.qrDataUrl)) {
            throw new Error('The payment request changed. Edit a field or reopen Receive to try again.');
          }
          current = { address, uri, qrDataUrl: result.qrDataUrl, error: '', pending: false };
        } catch (error) {
          if (revision !== sequence) return;
          current = { address, uri, qrDataUrl: null, error: error.message || 'Could not generate the payment QR code.', pending: false };
        }
        onChange();
      }, delay);
      return current;
    },
  };
}
