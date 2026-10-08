// Public form validation only. Native code independently validates this request,
// builds the transaction and obtains confirmation before signing or broadcasting.
import { normalizeAmountInput } from '../../src/ui/amount-input.mjs';

export const MAX_EXPECTED_CONNECTIONS = (1n << 256n).toString();
const MAX_MONEY = 100_000_000n * 10_000_000_000n;

export function createP2CRequest({ domain, amount, expectedConnections } = {}) {
  if (typeof domain !== 'string' || domain.length > 1024 || /[^\x00-\x7f]/.test(domain)) throw new Error('Enter a public domain, not a URL. Use ASCII or punycode.');
  domain = domain.trim().toLowerCase();
  const labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 || domain === 'home.arpa' || domain.endsWith('.home.arpa') || !/[a-z]/.test(labels.at(-1)) ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      ['localhost', 'local', 'localdomain', 'internal', 'invalid', 'test', 'onion'].includes(labels.at(-1))) {
    throw new Error('Enter a public domain, not a URL. Use ASCII or punycode.');
  }
  const normalized = normalizeAmountInput(amount);
  if (normalized === null || normalized === '') throw new Error('Enter a positive CONN reward with up to 10 decimal places.');
  amount = normalized.replace(/\.$/, '');
  const [whole, fraction = ''] = amount.split('.');
  const connects = BigInt(whole) * 10_000_000_000n + BigInt(fraction.padEnd(10, '0'));
  if (connects <= 0n || connects > MAX_MONEY) throw new Error('The reward must be greater than zero and at most 100,000,000 CONN.');
  if (typeof expectedConnections !== 'string') throw new Error('Expected connections must be a positive whole number.');
  expectedConnections = expectedConnections.replace(/[.,]$/, '');
  if (/[^0-9]/.test(expectedConnections) || !/^[1-9][0-9]{0,77}$/.test(expectedConnections) || BigInt(expectedConnections) > (1n << 256n)) {
    throw new Error('Expected connections must be a positive whole number no greater than 2^256.');
  }
  return { domain, amount, expectedConnections };
}
