import { validateTip } from './config.mjs';

const HASH = /^[0-9a-f]{64}$/;

// A compact receipt is only a location assertion from the already trusted
// index. The owner must verify its own saved transaction/proof before this
// call and retain it until the discovery snapshot reaches the confirmation.
export function validateIndexedClaimStatus(result, txid, network, window) {
  const tip = validateTip(result?.tip, network);
  if (typeof result.txid !== 'string' || !HASH.test(result.txid) || result.txid !== txid ||
      !['pending', 'confirmed'].includes(result.status) ||
      !Number.isSafeInteger(result.confirmations) || result.confirmations < 0) {
    throw new Error('Invalid compact claim receipt identity or status.');
  }
  if (result.status === 'pending') {
    if (result.confirmations !== 0 || result.block_hash !== undefined || result.block_height !== undefined) {
      throw new Error('Unconfirmed claim receipt has confirmation metadata.');
    }
    return;
  }
  if (!Number.isSafeInteger(result.block_height) || result.block_height < 0 || result.block_height > tip.height ||
      typeof result.block_hash !== 'string' || !HASH.test(result.block_hash) ||
      result.confirmations !== tip.height - result.block_height + 1 ||
      result.block_height === 0 && result.block_hash !== tip.genesis_hash ||
      result.block_height === tip.height && result.block_hash !== tip.hash) {
    throw new Error('Invalid compact claim confirmation metadata.');
  }
  const known = window?.blocks?.find(block => block.height === result.block_height);
  if (known && known.hash !== result.block_hash) throw new Error('Claim receipt conflicts with the validated chain window.');
}
