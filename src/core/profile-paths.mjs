import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export const PROFILE_NAME = 'ConnectWallet-mainnet';
export const VAULT_NAME = 'wallet.connectwallet.json';
const PROFILES = Object.freeze({ main: PROFILE_NAME, testnet4: 'ConnectWallet', regtest: 'ConnectWallet-regtest' });

export function selectStartupNetwork({ isPackaged = false, requestedNetwork } = {}) {
  if (isPackaged || requestedNetwork === undefined) return 'main';
  if (!Object.hasOwn(PROFILES, requestedNetwork)) throw new Error('Unsupported ConnectCoin startup network.');
  return requestedNetwork;
}

function inspect(path, kind) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`The wallet ${kind} is not a regular ${kind}. No wallet files were changed.`);
    }
    return true;
  } catch (error) {
    // Permission and I/O errors are NOT evidence that an existing wallet is absent.
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
/** Inspect only the selected network profile, without discovery or migration. */
export function selectProfileDirectory(appData, network = 'main') {
  if (!Object.hasOwn(PROFILES, network)) throw new Error('Unsupported ConnectCoin profile network.');
  const directory = join(appData, PROFILES[network]);
  selectVaultFile(directory);
  return directory;
}

export function selectVaultFile(directory) {
  const file = join(directory, VAULT_NAME);
  if (inspect(directory, 'directory')) inspect(file, 'file');
  return file;
}
