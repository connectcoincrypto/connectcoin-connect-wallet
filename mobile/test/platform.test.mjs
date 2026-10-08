import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeCapabilities } from '../src/platform.mjs';

test('Android keeps its wallet and explicitly enabled background service', () => {
  assert.deepEqual(nativeCapabilities('android'), { wallet: true, claims: true, backgroundClaims: true });
});
test('iOS enables the native wallet and foreground claims only', () => {
  assert.deepEqual(nativeCapabilities('ios'), { wallet: true, claims: true, backgroundClaims: false });
});
test('Preview and unknown platforms never acquire native wallet capabilities', () => {
  for (const value of ['web', 'IOS', '', undefined]) {
    assert.deepEqual(nativeCapabilities(value), { wallet: false, claims: false, backgroundClaims: false });
    assert.equal(Object.isFrozen(nativeCapabilities(value)), true);
  }
});
