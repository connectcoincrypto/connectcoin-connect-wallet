import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import { availableSendAmount, createSendRequest } from '../src/send-request.mjs';

const address = bech32m.encode('cc', [1, ...bech32m.toWords(secp256k1.Point.BASE.toBytes(true).slice(1))]);
const draft = { address, amount: '1', feeRate: '1500', subtractFeeFromAmount: false, useAllBalance: false };

test('Send passes five exact public fields, independent fee modes and decimal normalization', () => {
  assert.deepEqual(createSendRequest({ ...draft, address: ` ${address.toUpperCase()} `, amount: '0001,25', feeRate: '01500.', hex: 'ignored' }),
    { ...draft, amount: '1.25' });
  assert.equal(createSendRequest({ ...draft, amount: '1.' }).amount, '1');
  assert.equal(createSendRequest({ ...draft, amount: '.1' }).amount, '0.1');
  assert.equal(createSendRequest({ ...draft, subtractFeeFromAmount: true }).subtractFeeFromAmount, true);
  assert.deepEqual(createSendRequest({ ...draft, useAllBalance: true, subtractFeeFromAmount: true }),
    { ...draft, useAllBalance: true, subtractFeeFromAmount: true });
});

test('Send never rounds or truncates amounts, and bounds fee rates without coercion', () => {
  for (const amount of ['0.0000000001', '100000000.0000000000']) assert.equal(createSendRequest({ ...draft, amount }).amount, amount);
  for (const amount of ['', '0', '-1', '1e3', '1.00000000001', '100000000.0000000001', '1\n', 1, null]) {
    assert.throws(() => createSendRequest({ ...draft, amount }));
  }
  for (const feeRate of ['1201', '1500', '100000', '1201,']) assert.equal(createSendRequest({ ...draft, feeRate }).feeRate, feeRate.replace(/,$/, ''));
  for (const feeRate of ['', '0', '1200', '100001', '1500.1', '1e4', '1500\n', '-1500', 1500, null]) {
    assert.throws(() => createSendRequest({ ...draft, feeRate }), /fee rate/);
  }
});

test('Send flags cannot be coerced and use all must deduct fees', () => {
  assert.throws(() => createSendRequest({ ...draft, useAllBalance: true }), /requires deducting/);
  for (const key of ['useAllBalance', 'subtractFeeFromAmount']) {
    for (const value of [1, 0, 'true', 'false', null, undefined]) assert.throws(() => createSendRequest({ ...draft, [key]: value }));
  }
});

test('Recipient validation never discards payment URI details implicitly', () => {
  for (const value of ['', null, 123, 'bad', `connectcoin:${address}?amount=99`, address.slice(0, -1)]) {
    assert.throws(() => createSendRequest({ ...draft, address: value }));
  }
});

test('Use all uses only fresh available confirmed balance, never immature or pending totals', () => {
  const state = { address, updatedAt: 1, stale: false, busy: false,
    balance: { address, available_confirmed: '12345678901', confirmed: '990000000000', immature: '900000000000', total: '999999999999' } };
  assert.equal(availableSendAmount(state), '1.2345678901');
  assert.equal(availableSendAmount({ ...state, busy: true }), '1.2345678901'); // Routine refresh keeps the validated snapshot usable.
  for (const change of [{ stale: true }, { updatedAt: null }, { address: 'another' }, { balance: null }]) {
    assert.equal(availableSendAmount({ ...state, ...change }), null);
  }
  for (const value of ['0', '-1', '1000000000000000001', '1e10', 10000000000, null]) {
    assert.equal(availableSendAmount({ ...state, balance: { ...state.balance, available_confirmed: value } }), null);
  }
  assert.equal(availableSendAmount({ ...state, balance: { address, available_confirmed: '1000000000000000000' } }), '100000000');
});
