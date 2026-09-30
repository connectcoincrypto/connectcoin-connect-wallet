function snapshot(input) {
  return {
    value: input.value,
    start: input.selectionStart ?? input.value.length,
    end: input.selectionEnd ?? input.value.length,
    direction: input.selectionDirection || 'none',
  };
}

function restore(input, saved) {
  if (input.value !== saved.value) input.value = saved.value;
  input.setSelectionRange(saved.start, saved.end, saved.direction);
}

function limitOf(input) {
  const text = input.dataset?.textLimit;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) return null;
  const limit = Number(text);
  return Number.isSafeInteger(limit) ? limit : null;
}

function fits(input, value) {
  const limit = limitOf(input);
  if (input.dataset.textCount === 'utf16') return value.length <= limit;
  let count = 0;
  for (const character of value) {
    if (++count > limit) return false;
  }
  return true;
}

function nativeText(input, text) {
  if (input.localName === 'textarea') return text.replace(/\r\n?/g, '\n');
  if (input.localName === 'input') return text.replace(/[\r\n]/g, '');
  return text;
}

function insertedValue(input, text) {
  const { value, start, end } = snapshot(input);
  // Predict the control's own newline handling without assigning or changing
  // the clipboard payload. Accepted insertion remains a native edit.
  return value.slice(0, start) + nativeText(input, text) + value.slice(end);
}

function transferSource(inputType) {
  if (inputType === 'insertFromPaste' || inputType === 'insertFromPasteAsQuotation') return 'paste';
  if (inputType === 'insertFromDrop' || inputType === 'deleteByDrag') return 'drop';
  return null;
}

/**
 * Enforce data-text-limit on delegated text controls. Count Unicode code points
 * by default, or UTF-16 units with data-text-count="utf16". Leave native
 * maxlength unset for code-point limits: it would truncate Unicode input first.
 * Only rejected paste/drop operations notify onReject({ input, source, limit });
 * no rejected text is included. The disposer has sync() for rendered values.
 */
export function installTextInputRestrictions(document, {
  selector = '[data-text-limit]', onReject,
} = {}) {
  const accepted = new WeakMap();
  const compositions = new WeakMap();
  const reported = new WeakMap();
  const listeners = [];
  let disposed = false;
  const textInput = target => target?.matches?.(selector) && !target.disabled && !target.readOnly &&
    typeof target.value === 'string' && typeof target.setSelectionRange === 'function' && limitOf(target) !== null ? target : null;
  const remember = input => {
    if (!compositions.has(input) && fits(input, input.value)) accepted.set(input, snapshot(input));
  };
  const previous = input => {
    if (accepted.has(input)) return accepted.get(input);
    const fallback = input.defaultValue ?? '';
    const value = fits(input, fallback) ? fallback : '';
    return { value, start: value.length, end: value.length, direction: 'none' };
  };
  const reject = (input, source) => {
    if (!source || !onReject || reported.has(input)) return;
    const token = {};
    reported.set(input, token);
    queueMicrotask(() => { if (reported.get(input) === token) reported.delete(input); });
    onReject({ input, source, limit: limitOf(input) });
  };
  const emitInput = input => {
    const view = document.defaultView;
    const event = view.InputEvent
      ? new view.InputEvent('input', { bubbles: true, inputType: 'insertFromComposition' })
      : new view.Event('input', { bubbles: true });
    input.dispatchEvent(event);
  };
  const listen = (type, handler) => {
    document.addEventListener(type, handler, true);
    listeners.push([type, handler]);
  };
  for (const type of ['focusin', 'keydown', 'pointerdown']) {
    listen(type, event => {
      const input = textInput(event.target);
      if (input) remember(input);
    });
  }
  listen('selectionchange', () => {
    const input = textInput(document.activeElement);
    if (input) remember(input);
  });
  listen('beforeinput', event => {
    const input = textInput(event.target);
    if (!input || event.defaultPrevented || event.isComposing || compositions.has(input)) return;
    remember(input);
    const source = transferSource(event.inputType);
    if (source === 'drop') {
      event.preventDefault();
      reject(input, source);
      return;
    }
    let text;
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') text = '\n';
    else if (event.inputType?.startsWith('insert')) text = event.data ?? event.dataTransfer?.getData('text/plain');
    // Deletion, undo, and replacement without data stay native. The resulting
    // input is checked before any application draft handler can observe it.
    if (typeof text === 'string' && !fits(input, insertedValue(input, text))) {
      event.preventDefault();
      reject(input, source);
    }
  });
  listen('paste', event => {
    const input = textInput(event.target);
    if (!input || event.defaultPrevented) return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text || !nativeText(input, text) || compositions.has(input)) {
      event.preventDefault();
      return;
    }
    remember(input);
    if (!fits(input, insertedValue(input, text))) {
      event.preventDefault();
      reject(input, 'paste');
    }
  });
  listen('drop', event => {
    const input = textInput(event.target);
    if (!input || event.defaultPrevented) return;
    // A drop can move selected text and chooses a caret independently. Reject
    // the entire operation rather than interpret its position as a paste.
    event.preventDefault();
    reject(input, 'drop');
  });
  listen('input', event => {
    const input = textInput(event.target);
    if (!input) return;
    const source = transferSource(event.inputType);
    if (source === 'drop') {
      restore(input, previous(input));
      event.stopImmediatePropagation();
      reject(input, source);
      return;
    }
    const composition = compositions.get(input);
    if (composition?.active || (!composition && event.isComposing)) {
      // Keep transient IME text/caret intact without letting a draft update
      // trigger a render before composition has committed.
      event.stopImmediatePropagation();
      return;
    }
    if (composition) {
      compositions.delete(input);
      if (!composition.valid) {
        restore(input, composition.before);
        event.stopImmediatePropagation();
        return;
      }
    }
    if (fits(input, input.value)) accepted.set(input, snapshot(input));
    else {
      restore(input, previous(input));
      event.stopImmediatePropagation();
      reject(input, source);
    }
  });
  listen('compositionstart', event => {
    const input = textInput(event.target);
    if (!input) return;
    remember(input);
    compositions.set(input, { active: true, before: previous(input) });
  });
  listen('compositionend', event => {
    const input = textInput(event.target);
    if (!input) return;
    const composition = compositions.get(input) ?? { before: previous(input) };
    composition.active = false;
    composition.valid = fits(input, input.value);
    if (composition.valid) accepted.set(input, snapshot(input));
    else restore(input, composition.before);
    compositions.set(input, composition);
    // Give native final input the chance to publish first. Otherwise publish
    // after compositionend has reached the application's composition handler.
    queueMicrotask(() => {
      if (disposed || compositions.get(input) !== composition) return;
      compositions.delete(input);
      if (composition.valid && input.value !== composition.before.value) emitInput(input);
    });
  });
  const dispose = () => {
    disposed = true;
    for (const [type, handler] of listeners) document.removeEventListener(type, handler, true);
  };
  dispose.sync = () => {
    for (const input of document.querySelectorAll(selector)) if (textInput(input)) remember(input);
  };
  dispose.sync();
  return dispose;
}
