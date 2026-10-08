// QR scans and external links supply untrusted public payment drafts only.
// Neither intake signs a payment nor follows a URL; native review remains
// responsible for independently checking the recipient, amount and fees.
import { parseClipboardPaymentText } from '../../src/core/payment-uri.mjs';
import { parseMainnetAddress } from './model.mjs';

export function parsePaymentIntake(text, { source = 'qr' } = {}) {
  if (source !== 'qr' && source !== 'external') throw new Error('Unsupported payment intake source.');
  // The shared parser enforces the 1,024-character bound before trimming,
  // strict URI structure, exact decimal amounts and metadata limits. Keep
  // its harmless optional-parameter compatibility without copying those
  // parameters into the draft or treating them as remote instructions.
  const parsed = parseClipboardPaymentText(text);
  if (source === 'external' && parsed.kind !== 'uri') throw new Error('Open a connectcoin: payment link.');
  return {
    address: parseMainnetAddress(parsed.address),
    amount: parsed.amount,
    label: parsed.label,
    message: parsed.message,
  };
}
