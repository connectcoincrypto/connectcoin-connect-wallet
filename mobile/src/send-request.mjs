// Public form validation only; native code independently checks every field,
// authenticates funding and requires a fresh confirmation before signing.
import { normalizeAmountInput } from '../../src/ui/amount-input.mjs';
import { formatConn, parseMainnetAddress } from './model.mjs';

export function createSendRequest({ address, amount, feeRate, subtractFeeFromAmount, useAllBalance } = {}) {
  if (typeof address !== 'string' || address.includes(':')) throw new Error('Enter a mainnet address, or use Paste payment link.');
  address = parseMainnetAddress(address.trim());
  const normalized = normalizeAmountInput(amount);
  if (normalized === null || normalized === '') throw new Error('Enter a positive CONN amount with up to 10 decimal places.');
  amount = normalized.replace(/\.$/, '');
  const [whole, fraction = ''] = amount.split('.');
  const connects = BigInt(whole) * 10_000_000_000n + BigInt(fraction.padEnd(10, '0'));
  if (connects <= 0n || connects > 1_000_000_000_000_000_000n) throw new Error('The amount must be greater than zero and at most 100,000,000 CONN.');
  const normalizedFee = normalizeAmountInput(feeRate, { maxIntegerDigits: 6, maxFractionDigits: 0 });
  if (normalizedFee === null || normalizedFee === '') throw new Error('Use a whole-number fee rate from 1,201 to 100,000 connects/vB.');
  feeRate = normalizedFee.replace(/\.$/, '');
  if (BigInt(feeRate) < 1201n || BigInt(feeRate) > 100000n) throw new Error('Use a whole-number fee rate from 1,201 to 100,000 connects/vB.');
  if (typeof subtractFeeFromAmount !== 'boolean' || typeof useAllBalance !== 'boolean' || useAllBalance && !subtractFeeFromAmount) {
    throw new Error('Use all balance requires deducting fees from the payment.');
  }
  return { address, amount, feeRate, subtractFeeFromAmount, useAllBalance };
}

// A displayed snapshot is not signing authority. Native review independently
// compares it with current mature, confirmed and unreserved funding outputs.
export function availableSendAmount(state) {
  if (!state?.address || !state.updatedAt || state.stale || state.cached || state.hdComplete === false || state.balance?.address !== state.address ||
      state.partial && (!Array.isArray(state.verifiedAddresses) || !state.verifiedAddresses.length)) return null;
  try {
    const value = state.balance.available_confirmed;
    const formatted = formatConn(value);
    return BigInt(value) > 0n ? formatted : null;
  } catch { return null; }
}
