import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiveRequestPreview } from '../src/ui/receive-request.mjs';
import { buildPaymentUri } from '../src/core/payment-uri.mjs';

const address = `tcc1p${'q'.repeat(58)}`;
const nextAddress = `tcc1p${'z'.repeat(58)}`;
const png = 'data:image/png;base64,AAAA';
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const draft = (amount = '') => ({ address, securityEpoch: 1, amount, label: '', message: '' });
const response = (values, target = address) => ({ address: target, uri: buildPaymentUri({ address: target, ...values }), qrDataUrl: png });

test('receive preview coalesces edits and does not regenerate on unrelated snapshots', async () => {
  let calls = 0, changes = 0;
  const preview = createReceiveRequestPreview({ delay: 0, generate: async values => { calls++; return response(values); }, onChange: () => changes++ });
  preview.update(draft('1')); preview.update(draft('2')); preview.update(draft('3'));
  assert.equal(preview.value.qrDataUrl, null);
  await tick();
  assert.equal(calls, 1); assert.equal(changes, 1);
  assert.equal(preview.value.uri, `connectcoin:${address}?amount=3`);
  assert.equal(preview.value.qrDataUrl, png);
  preview.update(draft('3')); await tick();
  assert.equal(calls, 1); preview.clear();
});

test('a trailing separator keeps the live URI and QR while later decimals update normally', async () => {
  const calls = [];
  const preview = createReceiveRequestPreview({ delay: 0, generate: async values => { calls.push({ ...values }); return response(values); }, onChange() {} });
  preview.update(draft('123')); await tick();
  const ready = preview.value;
  for (const amount of ['123.', '123,', '123']) {
    const edit = draft(amount);
    assert.equal(preview.update(edit), ready);
    assert.equal(edit.amount, amount, 'canonicalization must not alter the visible draft');
    assert.equal(preview.value.pending, false);
    assert.equal(preview.value.error, '');
  }
  await tick(); assert.equal(calls.length, 1);
  preview.update(draft('123.4')); await tick();
  assert.equal(preview.value.uri, `connectcoin:${address}?amount=123.4`);
  assert.equal(preview.value.qrDataUrl, png);
  preview.clear();
  preview.update(draft('456.')); await tick();
  assert.equal(calls.at(-1).amount, '456', 'the main process receives a canonical amount');
  assert.equal(preview.value.uri, `connectcoin:${address}?amount=456`);
  preview.clear();
});

test('invalid drafts immediately remove stale URI and QR without invoking the service', async () => {
  let calls = 0;
  const preview = createReceiveRequestPreview({ delay: 0, generate: async values => { calls++; return response(values); }, onChange() {} });
  preview.update(draft('1')); await tick();
  preview.update(draft('-2'));
  assert.equal(preview.value.uri, ''); assert.equal(preview.value.qrDataUrl, null);
  assert.ok(preview.value.error); await tick(); assert.equal(calls, 1); preview.clear();
});

test('late QR responses cannot restore an old draft, address, or security context', async () => {
  const pending = [];
  const preview = createReceiveRequestPreview({ delay: 0, generate: values => new Promise(resolve => pending.push({ resolve, values })), onChange() {} });
  preview.update(draft('1')); await tick();
  preview.update(draft('2')); await tick();
  pending[0].resolve(response(pending[0].values)); await tick();
  assert.equal(preview.value.qrDataUrl, null);
  pending[1].resolve(response(pending[1].values)); await tick();
  assert.equal(preview.value.uri, `connectcoin:${address}?amount=2`);
  preview.update({ ...draft('2'), address: nextAddress }); await tick();
  pending[2].resolve(response(pending[2].values)); await tick();
  assert.equal(preview.value.qrDataUrl, null); assert.ok(preview.value.error);
  preview.update({ ...draft('2'), securityEpoch: 2 }); await tick();
  preview.clear(); pending[3].resolve(response(pending[3].values)); await tick();
  assert.equal(preview.value.uri, ''); assert.equal(preview.value.qrDataUrl, null);
});

test('QR errors do not leave a previous QR visible and clearing allows retry', async () => {
  let failing = true;
  const preview = createReceiveRequestPreview({ delay: 0, generate: async values => { if (failing) throw new Error('encoding failed'); return response(values); }, onChange() {} });
  preview.update(draft()); await tick();
  assert.equal(preview.value.qrDataUrl, null); assert.equal(preview.value.error, 'encoding failed');
  failing = false; preview.clear(); preview.update(draft()); await tick();
  assert.equal(preview.value.qrDataUrl, png); preview.clear();
});
