import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeActionState, nativeControlState } from '../src/native-controls.mjs';

test('lock and stop interrupt a busy native action without owning its busy flag', () => {
  for (const action of ['lock', 'claimsStop']) {
    assert.deepEqual(nativeActionState(action, true, true), { allowed: true, ownsBusy: false });
    assert.equal(nativeActionState(action, false, false).allowed, false);
  }
  assert.deepEqual(nativeActionState('reviewPayment', true, true), { allowed: false, ownsBusy: true });
  assert.deepEqual(nativeActionState('reviewPayment', true, false), { allowed: true, ownsBusy: true });
});

test('a fatal stopped engine still exposes Stop while runtime owns its session', () => {
  const state = nativeControlState({ native: true, address: 'public', claims: { enabled: false, requested: true }, locked: false, busy: true });
  assert.deepEqual(state, { startDisabled: true, stopDisabled: false, lockDisabled: false });
  assert.equal(nativeControlState({ native: true, address: 'public', claims: { enabled: false, requested: false }, locked: true, busy: false }).startDisabled, false);
});

test('preview cannot operate native controls and an in-flight unlock can be cancelled', () => {
  assert.deepEqual(nativeControlState({ native: false, address: 'public', claims: { requested: true }, locked: false, busy: true }),
    { startDisabled: true, stopDisabled: true, lockDisabled: true });
  assert.equal(nativeControlState({ native: true, address: '', claims: null, locked: true, busy: true }).lockDisabled, false);
});

test('wallet file and security operations are explicit native actions and never interrupt another busy action', () => {
  for (const action of ['importWallet', 'exportWallet', 'changePassword', 'viewRecoveryPhrase']) {
    assert.deepEqual(nativeActionState(action, true, false), { allowed: true, ownsBusy: true });
    assert.deepEqual(nativeActionState(action, true, true), { allowed: false, ownsBusy: true });
    assert.deepEqual(nativeActionState(action, false, false), { allowed: false, ownsBusy: true });
  }
});
