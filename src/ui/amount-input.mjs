// These are editing rules, not monetary validation: empty values, zero, and a
// trailing decimal point are useful while typing. The service validates payment
// amounts when they are submitted.
export function normalizeAmountInput(value, { maxIntegerDigits = 9, maxFractionDigits = 10 } = {}) {
  // Check every character, including terminal line separators, without relying
  // on a regular-expression end anchor or truncating the supplied amount.
  if (typeof value !== 'string' || /[^0-9.,]/.test(value)) return null;
  if (value === '') return '';
  const parts = value.split(/[.,]/);
  if (parts.length > 2) return null;
  const [whole, fraction] = parts;
  const integer = whole.replace(/^0+(?=\d)/, '') || '0';
  if (integer.length > maxIntegerDigits || (fraction?.length ?? 0) > maxFractionDigits) return null;
  return integer + (fraction === undefined ? '' : `.${fraction}`);
}

function rulesFor(input) {
  if (input.dataset?.numeric !== 'integer') return undefined;
  const digits = Number(input.dataset.integerDigits ?? 9);
  return { maxFractionDigits: 0, maxIntegerDigits: Number.isSafeInteger(digits) && digits > 0 ? digits : 9 };
}

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

function normalizedSnapshot(saved, value) {
  const originalInteger = saved.value.split(/[.,]/)[0];
  const integer = value.split('.')[0];
  const shift = integer.length - originalInteger.length;
  const position = offset => Math.max(0, Math.min(value.length, offset + shift));
  return { value, start: position(saved.start), end: position(saved.end), direction: saved.direction };
}

function transferSource(inputType) {
  if (inputType === 'insertFromPaste' || inputType === 'insertFromPasteAsQuotation') return 'paste';
  if (inputType === 'insertFromDrop') return 'drop';
  return null;
}

function proposedEdit(input, event) {
  const { value, start, end } = snapshot(input);
  const type = event.inputType || '';
  if (type.startsWith('insert')) {
    const text = event.data ?? event.dataTransfer?.getData('text/plain');
    if (typeof text === 'string') return value.slice(0, start) + text + value.slice(end);
    if (type === 'insertLineBreak' || type === 'insertParagraph') return value + '\n';
  }
  if (type.startsWith('delete')) {
    if (start !== end) return value.slice(0, start) + value.slice(end);
    if (type === 'deleteContentBackward') return value.slice(0, Math.max(0, start - 1)) + value.slice(end);
    if (type === 'deleteContentForward') return value.slice(0, start) + value.slice(end + 1);
  }
  // Undo, replacement text without data, and platform-specific deletion remain
  // native operations. The capture-phase input handler checks their result.
  return null;
}

/**
 * Delegate restrictions so newly rendered controls work automatically. Rejected
 * paste/drop edits call onReject({ input, source, attemptedValue }); ordinary
 * rejected keystrokes remain quiet. The returned disposer also has sync(), for
 * callers to refresh rollback values after assigning input values during render.
 * Inputs with data-numeric="integer" keep a trailing decimal separator for
 * editing but reject fractional digits. data-integer-digits overrides their
 * default nine-digit limit without converting the field value to a Number.
 */
export function installAmountInputRestrictions(document, {
  selector = 'input[data-amount]', onReject,
} = {}) {
  const accepted = new WeakMap();
  const compositions = new WeakMap();
  const nativeEdits = new WeakSet();
  const reported = new WeakMap();
  const listeners = [];
  let disposed = false;
  const amountInput = target => target?.matches?.(selector) && !target.disabled && !target.readOnly ? target : null;
  const normalize = (input, value = input.value) => normalizeAmountInput(value, rulesFor(input));
  const remember = input => {
    if (!compositions.has(input) && normalize(input) !== null) accepted.set(input, snapshot(input));
  };
  const previous = input => {
    if (accepted.has(input)) return accepted.get(input);
    const value = normalize(input, input.defaultValue ?? '') ?? '';
    return { value, start: value.length, end: value.length, direction: 'none' };
  };
  const reject = (input, source, attemptedValue) => {
    if (!source || !onReject || reported.has(input)) return;
    const token = {};
    reported.set(input, token);
    queueMicrotask(() => { if (reported.get(input) === token) reported.delete(input); });
    onReject({ input, source, attemptedValue });
  };
  const emitInput = (input, inputType, data = null) => {
    const view = document.defaultView;
    const event = view?.InputEvent
      ? new view.InputEvent('input', { bubbles: true, inputType, data })
      : new view.Event('input', { bubbles: true });
    input.dispatchEvent(event);
  };
  const normalizeCurrent = input => {
    const value = normalize(input);
    if (value === null) return false;
    if (value !== input.value) restore(input, normalizedSnapshot(snapshot(input), value));
    accepted.set(input, snapshot(input));
    return true;
  };
  const listen = (type, handler) => {
    document.addEventListener(type, handler, true);
    listeners.push([type, handler]);
  };
  for (const type of ['focusin', 'keydown', 'pointerdown']) {
    listen(type, event => {
      const input = amountInput(event.target);
      if (input) remember(input);
    });
  }
  listen('selectionchange', () => {
    const input = amountInput(document.activeElement);
    if (input) remember(input);
  });
  listen('beforeinput', event => {
    const input = amountInput(event.target);
    if (!input || event.defaultPrevented || event.isComposing || compositions.has(input)) return;
    remember(input);
    if (event.inputType === 'insertFromDrop' || event.inputType === 'deleteByDrag') {
      event.preventDefault();
      reject(input, 'drop', event.data ?? '');
      return;
    }
    const candidate = proposedEdit(input, event);
    if (candidate !== null && normalize(input, candidate) === null) {
      event.preventDefault();
      reject(input, transferSource(event.inputType), candidate);
    }
  });
  listen('drop', event => {
    const input = amountInput(event.target);
    if (!input || event.defaultPrevented) return;
    // A drop's caret and same-field move semantics differ from the selection.
    // Do not guess an insertion position for a monetary amount.
    event.preventDefault();
    reject(input, 'drop', event.dataTransfer?.getData('text/plain') ?? '');
  });
  listen('paste', event => {
    const input = amountInput(event.target);
    if (!input || event.defaultPrevented) return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text || compositions.has(input)) {
      event.preventDefault();
      return;
    }
    remember(input);
    const saved = snapshot(input);
    const candidate = saved.value.slice(0, saved.start) + text + saved.value.slice(saved.end);
    const value = normalize(input, candidate);
    if (value === null) {
      event.preventDefault();
      reject(input, 'paste', candidate);
      return;
    }
    // Keep ordinary paste native, including its undo history and selection.
    if (value === candidate) return;
    event.preventDefault();
    const caret = saved.start + text.length;
    const desired = normalizedSnapshot({ value: candidate, start: caret, end: caret, direction: 'none' }, value);
    // Chromium's editing command preserves native undo for normalized pastes.
    // Hold its input event until the whole result and intended caret are ready.
    if (document.activeElement === input && typeof document.execCommand === 'function') {
      nativeEdits.add(input);
      try {
        input.setSelectionRange(0, saved.value.length);
        document.execCommand('insertText', false, value);
      } catch { /* Fall back to the already validated complete value below. */ }
      finally { nativeEdits.delete(input); }
    }
    restore(input, desired);
    accepted.set(input, snapshot(input));
    emitInput(input, 'insertFromPaste', text);
  });
  listen('input', event => {
    const input = amountInput(event.target);
    if (!input) return;
    if (nativeEdits.has(input)) {
      event.stopImmediatePropagation();
      return;
    }
    if (event.inputType === 'insertFromDrop' || event.inputType === 'deleteByDrag') {
      const attemptedValue = input.value;
      restore(input, previous(input));
      event.stopImmediatePropagation();
      reject(input, 'drop', attemptedValue);
      return;
    }
    const composition = compositions.get(input);
    if (composition?.active || (!composition && event.isComposing)) {
      // Keep the IME's transient text/caret, but never publish it as a draft or
      // let an application rerender destroy the active composition.
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
    const attemptedValue = input.value;
    if (!normalizeCurrent(input)) {
      restore(input, previous(input));
      event.stopImmediatePropagation();
      reject(input, transferSource(event.inputType), attemptedValue);
    }
  });
  listen('compositionstart', event => {
    const input = amountInput(event.target);
    if (!input) return;
    remember(input);
    compositions.set(input, { active: true, before: previous(input) });
  });
  listen('compositionend', event => {
    const input = amountInput(event.target);
    if (!input) return;
    const composition = compositions.get(input) ?? { before: previous(input) };
    composition.active = false;
    composition.valid = normalizeCurrent(input);
    if (!composition.valid) restore(input, composition.before);
    compositions.set(input, composition);
    // Browsers disagree about whether a final input follows compositionend.
    // Publish once, after compositionend has reached the application's handler.
    queueMicrotask(() => {
      if (disposed || compositions.get(input) !== composition) return;
      compositions.delete(input);
      if (composition.valid && input.value !== composition.before.value) {
        emitInput(input, 'insertFromComposition', event.data ?? null);
      }
    });
  });
  const dispose = () => {
    disposed = true;
    for (const [type, handler] of listeners) document.removeEventListener(type, handler, true);
  };
  dispose.sync = () => {
    for (const input of document.querySelectorAll(selector)) if (amountInput(input)) remember(input);
  };
  dispose.sync();
  return dispose;
}
