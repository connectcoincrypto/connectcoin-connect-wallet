import { parentPort } from 'node:worker_threads';
import { deriveAccount } from './crypto.mjs';
import { buildPayment, validatePaymentFundingPayload } from './transaction.mjs';

parentPort.once('message', input => {
  const accounts = new Map();
  try {
    const parents = validatePaymentFundingPayload(input);
    const utxos = input.utxos.map(utxo => {
      const { index, change } = utxo.account;
      const path = `${change}:${index}`;
      if (!accounts.has(path)) accounts.set(path, deriveAccount(input.mnemonic, {
        network: input.network, passphrase: input.passphrase, index, change,
      }));
      return { ...utxo, rawTransaction: utxo.rawTransaction ?? parents.get(utxo.txid.toLowerCase()),
        privateKey: accounts.get(path).privateKey };
    });
    const payment = buildPayment({ ...input, utxos });
    parentPort.postMessage({ payment });
  } catch (error) {
    // All messages originate in the local transaction/derivation validators;
    // do not return input, key material, stack traces or raw funding bytes.
    parentPort.postMessage({ error: error instanceof Error ? error.message : 'Local payment signing failed.' });
  } finally {
    for (const account of accounts.values()) account.privateKey.fill(0);
    accounts.clear();
    input.mnemonic = undefined; input.passphrase = undefined;
    parentPort.close();
  }
});
