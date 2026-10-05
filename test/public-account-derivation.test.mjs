import assert from 'node:assert/strict';
import test from 'node:test';
import { HDKey, HARDENED_OFFSET } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createPublicAccountDeriver, deriveAccount, MAX_ADDRESS_INDEX } from '../src/core/crypto.mjs';

const mnemonic = `${'abandon '.repeat(11)}about`;
const publicPart = account => {
  const { privateKey, ...result } = account;
  privateKey.fill(0); return result;
};

test('public address batches match unchanged private derivation across networks, branches and boundary indexes', () => {
  const parities = new Set();
  for (const network of ['main', 'testnet4', 'regtest']) {
    const deriver = createPublicAccountDeriver(mnemonic, { network });
    try {
      for (const change of [0, 1]) for (const index of [0, 1, 2, 3, 7, 19, 20, 41, 255, 10000, MAX_ADDRESS_INDEX - 1, MAX_ADDRESS_INDEX]) {
        const reference = deriveAccount(mnemonic, { network, change, index });
        parities.add(secp256k1.getPublicKey(reference.privateKey, true)[0]);
        assert.deepEqual(deriver.derive(index, change), publicPart(reference));
      }
    } finally { deriver.destroy(); }
  }
  assert.deepEqual([...parities].sort(), [2, 3], 'Both compressed point parities must preserve the same final x-only key');
});

test('default network, mnemonic normalization and Unicode BIP39 passphrases match the signing reference', () => {
  const normalized = createPublicAccountDeriver(`  ${mnemonic.toUpperCase()}\n`);
  try { assert.deepEqual(normalized.derive(0, 0), publicPart(deriveAccount(mnemonic))); }
  finally { normalized.destroy(); }
  for (const passphrase of ['TREZOR', 'caf\u00e9 \u212b \ud83d\udd11', 'cafe\u0301 A\u030a \ud83d\udd11', 'x'.repeat(1024)]) {
    const deriver = createPublicAccountDeriver(mnemonic, { passphrase });
    try {
      for (const change of [0, 1]) assert.deepEqual(deriver.derive(17, change), publicPart(deriveAccount(mnemonic, { index: 17, change, passphrase })));
    } finally { deriver.destroy(); }
  }
  const composed = createPublicAccountDeriver(mnemonic, { passphrase: '\u00e9' });
  const decomposed = createPublicAccountDeriver(mnemonic, { passphrase: 'e\u0301' });
  try { assert.deepEqual(composed.derive(3, 1), decomposed.derive(3, 1)); }
  finally { composed.destroy(); decomposed.destroy(); }
});

test('all supported BIP39 word counts retain their original public derivation', () => {
  for (const phrase of [mnemonic, `${'abandon '.repeat(17)}agent`, `${'abandon '.repeat(23)}art`]) {
    const deriver = createPublicAccountDeriver(phrase);
    try { assert.deepEqual(deriver.derive(8, 1), publicPart(deriveAccount(phrase, { index: 8, change: 1 }))); }
    finally { deriver.destroy(); }
  }
});

test('factory rejects invalid mnemonic, network and passphrase inputs without coercion', () => {
  for (const phrase of [null, undefined, {}, [], 12, '', 'abandon '.repeat(12), 'x'.repeat(1025)]) assert.throws(() => createPublicAccountDeriver(phrase));
  for (const network of ['', 'bitcoin', 'MAIN', '__proto__', null, 1, ['main'], { toString: () => 'main' }]) assert.throws(() => createPublicAccountDeriver(mnemonic, { network }));
  for (const passphrase of [null, 1, [], {}, 'x'.repeat(1025), '\ud800']) assert.throws(() => createPublicAccountDeriver(mnemonic, { passphrase }));
});

test('public handle exposes only derive/destroy, validates indexes, and cannot be revived after destroy', () => {
  const deriver = createPublicAccountDeriver(mnemonic);
  assert.equal(Object.isFrozen(deriver), true);
  assert.deepEqual(Reflect.ownKeys(deriver).sort(), ['derive', 'destroy']);
  assert.equal(JSON.stringify(deriver), '{}');
  for (const index of [undefined, null, '0', false, -1, 0.1, NaN, Infinity, MAX_ADDRESS_INDEX + 1, Number.MAX_SAFE_INTEGER]) assert.throws(() => deriver.derive(index, 0), /Invalid derivation index/);
  for (const change of [undefined, null, '0', false, -1, 0.1, 2, NaN, Infinity]) assert.throws(() => deriver.derive(0, change), /Invalid derivation index/);
  const detachedDerive = deriver.derive, detachedDestroy = deriver.destroy;
  const before = detachedDerive(1, 0);
  assert.equal('privateKey' in before, false); assert.equal('chainCode' in before, false);
  detachedDestroy(); detachedDestroy();
  assert.throws(() => detachedDerive(1, 0), /destroyed/);
  assert.deepEqual(before, publicPart(deriveAccount(mnemonic, { index: 1 })));
});

test('mutating input options or returned metadata cannot alter the retained public branches', () => {
  const options = { network: 'main', passphrase: 'public test passphrase' };
  const deriver = createPublicAccountDeriver(mnemonic, options);
  try {
    const expected = deriver.derive(5, 1), modified = deriver.derive(5, 1);
    options.network = 'regtest'; options.passphrase = 'changed';
    Object.assign(modified, { publicKey: '00'.repeat(32), address: 'invalid', path: 'm/0', network: 'regtest', index: 0, change: 0, privateKey: new Uint8Array(32) });
    assert.deepEqual(deriver.derive(5, 1), expected);
    assert.notEqual(deriver.derive(5, 1), expected);
    assert.deepEqual(deriver.derive(5, 1), publicPart(deriveAccount(mnemonic, { network: 'main', passphrase: 'public test passphrase', index: 5, change: 1 })));
  } finally { deriver.destroy(); }
});

function instrumentNodes(run, { failAtDepth, failMaster = false } = {}) {
  const master = HDKey.fromMasterSeed, derive = HDKey.prototype.deriveChild;
  const nodes = [], privateBuffers = []; let capturedSeed;
  const record = node => { nodes.push(node); if (node._privateKey) privateBuffers.push(node._privateKey); return node; };
  HDKey.fromMasterSeed = function(seed, ...args) {
    capturedSeed = seed;
    if (failMaster) throw new Error('Synthetic constructor derivation failure');
    return record(master.call(this, seed, ...args));
  };
  HDKey.prototype.deriveChild = function(...args) {
    if (this.depth === failAtDepth) throw new Error('Synthetic constructor derivation failure');
    return record(derive.apply(this, args));
  };
  try { run({ nodes, privateBuffers, seed: () => capturedSeed }); }
  finally { HDKey.fromMasterSeed = master; HDKey.prototype.deriveChild = derive; }
  assert.ok(capturedSeed.every(byte => byte === 0), 'The BIP39 seed must be cleared even on failure');
  assert.ok(privateBuffers.every(buffer => buffer.every(byte => byte === 0)), 'Wipe actual internal buffers, not copies returned by the privateKey getter');
  assert.ok(nodes.every(node => node.privateKey === null), 'No reachable HD node may still carry a private key');
}

test('seed and every reachable hardened intermediate are wiped before the public handle returns', () => {
  instrumentNodes(({ nodes, privateBuffers, seed }) => {
    const deriver = createPublicAccountDeriver(mnemonic);
    try {
      assert.equal(nodes.length, 6); assert.equal(privateBuffers.length, 4);
      assert.ok(seed().every(byte => byte === 0));
      assert.ok(privateBuffers.every(buffer => buffer.every(byte => byte === 0)));
      assert.ok(nodes.every(node => node.privateKey === null));
      deriver.derive(0, 0); deriver.derive(1, 1);
      assert.equal(privateBuffers.length, 4, 'Subsequent normal children must be public-only');
    } finally { deriver.destroy(); }
  });
});

test('constructor failures wipe seed and already-created private nodes at every derivation level', () => {
  instrumentNodes(() => {
    assert.throws(() => createPublicAccountDeriver(mnemonic), /Synthetic constructor derivation failure/);
  }, { failMaster: true });
  for (const failAtDepth of [0, 1, 2, 3]) instrumentNodes(() => {
    assert.throws(() => createPublicAccountDeriver(mnemonic), /Synthetic constructor derivation failure/);
  }, { failAtDepth });
});

test('ordinary invalid-child retries preserve signing-reference results without crossing the hardened boundary', () => {
  const derive = HDKey.prototype.deriveChild;
  HDKey.prototype.deriveChild = function(index) {
    if (this.depth === 4 && index === 17) return this._deriveChild(index, new Uint8Array(64).fill(255));
    return derive.call(this, index);
  };
  let deriver;
  try {
    deriver = createPublicAccountDeriver(mnemonic);
    for (const change of [0, 1]) assert.deepEqual(deriver.derive(17, change), publicPart(deriveAccount(mnemonic, { index: 17, change })));
    let crossedBoundary = false;
    HDKey.prototype.deriveChild = function(index) {
      if (this.depth === 4 && index >= HARDENED_OFFSET) crossedBoundary = true;
      if (this.depth === 4 && index === MAX_ADDRESS_INDEX) return this._deriveChild(index, new Uint8Array(64).fill(255));
      return derive.call(this, index);
    };
    assert.throws(() => deriver.derive(MAX_ADDRESS_INDEX, 0), /cannot retry child derivation/);
    assert.equal(crossedBoundary, false);
  } finally { deriver?.destroy(); HDKey.prototype.deriveChild = derive; }
});
