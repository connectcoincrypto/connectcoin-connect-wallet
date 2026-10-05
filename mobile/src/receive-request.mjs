// Public request builder only: no keys, signing, transaction or network actions.
import { buildPaymentUri, parsePaymentUri, validatePaymentDetails,
  PAYMENT_LABEL_MAX_LENGTH, PAYMENT_MESSAGE_MAX_LENGTH, PAYMENT_URI_MAX_LENGTH } from '../../src/core/payment-uri.mjs';
import { normalizeAmountInput } from '../../src/ui/amount-input.mjs';
import { numericInputValue } from '../../src/ui/numeric-value.mjs';
import { parseWatchAddress } from './model.mjs';

export const RECEIVE_REQUEST_LIMITS = Object.freeze({
  label: PAYMENT_LABEL_MAX_LENGTH,
  message: PAYMENT_MESSAGE_MAX_LENGTH,
  amountIntegerDigits: 9,
  amountFractionDigits: 10,
});

export const RECEIVE_METADATA_NOTICE = 'The label and message are included in the payment link and QR code, not written to the blockchain. Anyone with the link or QR code can read them.';

function requestFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error('Enter valid payment request details.');
  }
  const allowed = ['address', 'amount', 'label', 'message'];
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => !allowed.includes(key))) throw new Error('The payment request contains an unsupported field.');
  for (const key of keys) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) throw new Error('Enter valid payment request details.');
  }
  return value;
}

function checkedText(value, name, multiline = false) {
  if (typeof value !== 'string') throw new Error(`${name} must be text.`);
  // Bound raw form values before Unicode normalization/iteration. Their actual
  // limits remain 100/200 code points, enforced by the shared payment validator.
  if (value.length > PAYMENT_URI_MAX_LENGTH) throw new Error(`${name} is too long.`);
  const checked = multiline ? value.replace(/\r\n?|\n/g, '') : value;
  // Check BEFORE trim: a pasted control at the edge must not disappear silently.
  if (/[\p{Cc}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(checked) ||
      (!multiline && /[\u2028\u2029]/u.test(checked))) {
    throw new Error(`${name} contains an unsupported character.`);
  }
  return value;
}

export function createReceiveRequest(options = {}) {
  const { address, amount = '', label = '', message = '' } = requestFields(options);
  const canonicalAddress = parseWatchAddress(address);
  if (typeof amount !== 'string' || amount.length > 64) {
    throw new Error('Enter a CONN amount using a decimal point and at most 10 decimal places.');
  }
  // Editing accepts a trailing separator, but canonical URI amounts do not.
  // Never truncate, parseFloat or round an amount to make it fit the request.
  const normalizedAmount = normalizeAmountInput(amount, {
    maxIntegerDigits: RECEIVE_REQUEST_LIMITS.amountIntegerDigits,
    maxFractionDigits: RECEIVE_REQUEST_LIMITS.amountFractionDigits,
  });
  if (normalizedAmount === null) {
    throw new Error('Enter a CONN amount using a decimal point and at most 10 decimal places.');
  }
  const details = validatePaymentDetails({
    label: checkedText(label, 'Label'),
    message: checkedText(message, 'Message', true),
  });
  const uri = buildPaymentUri({ address: canonicalAddress, amount: numericInputValue(normalizedAmount), ...details });
  // Return exactly what a compatible sender will decode, including trimmed text
  // and canonical decimal amounts. URI metadata is public and is not on-chain.
  const parsed = parsePaymentUri(uri);
  return { uri, address: parsed.address, amount: parsed.amount, label: parsed.label, message: parsed.message };
}
