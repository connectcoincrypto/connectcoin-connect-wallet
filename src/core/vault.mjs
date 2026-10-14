// Password encryption is separate from the optional BIP39 seed passphrase.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync } from 'node:fs';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { networkParameters, normalizeMnemonic, validateMnemonic } from './crypto.mjs';

const derive = promisify(scrypt);
const KDF = Object.freeze({ name: 'scrypt', N: 131072, r: 8, p: 1, keyLength: 32 });
const LIMIT = 131072;
// Exclusive ConnectWallet format: no alternate identifiers or migration.
const FORMAT = 'connectcoin-connect-wallet';
const VERSION = 1;

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 1024) throw new Error('Use a wallet password of at least 12 characters (maximum 1,024 bytes)');
  return password;
}
function validatePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validateMnemonic(value.mnemonic)) throw new Error('Invalid wallet recovery phrase');
  networkParameters(value.network);
  if (value.passphrase !== undefined && (typeof value.passphrase !== 'string' || value.passphrase.length > 1024)) throw new Error('Invalid BIP39 passphrase');
  return { ...value, mnemonic: normalizeMnemonic(value.mnemonic), network: value.network ?? 'testnet4' };
}
function header(envelope) {
  return Buffer.from(JSON.stringify({ format: envelope.format, version: envelope.version, kdf: envelope.kdf, cipher: envelope.cipher, salt: envelope.salt, nonce: envelope.nonce }), 'utf8');
}
function strictHex(value, bytes) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/.test(value)) throw new Error('Invalid encrypted wallet format');
  return Buffer.from(value, 'hex');
}
function validateEnvelope(value) {
  if (!value || value.format !== FORMAT || value.version !== VERSION || value.cipher !== 'aes-256-gcm' || JSON.stringify(value.kdf) !== JSON.stringify(KDF)) throw new Error('Unsupported encrypted wallet format or KDF parameters');
  strictHex(value.salt, 32);
  strictHex(value.nonce, 12);
  strictHex(value.tag, 16);
  if (typeof value.ciphertext !== 'string' || value.ciphertext.length < 2 || value.ciphertext.length > LIMIT || value.ciphertext.length % 2 || !/^[0-9a-f]+$/.test(value.ciphertext)) throw new Error('Invalid encrypted wallet ciphertext');
  return value;
}
async function keyFor(password, salt) {
  validatePassword(password);
  return derive(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 192 * 1024 * 1024 });
}
export async function encryptVault(payload, password) {
  validatePassword(password);
  const plaintext = Buffer.from(JSON.stringify(validatePayload(payload)), 'utf8');
  if (plaintext.length > LIMIT / 2) { plaintext.fill(0); throw new Error('Wallet data is too large'); }
  const salt = randomBytes(32);
  const nonce = randomBytes(12);
  const envelope = { format: FORMAT, version: VERSION, kdf: { ...KDF }, cipher: 'aes-256-gcm', salt: salt.toString('hex'), nonce: nonce.toString('hex') };
  let key;
  try {
    key = await keyFor(password, salt);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(header(envelope));
    envelope.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('hex');
    envelope.tag = cipher.getAuthTag().toString('hex');
    return envelope;
  } finally { plaintext.fill(0); key?.fill(0); }
}
export async function decryptVault(envelope, password) {
  validateEnvelope(envelope);
  let key;
  let plaintext;
  try {
    key = await keyFor(password, Buffer.from(envelope.salt, 'hex'));
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'hex'));
    cipher.setAAD(header(envelope));
    cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
    plaintext = Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'hex')), cipher.final()]);
    return validatePayload(JSON.parse(plaintext.toString('utf8')));
  } catch { throw new Error('Cannot unlock wallet: incorrect password or damaged wallet file'); }
  finally { key?.fill(0); plaintext?.fill(0); }
}
async function safeFile(file, mustExist = false) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT + 4096) throw new Error('Unsafe or oversized wallet file');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' && !mustExist) return false;
    throw error;
  }
}
async function persist(file, envelope, replace, check = () => {}) {
  const destination = path.resolve(file);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Wallet directory must not be a symbolic link');
  if (await safeFile(destination)) {
    if (!replace) throw new Error('A wallet already exists at this location');
  } else if (replace) throw new Error('Wallet to update does not exist');
  const temporary = path.join(directory, `.wallet-${randomBytes(16).toString('hex')}.tmp`);
  let handle, published = false;
  try {
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(envelope)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      check();
      // Initial publication and authorization share one JS turn. linkSync is
      // exclusive: it cannot overwrite a wallet that appeared during encryption.
      if (replace) await rename(temporary, destination);
      else linkSync(temporary, destination);
      published = true;
      if (!replace) await unlink(temporary);
      await chmod(destination, 0o600);
      if (process.platform !== 'win32') {
        const directoryHandle = await open(directory, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      }
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  } catch (error) {
    if (!published) throw error;
    // Include cleanup failures: the installed wallet must remain accessible even
    // if a later permission update, temporary-file removal or flush fails.
    throw Object.assign(new Error('The encrypted wallet was installed, but storage could not confirm a complete save. Keep your recovery phrase safe and verify access with the password used for this save.', { cause: error }), { walletPublished: true });
  }
}
export async function createVault(file, payload, password, { check = () => {} } = {}) {
  await persist(file, await encryptVault(payload, password), false, check);
}
function fingerprint(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export async function vaultFingerprint(file) {
  await safeFile(file, true);
  const bytes = await readFile(file);
  if (bytes.length > LIMIT + 4096) throw new Error('Wallet file is too large');
  return fingerprint(bytes);
}
// Replacement is deliberately independent of the forgotten password. Preserve
// the EXACT old ciphertext before publishing a fully encrypted new wallet.
export async function replaceVault(file, payload, password, { expectedFingerprint, check = () => {} } = {}) {
  if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error('Wallet replacement authorization is invalid.');
  const envelope = await encryptVault(payload, password);
  check();
  const destination = path.resolve(file), directory = path.dirname(destination);
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Wallet directory must not be a symbolic link');
  await safeFile(destination, true);
  const original = await readFile(destination);
  if (original.length > LIMIT + 4096 || fingerprint(original) !== expectedFingerprint) throw new Error('The wallet file changed. Start recovery or replacement again.');
  const backups = path.join(directory, 'wallet-backups');
  await mkdir(backups, { recursive: true, mode: 0o700 });
  const backupInfo = await lstat(backups);
  if (!backupInfo.isDirectory() || backupInfo.isSymbolicLink()) throw new Error('Wallet backup directory must not be a symbolic link');
  check();
  const suffix = randomBytes(16).toString('hex');
  const backupFile = path.join(backups, `wallet-${new Date().toISOString().replace(/[:.]/g, '-')}-${suffix}.connectwallet.json`);
  const temporary = path.join(directory, `.wallet-${suffix}.tmp`);
  let temporaryHandle, backupHandle, backupComplete = false, backupCreated = false, published = false;
  try {
    temporaryHandle = await open(temporary, 'wx', 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(envelope)}\n`, 'utf8');
    await temporaryHandle.sync(); await temporaryHandle.close(); temporaryHandle = undefined;
    check();
    backupHandle = await open(backupFile, 'wx', 0o600); backupCreated = true;
    await backupHandle.writeFile(original); await backupHandle.sync();
    await backupHandle.close(); backupHandle = undefined;
    // Persist the backup directory entry before the active file can be replaced.
    if (process.platform !== 'win32') {
      const handle = await open(backups, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      const parent = await open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
    backupComplete = true;
    // These bounded metadata operations share one JS turn with the final check:
    // a cancel/lock cannot run between authorization and atomic publication.
    const current = lstatSync(destination);
    if (!current.isFile() || current.isSymbolicLink() || current.size > LIMIT + 4096 || fingerprint(readFileSync(destination)) !== expectedFingerprint) throw new Error('The wallet file changed. Start recovery or replacement again.');
    check();
    renameSync(temporary, destination);
    published = true;
    if (process.platform !== 'win32') {
      let handle;
      try { handle = openSync(directory, 'r'); fsyncSync(handle); closeSync(handle); handle = undefined; }
      catch {
        // Publication has already happened: never report this as an aborted
        // replacement or allow the old authorization to be retried blindly.
        throw Object.assign(new Error('The new wallet was installed, but storage could not confirm a durable save. Keep both recovery phrases safe and verify access with the new password. The previous encrypted backup is preserved.'), { walletPublished: true });
      } finally { if (handle !== undefined) { try { closeSync(handle); } catch { /* The publication error above takes priority. */ } } }
    }
    return { backupFile };
  } finally {
    await temporaryHandle?.close().catch(() => {});
    await backupHandle?.close().catch(() => {});
    await unlink(temporary).catch(error => {
      if (error.code === 'ENOENT') return;
      if (!published) throw error;
      // Cleanup can fail after the new encrypted wallet is already installed.
      // Preserve that outcome so the service revokes the old authorization
      // and tells the user which password now opens the active wallet.
      throw Object.assign(new Error('The new wallet was installed, but storage could not complete cleanup. Keep both recovery phrases safe and verify access with the new password. The previous encrypted backup is preserved.', { cause: error }), { walletPublished: true });
    });
    if (backupCreated && !backupComplete) await unlink(backupFile).catch(() => {});
  }
}
export async function unlockVault(file, password) {
  await safeFile(file, true);
  const value = await readFile(file, 'utf8');
  if (Buffer.byteLength(value) > LIMIT + 4096) throw new Error('Wallet file is too large');
  return decryptVault(JSON.parse(value), password);
}
export async function updateVault(file, payload, password) {
  // Prove the existing password before replacement; never overwrite blindly.
  await unlockVault(file, password);
  await persist(file, await encryptVault(payload, password), true);
}
export async function changeVaultPassword(file, currentPassword, newPassword) {
  const payload = await unlockVault(file, currentPassword);
  await persist(file, await encryptVault(payload, newPassword), true);
}
