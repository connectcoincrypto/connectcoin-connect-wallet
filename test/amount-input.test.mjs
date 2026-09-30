import test from 'node:test';
import assert from 'node:assert/strict';
import { installAmountInputRestrictions, normalizeAmountInput } from '../src/ui/amount-input.mjs';

class FakeEvent {
  constructor(type, options = {}) { Object.assign(this, { type, cancelable: false, defaultPrevented: false }, options); }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopImmediatePropagation() { this.stopped = true; }
}

function fixture(value = '', options = {}) {
  const listeners = [];
  const drafts = [];
  const rejected = [];
  const document = {
    activeElement: null,
    defaultView: { Event: FakeEvent, InputEvent: FakeEvent },
    addEventListener(type, handler, capture = false) { listeners.push({ type, handler, capture }); },
    removeEventListener(type, handler) {
      const index = listeners.findIndex(item => item.type === type && item.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    querySelectorAll() { return [input]; },
  };
  const input = {
    value, defaultValue: value, selectionStart: value.length, selectionEnd: value.length, selectionDirection: 'none',
    dataset: { ...options.dataset },
    matches(selector) { return selector === (options.selector ?? 'input[data-amount]'); },
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
    dispatchEvent(event) {
      event.target = this;
      for (const capture of [true, false]) {
        for (const listener of listeners.filter(item => item.type === event.type && item.capture === capture)) {
          listener.handler(event);
          if (event.stopped) return !event.defaultPrevented;
        }
      }
      return !event.defaultPrevented;
    },
  };
  document.activeElement = input;
  // Register the app first: the guard must still run before bubble handlers.
  document.addEventListener('input', event => drafts.push(event.target.value));
  const dispose = installAmountInputRestrictions(document, { onReject: rejection => rejected.push(rejection), ...options });
  const fire = (type, details = {}) => {
    const event = new FakeEvent(type, { cancelable: true, ...details });
    input.dispatchEvent(event);
    return event;
  };
  const edit = (text, inputType = 'insertText', details = {}) => {
    const event = fire('beforeinput', { data: text, inputType, ...details });
    if (!event.defaultPrevented) {
      const start = input.selectionStart, end = input.selectionEnd;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      input.setSelectionRange(start + text.length, start + text.length);
      fire('input', { data: text, inputType, ...details });
    }
    return event;
  };
  const transfer = (source, text) => {
    const data = { getData: type => type === 'text/plain' ? text : '' };
    const event = fire(source, source === 'paste' ? { clipboardData: data } : { dataTransfer: data });
    if (!event.defaultPrevented) edit(text, source === 'paste' ? 'insertFromPaste' : 'insertFromDrop');
    return event;
  };
  return { input, document, drafts, rejected, fire, edit, transfer, dispose };
}

test('amount normalization keeps exact decimal strings and useful editing states', () => {
  for (const [value, expected] of [
    ['', ''], ['0', '0'], ['1.', '1.'], ['.', '0.'], [',', '0.'], ['.5', '0.5'],
    ['0,0000000001', '0.0000000001'], ['000123.4500', '123.4500'], ['0000', '0'],
    ['999999999.9999999999', '999999999.9999999999'], ['000123456789', '123456789'],
  ]) assert.equal(normalizeAmountInput(value), expected, value);
  for (const value of ['a', '12a34', '1e3', '1E3', '-1', '+1', ' 1', '1 ', '1\n', '1/2', '∞', '１', '1,2.3', '1..2', '1,,2', '1_000', '1000000000', '0.00000000001', null, 1]) {
    assert.equal(normalizeAmountInput(value), null, String(value));
  }
});

test('normalization retains exact decimal digits after redundant leading zeroes', () => {
  const exact = '123456789.0123456789';
  assert.equal(normalizeAmountInput('0'.repeat(1004) + exact), exact);
  assert.equal(normalizeAmountInput('0'.repeat(1005) + exact), exact);
});

test('integer normalization preserves trailing separators and all 78 candidate digits', () => {
  const integerRules = { maxFractionDigits: 0 };
  for (const [value, expected] of [['123.', '123.'], ['123,', '123.'], ['000123,', '123.'], ['.', '0.'], ['', '']]) {
    assert.equal(normalizeAmountInput(value, integerRules), expected);
  }
  for (const value of ['123.0', '1,2', '1.0000000001', '1000000000', '1e3']) {
    assert.equal(normalizeAmountInput(value, integerRules), null);
  }
  const largeIntegerRules = { maxIntegerDigits: 78, maxFractionDigits: 0 };
  const exact = '1234567890'.repeat(7) + '12345678';
  assert.equal(exact.length, 78);
  assert.equal(normalizeAmountInput(exact, largeIntegerRules), exact);
  assert.equal(normalizeAmountInput(`00${exact},`, largeIntegerRules), `${exact}.`);
  assert.equal(normalizeAmountInput(`${exact}9`, largeIntegerRules), null);
  assert.equal(normalizeAmountInput(`${exact}.1`, largeIntegerRules), null);
});

test('integer fields use their own rules during typing, paste, and input fallback', () => {
  const f = fixture('123', { dataset: { numeric: 'integer' } });
  f.edit(',');
  assert.equal(f.input.value, '123.');
  assert.equal(f.input.selectionStart, 4);
  assert.deepEqual(f.drafts, ['123.']);
  assert.equal(f.edit('0').defaultPrevented, true);
  f.input.setSelectionRange(0, 4, 'backward');
  assert.equal(f.transfer('paste', '321.5').defaultPrevented, true);
  assert.equal(f.input.value, '123.');
  assert.equal(f.input.selectionStart, 0);
  assert.equal(f.input.selectionEnd, 4);
  f.edit('2.5', 'insertReplacementText', { cancelable: false });
  assert.equal(f.input.value, '123.');
  assert.equal(f.input.selectionDirection, 'backward');
  f.transfer('paste', '000321,');
  assert.equal(f.input.value, '321.');
  assert.equal(f.input.selectionStart, 4);
  assert.deepEqual(f.drafts, ['123.', '321.']);
  f.input.value = '2.5';
  f.fire('input', { inputType: 'insertReplacementText' });
  assert.equal(f.input.value, '321.');
  assert.deepEqual(f.drafts, ['123.', '321.']);
});

test('candidate integer fields preserve large exact values across paste, edits, and render resets', () => {
  const exact = '1234567890'.repeat(7) + '12345678';
  const f = fixture('1000', { dataset: { numeric: 'integer', integerDigits: '78' } });
  f.input.setSelectionRange(0, 4);
  assert.equal(f.transfer('paste', exact).defaultPrevented, false);
  assert.equal(f.input.value, exact);
  assert.equal(f.edit('9').defaultPrevented, true);
  f.edit(',');
  assert.equal(f.input.value, `${exact}.`);
  assert.equal(f.input.selectionStart, 79);
  assert.equal(f.edit('0').defaultPrevented, true);
  const replacement = '9'.repeat(78);
  f.input.value = `${replacement}.`;
  f.input.setSelectionRange(77, 79, 'backward');
  f.dispose.sync();
  f.input.value = `${replacement}.5`;
  f.fire('input');
  assert.equal(f.input.value, `${replacement}.`);
  assert.equal(f.input.selectionStart, 77);
  assert.equal(f.input.selectionEnd, 79);
  assert.equal(f.input.selectionDirection, 'backward');
  assert.deepEqual(f.drafts, [exact, `${exact}.`]);
  const fallback = fixture('invalid', { dataset: { numeric: 'integer', integerDigits: '78' } });
  fallback.input.defaultValue = `${exact}.`;
  fallback.fire('input');
  assert.equal(fallback.input.value, `${exact}.`, 'default-value rollback must also use the field rules');
});

test('integer fields keep native editing controls and reject fractional IME commits', async () => {
  const f = fixture('123.', { dataset: { numeric: 'integer' } });
  for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'a']) {
    assert.equal(f.fire('keydown', { key, ctrlKey: key === 'a' }).defaultPrevented, false);
  }
  assert.equal(f.fire('beforeinput', { inputType: 'deleteContentBackward' }).defaultPrevented, false);
  f.input.value = '123';
  f.input.setSelectionRange(3, 3);
  f.fire('input', { inputType: 'deleteContentBackward' });
  f.fire('compositionstart');
  f.input.value = '123.5';
  f.input.setSelectionRange(5, 5);
  f.fire('input', { inputType: 'insertCompositionText', isComposing: true });
  f.fire('compositionend', { data: '.5' });
  await Promise.resolve();
  assert.equal(f.input.value, '123');
  assert.deepEqual(f.drafts, ['123']);
  f.fire('compositionstart');
  f.input.value = '123,';
  f.input.setSelectionRange(4, 4);
  f.fire('compositionend', { data: ',' });
  await Promise.resolve();
  assert.equal(f.input.value, '123.');
  assert.deepEqual(f.drafts, ['123', '123.']);
});

test('terminal line separators are rejected in typing, paste, and drop', () => {
  for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
    assert.equal(normalizeAmountInput(`1${separator}`), null);
    for (const source of ['typing', 'paste', 'drop']) {
      const f = fixture('12.34');
      f.input.setSelectionRange(0, 5, 'backward');
      const event = source === 'typing' ? f.edit(`1${separator}`) : f.transfer(source, `1${separator}`);
      assert.equal(event.defaultPrevented, true, `${source}: ${JSON.stringify(separator)}`);
      assert.equal(f.input.value, '12.34');
      assert.equal(f.input.selectionStart, 0);
      assert.equal(f.input.selectionEnd, 5);
      assert.equal(f.input.selectionDirection, 'backward');
      assert.deepEqual(f.drafts, []);
      assert.equal(f.rejected.length, source === 'typing' ? 0 : 1);
    }
  }
});

test('typing rejects invalid edits without disturbing the value, selection, or draft', () => {
  const f = fixture('12.34');
  f.input.setSelectionRange(1, 4, 'backward');
  for (const text of ['a', '-', '+', '/', 'e', '.', ',']) {
    // A separator is valid when the selection includes the existing separator.
    if (text === '.' || text === ',') f.input.setSelectionRange(5, 5);
    const before = [f.input.value, f.input.selectionStart, f.input.selectionEnd, f.input.selectionDirection];
    assert.equal(f.edit(text).defaultPrevented, true, text);
    assert.deepEqual([f.input.value, f.input.selectionStart, f.input.selectionEnd, f.input.selectionDirection], before);
  }
  assert.deepEqual(f.drafts, []);
  assert.deepEqual(f.rejected, []);
});

test('the eleventh decimal is rejected but selecting and replacing decimals works', () => {
  const f = fixture('0.1234567890');
  assert.equal(f.edit('1').defaultPrevented, true);
  assert.equal(f.input.value, '0.1234567890');
  f.input.setSelectionRange(2, 12);
  f.edit('9876543210');
  assert.equal(f.input.value, '0.9876543210');
  assert.deepEqual(f.drafts, ['0.9876543210']);
});

test('commas and leading decimal points normalize before draft handlers and retain caret', () => {
  const f = fixture();
  f.edit(',');
  assert.equal(f.input.value, '0.');
  assert.equal(f.input.selectionStart, 2);
  f.edit('0000000001');
  assert.equal(f.input.value, '0.0000000001');
  assert.deepEqual(f.drafts, ['0.', '0.0000000001']);
  const zeros = fixture('0');
  zeros.edit('7');
  assert.equal(zeros.input.value, '7');
  assert.equal(zeros.input.selectionStart, 1);
});

test('invalid paste and drop reject the whole payload, preserve selection, and report source', async () => {
  for (const source of ['paste', 'drop']) {
    const f = fixture('12.34');
    f.input.setSelectionRange(0, 5, 'backward');
    for (const text of ['1.12345678901', '123abc', '1e3', '1,2.3', '1234567890', ' 2 ']) {
      assert.equal(f.transfer(source, text).defaultPrevented, true);
      assert.equal(f.input.value, '12.34');
      assert.equal(f.input.selectionStart, 0);
      assert.equal(f.input.selectionEnd, 5);
      assert.equal(f.input.selectionDirection, 'backward');
      assert.equal(f.rejected.at(-1).source, source);
      assert.equal(f.rejected.at(-1).attemptedValue, text);
      await Promise.resolve();
    }
    assert.equal(f.rejected.length, 6);
    assert.deepEqual(f.drafts, []);
  }
});

test('valid paste normalizes the entire payload and preserves native canonical insertion', () => {
  const f = fixture('12.34');
  f.input.setSelectionRange(0, 5);
  assert.equal(f.transfer('paste', '000000000000000000000000000000000000123,0000000001').defaultPrevented, true);
  assert.equal(f.input.value, '123.0000000001');
  assert.equal(f.input.selectionStart, 14);
  assert.deepEqual(f.drafts, ['123.0000000001']);
  f.input.setSelectionRange(0, 14);
  assert.equal(f.transfer('paste', '2.5').defaultPrevented, false);
  assert.equal(f.input.value, '2.5');
  assert.deepEqual(f.drafts, ['123.0000000001', '2.5']);
});

test('empty and nontext clipboard data never remove the selection', () => {
  for (const clipboardData of [undefined, { getData: () => '' }, { types: ['text/html'], getData: () => '' }]) {
    const f = fixture('12.34');
    f.input.setSelectionRange(1, 4, 'backward');
    assert.equal(f.fire('paste', { clipboardData }).defaultPrevented, true);
    assert.equal(f.input.value, '12.34');
    assert.equal(f.input.selectionStart, 1);
    assert.equal(f.input.selectionEnd, 4);
    assert.equal(f.input.selectionDirection, 'backward');
    assert.deepEqual(f.drafts, []);
    assert.deepEqual(f.rejected, []);
  }
});

test('every drop is rejected without guessing its caret or same-field move behavior', () => {
  for (const text of ['5', '0.0000000001', '']) {
    const f = fixture('12.34');
    f.input.setSelectionRange(1, 4, 'backward');
    assert.equal(f.transfer('drop', text).defaultPrevented, true);
    assert.equal(f.input.value, '12.34');
    assert.equal(f.input.selectionStart, 1);
    assert.equal(f.input.selectionEnd, 4);
    assert.equal(f.input.selectionDirection, 'backward');
    assert.deepEqual(f.drafts, []);
    assert.equal(f.rejected[0].source, 'drop');
  }
  const f = fixture('12.34');
  f.input.setSelectionRange(1, 4);
  assert.equal(f.fire('beforeinput', { inputType: 'deleteByDrag' }).defaultPrevented, true);
  assert.equal(f.edit('5', 'insertFromDrop').defaultPrevented, true);
  f.edit('5', 'insertFromDrop', { cancelable: false });
  assert.equal(f.input.value, '12.34');
  assert.equal(f.input.selectionStart, 1);
  assert.equal(f.input.selectionEnd, 4);
  assert.deepEqual(f.drafts, []);
});

test('normalized paste uses the native editing transaction and publishes once with its final caret', () => {
  const f = fixture('12.34');
  const commands = [];
  f.input.setSelectionRange(0, 5);
  f.document.execCommand = (command, showUi, text) => {
    commands.push([command, showUi, text]);
    assert.equal(f.input.selectionStart, 0);
    assert.equal(f.input.selectionEnd, 5);
    f.edit(text);
    assert.deepEqual(f.drafts, [], 'native intermediate input must not publish before the final caret');
    return true;
  };
  assert.equal(f.transfer('paste', '0,0000000001').defaultPrevented, true);
  assert.deepEqual(commands, [['insertText', false, '0.0000000001']]);
  assert.equal(f.input.value, '0.0000000001');
  assert.equal(f.input.selectionStart, 12);
  assert.deepEqual(f.drafts, ['0.0000000001']);
});

test('normalized paste falls back to its complete validated value when native editing is unavailable', () => {
  for (const execCommand of [undefined, () => false, () => { throw new Error('unsupported'); }]) {
    const f = fixture('12.34');
    f.document.execCommand = execCommand;
    f.input.setSelectionRange(0, 5);
    f.transfer('paste', ',25');
    assert.equal(f.input.value, '0.25');
    assert.equal(f.input.selectionStart, 4);
    assert.deepEqual(f.drafts, ['0.25']);
  }
});

test('uncancelable input fallback restores value and selection before app handlers', () => {
  const f = fixture('12.34');
  f.input.setSelectionRange(1, 4, 'backward');
  assert.equal(f.edit('invalid', 'insertText', { cancelable: false }).defaultPrevented, false);
  assert.equal(f.input.value, '12.34');
  assert.equal(f.input.selectionStart, 1);
  assert.equal(f.input.selectionEnd, 4);
  assert.equal(f.input.selectionDirection, 'backward');
  assert.deepEqual(f.drafts, []);
});

test('input-only fallback rejects invalid changes and accepts normalized autofill', () => {
  const f = fixture('1.25');
  f.input.value = '1e3';
  const rejected = f.fire('input', { inputType: 'insertReplacementText' });
  assert.equal(rejected.stopped, true);
  assert.equal(f.input.value, '1.25');
  assert.deepEqual(f.drafts, []);
  f.input.value = '002,5';
  f.input.setSelectionRange(5, 5);
  f.fire('input', { inputType: 'insertReplacementText' });
  assert.equal(f.input.value, '2.5');
  assert.equal(f.input.selectionStart, 3);
  assert.deepEqual(f.drafts, ['2.5']);
});

test('render sync and pre-edit snapshots prevent rollback to a stale draft', () => {
  const f = fixture('1');
  f.input.value = '8.5';
  f.input.setSelectionRange(1, 2);
  f.dispose.sync();
  f.input.value = 'bad';
  f.fire('input');
  assert.equal(f.input.value, '8.5');
  assert.equal(f.input.selectionStart, 1);
  assert.equal(f.input.selectionEnd, 2);
  f.input.value = '7';
  f.input.setSelectionRange(1, 1);
  f.edit('e', 'insertText', { cancelable: false });
  assert.equal(f.input.value, '7');
});

test('delete, backspace, selection replacement, navigation, and undo stay native', () => {
  const f = fixture('12.3');
  for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'a']) {
    assert.equal(f.fire('keydown', { key, ctrlKey: key === 'a' }).defaultPrevented, false);
  }
  f.input.setSelectionRange(0, 4);
  assert.equal(f.fire('beforeinput', { inputType: 'deleteContentBackward' }).defaultPrevented, false);
  f.input.value = '';
  f.input.setSelectionRange(0, 0);
  f.fire('input', { inputType: 'deleteContentBackward' });
  assert.deepEqual(f.drafts, ['']);
  f.fire('beforeinput', { inputType: 'historyUndo' });
  f.input.value = '12.3';
  f.input.setSelectionRange(4, 4);
  f.fire('input', { inputType: 'historyUndo' });
  assert.deepEqual(f.drafts, ['', '12.3']);
  const bounded = fixture('123456789.1');
  bounded.input.setSelectionRange(10, 10);
  assert.equal(bounded.fire('beforeinput', { inputType: 'deleteContentBackward' }).defaultPrevented, true);
});

test('IME composition keeps transient text private and publishes a valid final value once', async () => {
  for (const finalInput of [false, true]) {
    const f = fixture('1');
    f.fire('compositionstart');
    f.input.value = '1あ';
    f.input.setSelectionRange(2, 2);
    f.fire('input', { inputType: 'insertCompositionText', isComposing: true });
    assert.equal(f.input.value, '1あ');
    assert.deepEqual(f.drafts, []);
    f.dispose.sync();
    f.input.value = '12';
    f.input.setSelectionRange(2, 2);
    f.fire('compositionend', { data: '2' });
    if (finalInput) f.fire('input', { inputType: 'insertCompositionText' });
    await Promise.resolve();
    assert.equal(f.input.value, '12');
    assert.deepEqual(f.drafts, ['12']);
  }
});

test('invalid IME commit rolls back its complete edit without leaking a draft', async () => {
  const f = fixture('12.3');
  f.input.setSelectionRange(1, 3, 'backward');
  f.fire('compositionstart');
  f.input.value = '1あ3';
  f.input.setSelectionRange(2, 2);
  f.fire('input', { inputType: 'insertCompositionText', isComposing: true });
  f.fire('compositionend', { data: 'あ' });
  f.fire('input', { inputType: 'insertCompositionText' });
  await Promise.resolve();
  assert.equal(f.input.value, '12.3');
  assert.equal(f.input.selectionStart, 1);
  assert.equal(f.input.selectionEnd, 3);
  assert.equal(f.input.selectionDirection, 'backward');
  assert.deepEqual(f.drafts, []);
  assert.deepEqual(f.rejected, []);
});

test('custom selectors work, unrelated fields pass through, and disposing removes restrictions', () => {
  const f = fixture('2', { selector: '#receive-amount, #send-amount' });
  assert.equal(f.edit('x').defaultPrevented, true);
  f.input.matches = () => false;
  assert.equal(f.edit('x').defaultPrevented, false);
  assert.deepEqual(f.drafts, ['2x']);
  f.input.matches = () => true;
  f.dispose();
  assert.equal(f.edit('y').defaultPrevented, false);
  assert.deepEqual(f.drafts, ['2x', '2xy']);
});
