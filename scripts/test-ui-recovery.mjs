// Real Electron recovery/replacement regression. Only a temporary wallet and
// loopback RPC fixture are used; no user wallet, clipboard or real coins.
import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { GENESIS } from '../src/core/config.mjs';
import { deriveAccount } from '../src/core/crypto.mjs';
import { createVault, unlockVault } from '../src/core/vault.mjs';
import { waitForUiCondition } from './ui-wait.mjs';
import { closeElectronTest } from './ui-close.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(path.join(tmpdir(), 'connectwallet-ui-recovery-'));
const screenshots = await mkdtemp(path.join(tmpdir(), 'connectwallet-ui-recovery-screens-'));
const vaultFile = path.join(profile, 'wallet.connectwallet.json');
const backupDirectory = path.join(profile, 'wallet-backups');
// Public BIP39 test vector, never a funded or user-provided recovery phrase.
const mnemonic = `${'abandon '.repeat(11)}about`;
const oldPassword = 'Recovery-test-original-password';
const newPassword = 'Recovery-test-replacement-password';
const createdPassword = 'Recovery-test-new-wallet-password';
const tip = { chain: 'testnet4', height: 0, hash: GENESIS.testnet4, genesis_hash: GENESIS.testnet4, mediantime: 1780000000 };
const requests = [];
const historyAddresses = [];
const sockets = new Set();
const fixture = net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => socket.destroy());
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const { method, id, params = {} } = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      requests.push(method);
      if (method === 'getaddresshistory') historyAddresses.push(params.address);
      let result;
      if (method === 'getchaintip') result = tip;
      else if (['subscribetip', 'subscribebounties', 'subscribeaddress'].includes(method)) result = { subscription_id: `${method}:${params.address ?? ''}`, tip, cursor: 'ui-empty-journal' };
      else if (method === 'unsubscribe') result = { removed: true };
      else if (method === 'getaddressbalance') result = { tip, address: params.address, unit: 'connects', confirmed: '0', available_confirmed: '0', pending_delta: '0', immature: '0' };
      else if (['getaddresshistory', 'getaddressutxos'].includes(method)) result = { tip, address: params.address, unit: 'connects', items: [], next_cursor: null };
      else {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported fixture method' } })}\n`);
        continue;
      }
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    }
  });
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
await writeFile(path.join(profile, 'config.json'), JSON.stringify({ version: 1, network: 'testnet4', rpc: { host: '127.0.0.1', port: fixture.address().port }, autoLockMinutes: 15 }));
const env = { ...process.env, CONNECTWALLET_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
let application;
let page;
let stage = 'launch isolated profile';
let stageStarted = performance.now();
let passed = false;
let createdWords = [];
const errors = [];
const lifecycle = [];

function nextStage(value) {
  // Stage labels are fixed below; never log page text, wallet data or inputs.
  console.log(`Recovery UI stage completed: ${stage} (${Math.round(performance.now() - stageStarted)} ms).`);
  stage = value;
  stageStarted = performance.now();
}

async function launch() {
  application = await electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [root], env, colorScheme: null, timeout: 30000 });
  application.on('close', () => lifecycle.push({ event: 'application.closed', elapsedMs: Math.round(performance.now() - stageStarted) }));
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('close', () => lifecycle.push({ event: 'page.closed', elapsedMs: Math.round(performance.now() - stageStarted) }));
  page.on('crash', () => lifecycle.push({ event: 'page.crashed', elapsedMs: Math.round(performance.now() - stageStarted) }));
  page.on('pageerror', error => errors.push(error.name));
}
async function ready() {
  // Both real 20-address gaps fit in the unchanged 48-per-minute RPC quota.
  // Empty discovery pages must not be fetched twice during this same refresh.
  await waitForUiCondition(page, async () => {
    const state = await window.connectwallet.invoke('getState');
    return state.phase === 'unlocked' && state.network.status === 'online' && !state.busy && !state.wallet.recovering;
  }, null, { timeout: 20000, message: 'The isolated recovery must finish within one history quota window.' });
  await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') !== 'true');
  return page.evaluate(() => window.connectwallet.invoke('getState'));
}
async function lock() {
  await page.evaluate(() => window.connectwallet.invoke('lock'));
  await page.locator('#unlock-password').waitFor();
  assert.equal(await page.locator('.seed-word').count(), 0);
  assert.equal(await page.locator('dialog[open]').count(), 0);
}
async function archives() {
  return (await readdir(backupDirectory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).sort();
}
async function unchanged(bytes, count = 0) {
  assert.deepEqual(await readFile(vaultFile), bytes, 'An unfinished or cancelled replacement must not change the existing vault.');
  assert.equal((await archives()).length, count, 'Archives must be created only when replacement commits.');
}
async function begin(mode, { testAcknowledgement = false } = {}) {
  await page.getByRole('button', { name: mode === 'recover' ? 'Forgot password?' : 'Use another wallet', exact: true }).click();
  await page.locator('dialog[open] #replacement-ack').waitFor();
  const proceed = page.locator('dialog[open] [data-action="begin-replacement"]');
  if (testAcknowledgement) {
    assert.equal(await page.locator('#replacement-ack').isChecked(), false);
    // Implementations may disable Continue or reject it with an inline warning.
    if (await proceed.isEnabled()) await proceed.click();
    assert.equal(await page.locator('dialog[open]').count(), 1);
    assert.equal(await page.locator('#restore-form, #create-form').count(), 0);
    assert.equal((await page.evaluate(() => window.connectwallet.invoke('getState'))).phase, 'locked');
  }
  await page.locator('#replacement-ack').check();
  await proceed.click();
  if (mode === 'recover') await page.locator('#restore-form').waitFor();
  else await page.getByRole('heading', { name: 'Choose your next wallet.', exact: true }).waitFor();
  assert.equal(await page.locator('dialog[open]').count(), 0);
}
async function fillRestore(phrase, password, confirmation = password) {
  await page.locator('#setup-name').fill('Restored isolated wallet');
  await page.locator('#restore-phrase').fill(phrase);
  await page.locator('#setup-password').fill(password);
  await page.locator('#setup-confirm').fill(confirmation);
}
async function waitInlineError() {
  await page.waitForFunction(() => [...document.querySelectorAll('.inline-error')].some(node => !node.classList.contains('hidden') && node.textContent.trim()));
  await page.waitForFunction(() => document.querySelector('#app')?.getAttribute('aria-busy') !== 'true');
}
async function cancelReplacement() {
  const cancel = page.locator('[data-action="cancel-replacement"]');
  if (await cancel.count()) await cancel.click();
  else await page.locator('[data-action="auth-back"]').click();
  await page.locator('#unlock-password').waitFor();
  assert.equal(await page.locator('#restore-form, #create-form, .seed-word').count(), 0);
  assert.equal(await page.locator('#unlock-password').inputValue(), '');
}
async function createReplacement() {
  await begin('switch');
  await page.getByRole('button', { name: 'Create a new wallet', exact: true }).click();
  await page.locator('input[name="wordCount"][value="12"]').check();
  await page.locator('#setup-name').fill('New isolated wallet');
  await page.locator('#setup-password').fill(createdPassword);
  await page.locator('#setup-confirm').fill(createdPassword);
  await page.getByRole('button', { name: 'Create recovery phrase' }).click();
  await page.getByRole('heading', { name: 'These words are your wallet.' }).waitFor();
  createdWords = await page.locator('.seed-word').evaluateAll(nodes => nodes.map(node => node.lastChild.textContent.trim()));
  assert.equal(createdWords.length, 12);
}

try {
  // Bootstrap only the original encrypted fixture directly. Restoring it here
  // repeated the full 60-second RPC quota window before the actual recovery
  // under test below. Keep real unlock, recovery discovery and rate limits.
  await createVault(vaultFile, { name: 'Original isolated wallet', mnemonic, network: 'testnet4', passphrase: '',
    receiveIndex: 0, changeIndex: 0, lastUsedReceive: -1, lastUsedChange: -1, needsRecovery: false }, oldPassword);
  await launch();
  await page.locator('#unlock-password').fill(oldPassword);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  const originalAddress = (await ready()).wallet.address;
  await lock();
  await page.screenshot({ path: path.join(screenshots, 'locked-recovery-options.png') });
  const originalBytes = await readFile(vaultFile);
  assert.equal((await archives()).length, 0);

  nextStage('locked alternatives and cancellable warning');
  for (const label of ['Forgot password?', 'Use another wallet']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.locator('dialog[open] #replacement-ack').waitFor();
    if (label === 'Forgot password?') await page.screenshot({ path: path.join(screenshots, 'recovery-warning.png') });
    await unchanged(originalBytes);
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.locator('#unlock-password').waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await unchanged(originalBytes);
  }

  nextStage('acknowledgement, invalid input and cancellation preserve existing wallet');
  await begin('recover', { testAcknowledgement: true });
  await page.screenshot({ path: path.join(screenshots, 'recovery-empty-form.png'), fullPage: true });
  await unchanged(originalBytes);
  assert.equal(await page.locator('#setup-password').getAttribute('autocomplete'), 'new-password');
  assert.equal(await page.locator('#setup-password').getAttribute('minlength'), '12');
  await fillRestore('abandon '.repeat(12).trim(), newPassword);
  await page.getByRole('button', { name: 'Restore wallet and reset password' }).click();
  await waitInlineError();
  await unchanged(originalBytes);
  await fillRestore(mnemonic, newPassword, 'Recovery-test-mismatched-password');
  await page.getByRole('button', { name: 'Restore wallet and reset password' }).click();
  await waitInlineError();
  await unchanged(originalBytes);
  await cancelReplacement();
  await unchanged(originalBytes);
  await begin('switch', { testAcknowledgement: true });
  await page.screenshot({ path: path.join(screenshots, 'switch-wallet-choices.png') });
  await unchanged(originalBytes);
  await cancelReplacement();
  await unchanged(originalBytes);

  nextStage('recovery commits only after valid phrase, preserving encrypted archive');
  const historyBeforeRecovery = requests.filter(method => method === 'getaddresshistory').length;
  await begin('recover');
  await fillRestore(mnemonic, newPassword);
  await page.getByRole('button', { name: 'Restore wallet and reset password' }).click();
  const recoveredState = await ready();
  assert.equal(recoveredState.wallet.address, originalAddress);
  assert.equal(recoveredState.wallet.addressCount, 40);
  const expectedLookahead = [];
  for (const change of [0, 1]) for (let index = 0; index < 20; index++) {
    const account = deriveAccount(mnemonic, { network: 'testnet4', change, index });
    account.privateKey.fill(0); expectedLookahead.push(account.address);
  }
  assert.deepEqual(historyAddresses.slice(historyBeforeRecovery).sort(), [...expectedLookahead].sort(),
    'Recovery must discover both complete 20-address gaps exactly once through real RPC.');
  assert.equal(await page.locator('#restore-phrase, .seed-word').count(), 0);
  await lock();
  const firstBackups = await archives();
  assert.equal(firstBackups.length, 1);
  const firstBackup = path.join(backupDirectory, firstBackups[0]);
  assert.deepEqual(await readFile(firstBackup), originalBytes);
  assert.equal((await unlockVault(firstBackup, oldPassword)).mnemonic, mnemonic);
  await assert.rejects(unlockVault(vaultFile, oldPassword));
  assert.equal((await unlockVault(vaultFile, newPassword)).mnemonic, mnemonic);
  const historyBeforeUnlock = historyAddresses.length;
  await page.locator('#unlock-password').fill(newPassword);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  assert.equal((await ready()).wallet.address, originalAddress);
  assert.deepEqual(historyAddresses.slice(historyBeforeUnlock).sort(), [...expectedLookahead].sort(),
    'The next unlock refresh must check every lookahead address again; recovery emptiness is never persisted.');
  await lock();
  const recoveredBytes = await readFile(vaultFile);

  nextStage('creation preview can be cancelled without replacing old wallet');
  await createReplacement();
  await unchanged(recoveredBytes, 1);
  await page.locator('[data-action="cancel-setup"]').click();
  await page.getByRole('heading', { name: 'Choose your next wallet.', exact: true }).waitFor();
  assert.equal(await page.locator('.seed-word').count(), 0);
  await unchanged(recoveredBytes, 1);
  await cancelReplacement();
  await unchanged(recoveredBytes, 1);
  createdWords.fill(''); createdWords = [];

  nextStage('new wallet requires verified seed and archives previous encrypted file');
  await createReplacement();
  await unchanged(recoveredBytes, 1);
  await page.locator('#backup-ack').check();
  await page.getByRole('button', { name: 'Verify my backup' }).click();
  const indexes = await page.locator('#verify-form input').evaluateAll(nodes => nodes.map(node => Number(node.name.slice(5))));
  assert.equal(indexes.length, 3);
  for (const index of indexes) await page.locator(`#check-${index}`).fill('invalid-backup-answer');
  await page.getByRole('button', { name: 'Open my wallet' }).click();
  await waitInlineError();
  await unchanged(recoveredBytes, 1);
  for (const index of indexes) await page.locator(`#check-${index}`).fill(createdWords[index]);
  await page.getByRole('button', { name: 'Open my wallet' }).click();
  const createdAddress = (await ready()).wallet.address;
  assert.notEqual(createdAddress, originalAddress);
  await lock();
  const secondBackups = await archives();
  assert.equal(secondBackups.length, 2);
  const nextBackupName = secondBackups.find(name => !firstBackups.includes(name));
  assert.ok(nextBackupName);
  assert.deepEqual(await readFile(path.join(backupDirectory, nextBackupName)), recoveredBytes);
  assert.equal((await unlockVault(path.join(backupDirectory, nextBackupName), newPassword)).mnemonic, mnemonic);
  assert.equal((await unlockVault(vaultFile, createdPassword)).mnemonic, createdWords.join(' '));

  nextStage('relaunch with new wallet and encrypted storage only');
  await closeElectronTest(application); application = null;
  await launch();
  await page.locator('#unlock-password').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Forgot password?', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Use another wallet', exact: true }).isVisible(), true);
  await page.locator('#unlock-password').fill(createdPassword);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  assert.equal((await ready()).wallet.address, createdAddress);
  await lock();
  const sensitiveValues = [mnemonic, createdWords.join(' '), oldPassword, newPassword, createdPassword];
  for (const file of [vaultFile, ...secondBackups.map(name => path.join(backupDirectory, name)), path.join(profile, 'logs', 'diagnostics.jsonl')]) {
    const text = await readFile(file, 'utf8');
    for (const secret of sensitiveValues) assert.ok(!text.includes(secret), 'No recovery words or passwords may be stored in logs or plaintext vault/backup files.');
  }
  assert.deepEqual(errors, []);
  assert.ok(requests.includes('getaddressbalance'));
  assert.ok(!requests.includes('sendrawtransaction'));
  nextStage('finished');
  passed = true;
} catch (error) {
  // Never emit Playwright action dumps, secrets, page HTML or seed screenshots.
  const line = /test-ui-recovery\.mjs:(\d+):\d+/.exec(String(error.stack ?? ''))?.[1];
  console.error(`Recovery UI test failed during ${stage} after ${Math.round(performance.now() - stageStarted)} ms (${error.name ?? 'Error'}${line ? `, test line ${line}` : ''}). No recovery words were logged. Temporary profile preserved: ${profile}`);
  // Only fixed categories and event timings, never Playwright's action dump.
  const reason = /closed|destroyed/i.test(String(error.message)) ? 'window-or-process-closed'
    : /timeout|timed out/i.test(String(error.message)) ? 'deadline-exceeded' : 'assertion-or-action-failure';
  console.error(`Recovery UI failure metadata: ${JSON.stringify({ reason, lifecycle })}`);
  process.exitCode = 1;
} finally {
  createdWords.fill(''); createdWords = [];
  try { await closeElectronTest(application); }
  catch {
    passed = false; process.exitCode = 1;
    console.error('Recovery UI graceful shutdown failed. The temporary profile was preserved; no wallet data was logged.');
  }
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => fixture.close(resolve));
  if (passed) {
    const absolute = path.resolve(profile);
    assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
    assert.ok(path.basename(absolute).startsWith('connectwallet-ui-recovery-'));
    await rm(absolute, { recursive: true, force: true });
  }
}
if (passed) console.log(`PASS: isolated Electron locked recovery/switch controls, acknowledgement gates, cancellation, invalid phrases/password confirmation, verified new seed, same-address password recovery, byte-exact encrypted archives, relaunch persistence and no broadcasts. Non-secret screenshots: ${screenshots}`);
