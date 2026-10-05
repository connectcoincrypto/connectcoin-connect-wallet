// Secret-bearing module. Import only in Electron main, trusted Node signing workers or tests.
import { randomBytes, createHash } from 'node:crypto';
import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic as validateBip39 } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HARDENED_OFFSET, HDKey } from '@scure/bip32';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';

export const NETWORKS = Object.freeze({ main: Object.freeze({ hrp: 'cc', coin: 0 }), testnet4: Object.freeze({ hrp: 'tcc', coin: 1 }), regtest: Object.freeze({ hrp: 'ccrt', coin: 1 }) });
export const WORD_COUNTS = Object.freeze([12, 18, 24]);
// Normal BIP32 children; the following index would enter the hardened range.
export const MAX_ADDRESS_INDEX = 0x7fffffff;
export function networkParameters(network = 'testnet4') {
  const parameters = Object.hasOwn(NETWORKS, network) ? NETWORKS[network] : undefined;
  if (!parameters) throw new Error('Unsupported ConnectCoin network');
  return parameters;
}
export function normalizeMnemonic(value) {
  if (typeof value !== 'string' || value.length > 1024) throw new Error('Invalid recovery phrase');
  return value.normalize('NFKD').trim().toLowerCase().split(/\s+/u).join(' ');
}
export function validateMnemonic(value) {
  try {
    const phrase = normalizeMnemonic(value);
    return WORD_COUNTS.includes(phrase.split(' ').length) && validateBip39(phrase, wordlist);
  } catch { return false; }
}
export function generateMnemonic(words = 24) {
  if (!WORD_COUNTS.includes(words)) throw new Error('Choose 12, 18 or 24 recovery words');
  // Node/OpenSSL obtains cryptographic entropy from the operating system.
  // No clocks, Math.random, user-selected words, or fallback RNG are used.
  const entropy = randomBytes(words / 3 * 4);
  try { return entropyToMnemonic(entropy, wordlist); }
  finally { entropy.fill(0); }
}
export function sha256(value) { return createHash('sha256').update(value).digest(); }
export function hash256(value) { return sha256(sha256(value)); }
export function taggedHash(tag, value) {
  const prefix = sha256(Buffer.from(tag, 'utf8'));
  return sha256(Buffer.concat([prefix, prefix, Buffer.from(value)]));
}
export function publicKeyFromPrivate(privateKey) { return Buffer.from(schnorr.getPublicKey(privateKey)); }
export function validatePublicKey(publicKey) {
  const key = typeof publicKey === 'string' && /^[a-fA-F0-9]{64}$/.test(publicKey) ? Buffer.from(publicKey, 'hex') : publicKey;
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error('Expected a 32-byte x-only public key');
  // An x coordinate must actually lift to a secp256k1 curve point.
  secp256k1.Point.fromBytes(Buffer.concat([Buffer.from([2]), key]));
  return Buffer.from(key);
}
export function encodeAddress(publicKey, network = 'testnet4') {
  const key = validatePublicKey(publicKey);
  return bech32m.encode(networkParameters(network).hrp, [1, ...bech32m.toWords(key)]);
}
export function decodeAddress(address, network = 'testnet4') {
  if (typeof address !== 'string' || address.length > 90) throw new Error('Invalid ConnectCoin address');
  const decoded = bech32m.decode(address, 90);
  if (decoded.prefix !== networkParameters(network).hrp || decoded.words[0] !== 1) throw new Error('Address belongs to a different network or is not native P2PK');
  return validatePublicKey(bech32m.fromWords(decoded.words.slice(1)));
}
/** BIP32/BIP44-shaped path, not Bitcoin Taproot/BIP86: no key tweak is applied.
 * Coin 1 is shared by test networks. Coin 0 on main is provisional and is NOT
 * a registered ConnectCoin SLIP44 identifier. Always retain the path/network
 * with backups; importing the words alone into another wallet is insufficient.
 */
export function deriveAccount(mnemonic, { network = 'testnet4', index = 0, change = 0, passphrase = '' } = {}) {
  const phrase = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(phrase)) throw new Error('Recovery phrase has an invalid word count or checksum');
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_ADDRESS_INDEX || ![0, 1].includes(change)) throw new Error('Invalid derivation index');
  if (typeof passphrase !== 'string' || passphrase.length > 1024) throw new Error('Invalid BIP39 passphrase');
  const path = `m/44'/${networkParameters(network).coin}'/0'/${change}/${index}`;
  const seed = mnemonicToSeedSync(phrase, passphrase);
  let root;
  let child;
  try {
    root = HDKey.fromMasterSeed(seed);
    child = root.derive(path);
    const privateKey = Buffer.from(child.privateKey);
    const publicKey = publicKeyFromPrivate(privateKey).toString('hex');
    return { privateKey, publicKey, address: encodeAddress(publicKey, network), path, network, index, change };
  } finally {
    seed.fill(0);
    root?.wipePrivateData();
    child?.wipePrivateData();
  }
}
// Keep the returned closures outside the secret-bearing constructor scope.
// These branches contain compressed public points (including their parity),
// public chain codes and metadata only; they cannot derive hardened children.
function publicAccountDeriver(network, coin, branches) {
  return Object.freeze({
    derive(index, change) {
      if (!branches) throw new Error('Public account deriver has been destroyed');
      if (!Number.isSafeInteger(index) || index < 0 || index > MAX_ADDRESS_INDEX || ![0, 1].includes(change)) throw new Error('Invalid derivation index');
      const child = branches[change].deriveChild(index);
      // Strip parity only after BIP32 derivation, for the final native x-only
      // key. This is the same untweaked point used by deriveAccount/signing.
      const publicKey = Buffer.from(child.publicKey.subarray(1)).toString('hex');
      return { publicKey, address: encodeAddress(publicKey, network),
        path: `m/44'/${coin}'/0'/${change}/${index}`, network, index, change };
    },
    destroy() { branches = null; },
  });
}
/** Derive many public addresses without repeating BIP39 or the hardened path.
 * Private nodes and the seed are wiped before this public-only handle returns.
 * No extended key, mnemonic, seed or private node is exposed or retained by it.
 */
export function createPublicAccountDeriver(mnemonic, { network = 'testnet4', passphrase = '' } = {}) {
  if (typeof network !== 'string') throw new Error('Unsupported ConnectCoin network');
  const { coin } = networkParameters(network);
  const phrase = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(phrase)) throw new Error('Recovery phrase has an invalid word count or checksum');
  if (typeof passphrase !== 'string' || passphrase.length > 1024) throw new Error('Invalid BIP39 passphrase');
  const seed = mnemonicToSeedSync(phrase, passphrase), privateNodes = [];
  let branches;
  try {
    let node = HDKey.fromMasterSeed(seed); privateNodes.push(node);
    // Derive one level at a time so every reachable private intermediate can
    // be explicitly wiped, including when construction fails partway through.
    for (const index of [44, coin, 0]) {
      node = node.deriveChild(HARDENED_OFFSET + index); privateNodes.push(node);
    }
    node.wipePrivateData();
    branches = [node.deriveChild(0), node.deriveChild(1)];
  } finally {
    seed.fill(0);
    for (const node of privateNodes) node.wipePrivateData();
  }
  return publicAccountDeriver(network, coin, branches);
}
export function signSchnorr(hash, privateKey) {
  if (!(hash instanceof Uint8Array) || hash.length !== 32) throw new Error('Expected 32-byte signature digest');
  const auxiliary = randomBytes(32);
  try { return Buffer.from(schnorr.sign(hash, privateKey, auxiliary)); }
  finally { auxiliary.fill(0); }
}
export function verifySchnorr(signature, hash, publicKey) {
  return schnorr.verify(signature, hash, validatePublicKey(publicKey));
}
