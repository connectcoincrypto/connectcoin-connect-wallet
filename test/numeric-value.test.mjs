import test from 'node:test';
import assert from 'node:assert/strict';
import { integerInputError, numericInputValue } from '../src/ui/numeric-value.mjs';
import { parseCoinAmount } from '../src/core/transaction.mjs';

test('numeric editing values ignore only a single separator after integer digits', () => {
  for (const [input, expected] of [['123.', '123'], ['123,', '123'], ['0.', '0'], ['0001.', '0001'], ['123', '123'], ['123.4', '123.4'], ['', '']]) {
    assert.equal(numericInputValue(input), expected);
  }
  for (const input of ['.', ',', '1..', '1.2.', '1.2,', '1e2.', '1x.', '-1.', '+1.', '1 .', '1.\n', null, undefined, 12]) {
    assert.equal(numericInputValue(input), input, String(input));
  }
  const exact = '9'.repeat(77);
  assert.equal(numericInputValue(`${exact}.`), exact);
  assert.equal(parseCoinAmount(numericInputValue('123.')), 1230000000000n);
  assert.equal(parseCoinAmount(numericInputValue('0.0000000001')), 1n);
  assert.throws(() => parseCoinAmount('123.'), /amount/i, 'backend parsing remains strict');
});

test('integer text controls preserve required, integer and range validation', () => {
  for (const [min, max] of [['1', '256'], ['1', '600'], ['1', '65535'], ['1', '60'], ['1201', '100000']]) {
    const bounds = { min, max };
    assert.equal(integerInputError('', bounds), '');
    for (const input of [min, max, `${min}.`, `${max}.`, `${max},`]) assert.equal(integerInputError(input, bounds), '', input);
    for (const input of [(BigInt(min) - 1n).toString(), `${BigInt(max) + 1n}.`, '1.2', '1.2.', '1..', '1e3', '-', '.', 'NaN', 'Infinity', null]) {
      assert.notEqual(integerInputError(input, bounds), '', String(input));
    }
  }
  assert.equal(integerInputError(`${'9'.repeat(77)}.`, { min: '1' }), '');
});
