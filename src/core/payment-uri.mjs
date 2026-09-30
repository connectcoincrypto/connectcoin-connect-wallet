// Shared by the renderer and main process; keep this module free of secrets,
// Node APIs and dependencies. Receive addresses come from the unlocked wallet.
export const PAYMENT_LABEL_MAX_LENGTH = 100;
export const PAYMENT_MESSAGE_MAX_LENGTH = 200;
export const PAYMENT_URI_MAX_LENGTH = 1024;

const COIN = 10000000000n;
const MAX_MONEY = 100000000n * COIN;
const ADDRESS = /^(?:cc|tcc|ccrt)1p[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/;

function paymentAmount(value) {
  if (typeof value !== 'string') throw new Error('Enter a CONN amount using a decimal point and at most 10 decimal places.');
  value = value.trim();
  if (!value) return '';
  if (!/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,10})?$/.test(value)) throw new Error('Enter a CONN amount using a decimal point and at most 10 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * COIN + BigInt(fraction.padEnd(10, '0'));
  if (amount <= 0n || amount > MAX_MONEY) throw new Error('The requested amount must be greater than 0 and no more than 100000000 CONN.');
  const decimal = (amount % COIN).toString().padStart(10, '0').replace(/0+$/, '');
  return `${amount / COIN}${decimal ? `.${decimal}` : ''}`;
}

function paymentText(value, name, limit, multiline = false) {
  if (typeof value !== 'string') throw new Error(`${name} must be text.`);
  value = value.trim();
  if (multiline) value = value.replace(/\r\n?/g, '\n');
  if ([...value].length > limit) throw new Error(`${name} must be ${limit} characters or fewer.`);
  if (/[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(multiline ? value.replace(/\n/g, '') : value)) throw new Error(`${name} contains an unsupported character.`);
  return value;
}

export function validatePaymentDetails({ label = '', message = '' } = {}) {
  return {
    label: paymentText(label, 'Label', PAYMENT_LABEL_MAX_LENGTH),
    message: paymentText(message, 'Message', PAYMENT_MESSAGE_MAX_LENGTH, true),
  };
}

function decodePaymentComponent(value) {
  try { return decodeURIComponent(value); }
  catch { throw new Error('The payment link contains invalid percent encoding or Unicode.'); }
}

// Core's qt/guiutil.cpp uses QUrlQuery, where '+' is a literal plus, supports
// req- aliases, and formats bech32 addresses in uppercase. Do not use form-style
// URLSearchParams decoding, which would change a recipient's label or message.
export function parsePaymentUri(uri) {
  if (typeof uri !== 'string' || uri.length > PAYMENT_URI_MAX_LENGTH) throw new Error('The payment link must be text of no more than 1024 characters.');
  uri = uri.trim();
  if (!/^connectcoin:/i.test(uri)) throw new Error('Enter a connectcoin: payment link.');
  if (/[\p{Cc}\p{Cs}\s#]/u.test(uri)) throw new Error('The payment link contains an unsupported character or fragment.');
  const body = uri.slice('connectcoin:'.length);
  const queryStart = body.indexOf('?');
  let address = queryStart < 0 ? body : body.slice(0, queryStart);
  // Core tolerates one slash appended by the OS. Authority-style URLs, paths,
  // percent-encoded addresses and mixed-case bech32 remain invalid.
  if (address.endsWith('/')) address = address.slice(0, -1);
  if ((address !== address.toLowerCase() && address !== address.toUpperCase()) || !ADDRESS.test(address.toLowerCase())) throw new Error('The payment link does not contain a supported ConnectCoin address.');
  address = address.toLowerCase();
  const result = { address, amount: '', label: '', message: '', ignoredParameters: [] };
  const seen = new Set();
  const query = queryStart < 0 ? '' : body.slice(queryStart + 1);
  if (queryStart >= 0 && !query) throw new Error('The payment link contains an empty query.');
  for (const field of query ? query.split('&') : []) {
    const separator = field.indexOf('=');
    if (separator <= 0) throw new Error('Every payment link parameter must have a name and value.');
    const name = decodePaymentComponent(field.slice(0, separator));
    const value = decodePaymentComponent(field.slice(separator + 1));
    const required = name.startsWith('req-');
    const key = required ? name.slice(4) : name;
    const textToValidate = key === 'message' ? value.replace(/\r\n?|\n/g, '') : value;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || /[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(textToValidate)) throw new Error('The payment link contains an unsupported parameter or character.');
    if (seen.has(key)) throw new Error('The payment link contains a duplicate parameter.');
    seen.add(key);
    if (key === 'amount') {
      // Empty amount is optional in Core; non-empty amounts are exact positive
      // decimals here, matching the Receive request builder and Send review.
      if (value !== value.trim()) throw new Error('The payment amount must be an exact decimal without surrounding spaces.');
      result.amount = paymentAmount(value);
    } else if (key === 'label') result.label = paymentText(value, 'Label', PAYMENT_LABEL_MAX_LENGTH);
    else if (key === 'message') result.message = paymentText(value, 'Message', PAYMENT_MESSAGE_MAX_LENGTH, true);
    else {
      if (required) throw new Error('The payment link requires a feature this wallet does not support.');
      if (['r', 'pj', 'pjos', 'payjoin', 'payment-protocol', 'network', 'chain', 'fee', 'feerate', 'fee-rate', 'address', 'domain', 'lightning', 'lno', 'lna'].includes(key)) throw new Error('The payment link contains an unsupported payment, fee, or network instruction.');
      result.ignoredParameters.push(key);
    }
  }
  return result;
}

export function buildPaymentUri({ address, amount = '', label = '', message = '' } = {}) {
  // Shape checking prevents URI injection. Address derivation/checksum checking
  // remains in crypto.mjs, which must never be imported by the renderer.
  if (typeof address !== 'string' || !ADDRESS.test(address)) throw new Error('No valid receive address is available.');
  const fields = [
    ['amount', paymentAmount(amount)],
    ['label', paymentText(label, 'Label', PAYMENT_LABEL_MAX_LENGTH)],
    ['message', paymentText(message, 'Message', PAYMENT_MESSAGE_MAX_LENGTH, true)],
  ];
  const query = fields.filter(([, value]) => value !== '').map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const uri = `connectcoin:${address}${query ? `?${query}` : ''}`;
  if (uri.length > PAYMENT_URI_MAX_LENGTH) throw new Error('The payment request is too long for a QR code. Shorten the label or message.');
  return uri;
}
