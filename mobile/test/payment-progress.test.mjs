import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentProgressText } from '../src/payment-progress.mjs';
const context = { operation: 'reviewPayment', address: 'own-address', busy: true, active: true };
const event = { operation: 'reviewPayment', address: 'own-address', stage: 'funding', completed: 192, total: 1000, retryAfterMs: 0 };
test('fragmented payment progress reports counts and cancel/confirmation boundaries', () => {
  assert.match(paymentProgressText(event, context), /192 \/ 1000/);
  assert.match(paymentProgressText(event, context), /Nothing is sent until you confirm/);
  assert.match(paymentProgressText({ ...event, stage: 'waiting', retryAfterMs: 60000 }, context), /about 60 seconds/);
  assert.match(paymentProgressText({ ...event, stage: 'outputs', total: 0 }, context), /192 checked/);
});
test('late or other-wallet progress cannot update a payment', () => {
  for (const patch of [{ busy: false }, { active: false }, { address: 'other' }, { operation: 'reviewP2C' }, { operation: 'create' }])
    assert.equal(paymentProgressText(event, { ...context, ...patch }), '');
});
test('malformed progress is never rendered', () => {
  for (const patch of [{ stage: '<script>' }, { completed: -1 }, { completed: 1001 }, { total: '1000' },
    { retryAfterMs: Infinity }, { retryAfterMs: 900001 }, { total: 50001 }])
    assert.equal(paymentProgressText({ ...event, ...patch }, context), '');
});

test('batch signing and submission progress keep the broadcast boundary explicit', () => {
  const signing = { ...event, stage: 'signing', completed: 1, total: 3 };
  assert.match(paymentProgressText(signing, context), /1 \/ 3 transactions/);
  assert.match(paymentProgressText(signing, context), /Nothing has been submitted yet/);
  const broadcasting = paymentProgressText({ ...signing, stage: 'broadcasting' }, context);
  assert.match(broadcasting, /Some parts may already be sent/);
  assert.doesNotMatch(broadcasting, /Nothing|until you confirm|success|confirmed/i);
  for (const patch of [{ total: 0 }, { total: 1 }, { total: 33 }, { completed: 4 }])
    assert.equal(paymentProgressText({ ...signing, ...patch }, context), '');
  assert.equal(paymentProgressText({ ...signing, operation: 'reviewP2C' }, { ...context, operation: 'reviewP2C' }), '');
});
