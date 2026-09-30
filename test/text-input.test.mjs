import test from 'node:test';
import assert from 'node:assert/strict';
import { installTextInputRestrictions } from '../src/ui/text-input.mjs';

class FakeEvent {
  constructor(type, options = {}) { Object.assign(this, { type, cancelable: false, defaultPrevented: false }, options); }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopImmediatePropagation() { this.stopped = true; }
}

function fixture(value = '', { limit = 100, count, selector = '[data-text-limit]', tag = 'input' } = {}) {
  const listeners = [], drafts = [], rejected = [];
  const inputs = [];
  const document = {
    activeElement: null,
    defaultView: { Event: FakeEvent, InputEvent: FakeEvent },
    addEventListener(type, handler, capture = false) { listeners.push({ type, handler, capture }); },
    removeEventListener(type, handler) {
      const index = listeners.findIndex(item => item.type === type && item.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    querySelectorAll() { return inputs; },
  };
  const addInput = value => {
    const input = {
      value, defaultValue: value,
      localName: tag,
      dataset: { textLimit: String(limit), ...(count ? { textCount: count } : {}) },
      selectionStart: value.length, selectionEnd: value.length, selectionDirection: 'none',
      matches: expected => expected === selector,
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
    inputs.push(input);
    return input;
  };
  const input = addInput(value);
  document.activeElement = input;
  document.addEventListener('input', event => drafts.push(event.target.value));
  const dispose = installTextInputRestrictions(document, { selector, onReject: rejection => rejected.push(rejection) });
  const fire = (type, details = {}, target = input) => {
    const event = new FakeEvent(type, { cancelable: true, ...details });
    target.dispatchEvent(event);
    return event;
  };
  const edit = (text, details = {}) => {
    const inputType = details.inputType ?? 'insertText';
    const event = fire('beforeinput', { data: text, inputType, ...details });
    if (!event.defaultPrevented) {
      const start = input.selectionStart, end = input.selectionEnd;
      const nativeText = tag === 'textarea' ? text.replace(/\r\n?/g, '\n') : text.replace(/[\r\n]/g, '');
      input.value = input.value.slice(0, start) + nativeText + input.value.slice(end);
      input.setSelectionRange(start + nativeText.length, start + nativeText.length);
      fire('input', { data: text, inputType, ...details });
    }
    return event;
  };
  const paste = text => {
    const event = fire('paste', { clipboardData: { getData: type => type === 'text/plain' ? text : '' } });
    if (!event.defaultPrevented) edit(text, { inputType: 'insertFromPaste' });
    return event;
  };
  return { input, document, drafts, rejected, fire, edit, paste, addInput, dispose };
}

test('the default 100-character limit accepts 100 emoji code points, not only 50', () => {
  const f = fixture();
  const exact = '😀'.repeat(100);
  assert.equal(f.paste(exact).defaultPrevented, false);
  assert.equal(f.input.value, exact);
  assert.equal(f.input.selectionStart, 200);
  assert.equal(f.edit('😀').defaultPrevented, true);
  assert.equal(f.input.value, exact);
  assert.deepEqual(f.drafts, [exact]);
  assert.deepEqual(f.rejected, []);
});

test('optional utf16 limits count code units without splitting or truncating a paste', () => {
  const f = fixture('', { limit: 4, count: 'utf16' });
  assert.equal(f.paste('😀😀').defaultPrevented, false);
  f.input.setSelectionRange(0, 4, 'backward');
  assert.equal(f.paste('😀😀a').defaultPrevented, true);
  assert.equal(f.input.value, '😀😀');
  assert.equal(f.input.selectionStart, 0);
  assert.equal(f.input.selectionEnd, 4);
  assert.equal(f.input.selectionDirection, 'backward');
});

test('multiline input counts newlines and keeps native line-break editing', () => {
  const f = fixture('', { limit: 7, tag: 'textarea' });
  assert.equal(f.paste('one\ntwo').defaultPrevented, false);
  assert.equal(f.input.value, 'one\ntwo');
  assert.equal(f.fire('beforeinput', { inputType: 'insertLineBreak', data: null }).defaultPrevented, true);
  f.input.setSelectionRange(3, 4);
  assert.equal(f.fire('beforeinput', { inputType: 'insertParagraph', data: null }).defaultPrevented, false);
  assert.deepEqual(f.drafts, ['one\ntwo']);
});

test('paste length prediction follows textarea and single-line native newline behavior', () => {
  for (const lineBreak of ['\r\n', '\r', '\n']) {
    const multiline = fixture('', { limit: 3, tag: 'textarea' });
    assert.equal(multiline.paste(`a${lineBreak}b`).defaultPrevented, false);
    assert.equal(multiline.input.value, 'a\nb');
    assert.equal(multiline.input.selectionStart, 3);
    const singleLine = fixture('', { limit: 2 });
    assert.equal(singleLine.paste(`a${lineBreak}b`).defaultPrevented, false);
    assert.equal(singleLine.input.value, 'ab');
    assert.equal(singleLine.input.selectionStart, 2);
    singleLine.input.setSelectionRange(0, 2, 'backward');
    assert.equal(singleLine.paste(lineBreak).defaultPrevented, true);
    assert.equal(singleLine.input.value, 'ab');
    assert.equal(singleLine.input.selectionStart, 0);
    assert.equal(singleLine.input.selectionEnd, 2);
    assert.equal(singleLine.input.selectionDirection, 'backward');
  }
});

test('selection replacement uses UTF-16 caret offsets while enforcing code-point length', () => {
  const f = fixture('a😀b', { limit: 3 });
  f.input.setSelectionRange(1, 3, 'backward');
  assert.equal(f.edit('🚀').defaultPrevented, false);
  assert.equal(f.input.value, 'a🚀b');
  assert.equal(f.input.selectionStart, 3);
  f.input.setSelectionRange(1, 3, 'backward');
  assert.equal(f.paste('XY').defaultPrevented, true);
  assert.equal(f.input.value, 'a🚀b');
  assert.equal(f.input.selectionStart, 1);
  assert.equal(f.input.selectionEnd, 3);
  assert.equal(f.input.selectionDirection, 'backward');
});

test('overlimit paste rejects the complete edit with metadata-only feedback', () => {
  const f = fixture('kept', { limit: 8 });
  f.input.setSelectionRange(0, 4, 'backward');
  assert.equal(f.paste('private oversized content').defaultPrevented, true);
  assert.equal(f.input.value, 'kept');
  assert.equal(f.input.selectionStart, 0);
  assert.equal(f.input.selectionEnd, 4);
  assert.equal(f.input.selectionDirection, 'backward');
  assert.deepEqual(f.drafts, []);
  assert.deepEqual(Object.keys(f.rejected[0]).sort(), ['input', 'limit', 'source']);
  assert.equal(f.rejected[0].input, f.input);
  assert.equal(f.rejected[0].source, 'paste');
  assert.equal(f.rejected[0].limit, 8);
});

test('valid paste and undo remain native with no synthesized extra draft events', () => {
  const f = fixture('old', { limit: 10 });
  f.input.setSelectionRange(0, 3);
  assert.equal(f.paste('new text').defaultPrevented, false);
  assert.deepEqual(f.drafts, ['new text']);
  assert.equal(f.fire('beforeinput', { inputType: 'historyUndo' }).defaultPrevented, false);
  f.input.value = 'old';
  f.input.setSelectionRange(0, 3);
  f.fire('input', { inputType: 'historyUndo' });
  assert.deepEqual(f.drafts, ['new text', 'old']);
});

test('empty, missing, or nontext clipboard data cannot delete the selected text', () => {
  for (const clipboardData of [undefined, { getData: () => '' }, { types: ['text/html'], getData: () => '' }]) {
    const f = fixture('keep');
    f.input.setSelectionRange(0, 4, 'backward');
    assert.equal(f.fire('paste', { clipboardData }).defaultPrevented, true);
    assert.equal(f.input.value, 'keep');
    assert.equal(f.input.selectionStart, 0);
    assert.equal(f.input.selectionEnd, 4);
    assert.equal(f.input.selectionDirection, 'backward');
    assert.deepEqual(f.drafts, []);
    assert.deepEqual(f.rejected, []);
  }
});

test('drop and same-field drag deletion are blocked without modifying the selection', () => {
  const f = fixture('keep');
  f.input.setSelectionRange(1, 3, 'backward');
  assert.equal(f.fire('drop', { dataTransfer: { getData: () => 'x' } }).defaultPrevented, true);
  assert.equal(f.fire('beforeinput', { inputType: 'deleteByDrag' }).defaultPrevented, true);
  assert.equal(f.edit('x', { inputType: 'insertFromDrop' }).defaultPrevented, true);
  f.edit('x', { inputType: 'insertFromDrop', cancelable: false });
  assert.equal(f.input.value, 'keep');
  assert.equal(f.input.selectionStart, 1);
  assert.equal(f.input.selectionEnd, 3);
  assert.equal(f.input.selectionDirection, 'backward');
  assert.deepEqual(f.drafts, []);
  assert.deepEqual(Object.keys(f.rejected[0]).sort(), ['input', 'limit', 'source']);
  assert.equal(f.rejected[0].source, 'drop');
});

test('deletion, navigation, and select-all controls stay native at the length limit', () => {
  const f = fixture('full', { limit: 4 });
  for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'a']) {
    assert.equal(f.fire('keydown', { key, ctrlKey: key === 'a' }).defaultPrevented, false);
  }
  for (const inputType of ['deleteContentBackward', 'deleteContentForward', 'deleteWordBackward', 'deleteByCut']) {
    assert.equal(f.fire('beforeinput', { inputType }).defaultPrevented, false);
  }
  f.input.value = 'ful';
  f.input.setSelectionRange(3, 3);
  f.fire('input', { inputType: 'deleteContentBackward' });
  assert.equal(f.edit('l').defaultPrevented, false);
  assert.deepEqual(f.drafts, ['ful', 'full']);
});

test('uncancelable and input-only overflow restore the full pre-edit value and selection', () => {
  const f = fixture('keep', { limit: 4 });
  f.input.setSelectionRange(1, 3, 'backward');
  f.edit('oversized', { cancelable: false });
  assert.equal(f.input.value, 'keep');
  assert.equal(f.input.selectionStart, 1);
  assert.equal(f.input.selectionEnd, 3);
  assert.equal(f.input.selectionDirection, 'backward');
  f.input.value = 'too long';
  const event = f.fire('input', { inputType: 'insertReplacementText' });
  assert.equal(event.stopped, true);
  assert.equal(f.input.value, 'keep');
  assert.deepEqual(f.drafts, []);
});

test('render sync updates rollback snapshots and delegates to newly rendered controls', () => {
  const f = fixture('old', { limit: 4 });
  f.input.value = 'new';
  f.input.setSelectionRange(0, 3, 'backward');
  f.dispose.sync();
  f.input.value = 'overflow';
  f.fire('input');
  assert.equal(f.input.value, 'new');
  assert.equal(f.input.selectionStart, 0);
  assert.equal(f.input.selectionEnd, 3);
  const fresh = f.addInput('😀😀');
  f.dispose.sync();
  fresh.value = '😀'.repeat(5);
  f.fire('input', {}, fresh);
  assert.equal(fresh.value, '😀😀');
  assert.equal(fresh.selectionStart, 4);
  assert.deepEqual(f.drafts, []);
});

test('IME keeps transient text out of the draft and publishes a valid commit exactly once', async () => {
  for (const nativeFinalInput of [false, true]) {
    const f = fixture('a', { limit: 2 });
    f.fire('compositionstart');
    f.input.value = 'transient composition';
    f.input.setSelectionRange(21, 21);
    f.fire('input', { inputType: 'insertCompositionText', isComposing: true });
    assert.equal(f.input.value, 'transient composition');
    assert.deepEqual(f.drafts, []);
    f.dispose.sync();
    f.input.value = 'a😀';
    f.input.setSelectionRange(3, 3);
    f.fire('compositionend');
    if (nativeFinalInput) f.fire('input', { inputType: 'insertCompositionText' });
    await Promise.resolve();
    assert.equal(f.input.value, 'a😀');
    assert.deepEqual(f.drafts, ['a😀']);
  }
});

test('overlimit IME commit restores its starting selection without a draft or render race', async () => {
  for (const nativeFinalInput of [false, true]) {
    const f = fixture('keep', { limit: 4 });
    f.input.setSelectionRange(1, 3, 'backward');
    f.fire('compositionstart');
    f.input.value = 'overflow';
    f.input.setSelectionRange(8, 8);
    f.fire('input', { inputType: 'insertCompositionText', isComposing: true });
    f.dispose.sync();
    f.fire('compositionend');
    if (nativeFinalInput) f.fire('input', { inputType: 'insertCompositionText' });
    await Promise.resolve();
    assert.equal(f.input.value, 'keep');
    assert.equal(f.input.selectionStart, 1);
    assert.equal(f.input.selectionEnd, 3);
    assert.equal(f.input.selectionDirection, 'backward');
    assert.deepEqual(f.drafts, []);
    assert.deepEqual(f.rejected, []);
  }
});

test('custom selector, zero limit, unrelated controls, and cleanup remain scoped', async () => {
  const f = fixture('', { limit: 0, selector: '#public-note' });
  assert.equal(f.edit('a').defaultPrevented, true);
  f.input.matches = () => false;
  assert.equal(f.edit('a').defaultPrevented, false);
  assert.deepEqual(f.drafts, ['a']);
  f.input.matches = () => true;
  f.dispose();
  assert.equal(f.edit('b').defaultPrevented, false);
  assert.deepEqual(f.drafts, ['a', 'ab']);
  const pending = fixture('', { limit: 2 });
  pending.fire('compositionstart');
  pending.input.value = 'ok';
  pending.fire('compositionend');
  pending.dispose();
  await Promise.resolve();
  assert.deepEqual(pending.drafts, [], 'cleanup must also cancel queued composition publication');
});
