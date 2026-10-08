import { validateBalance, validateHistory } from './model.mjs';
import { addressSetKey } from './hd-sync.mjs';

export const DISPLAY_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY = 200;
const fields = ['txid', 'status', 'block_height', 'block_hash', 'confirmations', 'received', 'spent', 'balance_delta'];
const plainRow = row => Object.fromEntries(fields.map(key => [key, row[key]]));

// Display-only public data: no keys, RPC cursors, UTXOs or signing authority.
export function readDisplayCache(value, { walletId, accounts, now = Date.now() }) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        new TextEncoder().encode(JSON.stringify(value)).length > DISPLAY_CACHE_MAX_BYTES ||
        value.version !== 1 || value.network !== 'main' || value.walletId !== walletId ||
        value.accountKey !== addressSetKey(accounts.map(account => account.address)) ||
        !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0 || value.updatedAt > now + 60000 ||
        !Array.isArray(value.history) || value.history.length > MAX_HISTORY) return null;
    const balance = validateBalance(value.balance, walletId), allowed = new Set(accounts.map(account => account.address));
    const validated = validateHistory({ address: walletId, tip: balance.tip, unit: 'connects', live: true,
      items: value.history.map(plainRow), next_cursor: null }, walletId);
    const history = validated.items.map((row, i) => {
      const addresses = value.history[i].addresses;
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > accounts.length ||
          new Set(addresses).size !== addresses.length || addresses.some(address => !allowed.has(address))) throw new Error('Invalid display cache');
      return { ...row, addresses: [...addresses] };
    });
    return { balance, history, updatedAt: value.updatedAt };
  } catch { return null; }
}

export function createDisplayCache(state, accounts) {
  if (!state.balance || !state.updatedAt || state.stale || state.cached || state.partial || !state.hdComplete) return null;
  const value = { version: 1, network: 'main', walletId: state.address,
    accountKey: addressSetKey(accounts.map(account => account.address)), updatedAt: state.updatedAt,
    balance: state.balance, history: state.history.slice(0, MAX_HISTORY).map(row => ({ ...plainRow(row), addresses: [...row.addresses] })) };
  return readDisplayCache(value, { walletId: state.address, accounts }) ? value : null;
}
