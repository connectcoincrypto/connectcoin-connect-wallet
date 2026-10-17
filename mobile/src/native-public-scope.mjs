import { parseMainnetAddress } from './model.mjs';
import { nativeHdAccounts } from './hd-session.mjs';

const inactive = () => Object.assign(new Error('Native wallet account required'), { code: 'RPC_INACTIVE' });
const cancelled = () => Object.assign(new Error('Native wallet account changed'), { code: 'RPC_CANCELLED' });

// Only adopted, validated native descriptors authorize public reads. Neither a
// raw getState snapshot nor a caller can obtain/mutate the private address Set.
export class NativePublicScope {
  #scope = null;
  clear() { this.#scope = null; }
  isCurrent(scope) { return scope !== null && this.#scope === scope; }
  adopt(info, endpoint) {
    let key;
    try {
      key = JSON.stringify([info.exists, info.accountScope, info.walletId, info.account,
        info.accounts, info.hd?.complete, info.hd?.recovering]);
      if (this.#scope?.key === key && this.#scope.endpoint === endpoint) return this.#scope;
      // Clear BEFORE validating a new descriptor, including malformed input.
      this.clear();
      const address = info.exists === true && info.account != null ? parseMainnetAddress(info.account.address) : '';
      if (address && address !== info.account.address) throw inactive();
      const accounts = address ? nativeHdAccounts(info) : null;
      const identity = address ? accounts ? info.walletId : address : '';
      const owned = new Set(accounts ? accounts.map(account => account.address) : address ? [address] : []);
      this.#scope = Object.freeze({ key, endpoint, address, identity, hd: accounts !== null, size: owned.size,
        owns: value => owned.has(value) });
      return this.#scope;
    } catch (error) { this.clear(); throw error; }
  }
  authorize(method, params) {
    const scope = this.#scope;
    const requested = method === 'getaddresschanges' ? params?.addresses : [params?.address];
    if (!scope?.address || method !== 'getchaintip' && (!Array.isArray(requested) || !requested.length ||
        requested.some(address => !scope.owns(address)))) throw inactive();
    return scope;
  }
  assertCurrent(scope) { if (!this.isCurrent(scope)) throw cancelled(); }
}

const sameTip = (left, right) => left && right && ['chain', 'genesis_hash', 'hash', 'height', 'mediantime']
  .every(key => left[key] !== undefined && left[key] === right[key]);

// This only decides whether startup needs its artificial retry. Real watch
// hints keep their own dirty/request state, even when this snapshot is complete.
export function hasVerifiedWalletSnapshot(session, scope) {
  const state = session.state;
  if (!scope?.address || state.address !== scope.identity || state.balance?.address !== scope.identity ||
      !Number.isFinite(state.updatedAt) || state.updatedAt <= 0 || state.busy || state.stale || state.cached ||
      state.partial || state.historyStale || state.error || session.confirmationsStale !== false ||
      !sameTip(state.balance.tip, state.tip)) return false;
  if (scope.hd && (state.hdComplete !== true || state.addressCount !== scope.size ||
      !Array.isArray(state.verifiedAddresses) || state.verifiedAddresses.length !== scope.size ||
      new Set(state.verifiedAddresses).size !== scope.size || state.verifiedAddresses.some(address => !scope.owns(address)))) return false;
  return true;
}
