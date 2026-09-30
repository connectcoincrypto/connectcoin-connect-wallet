// Editing text can keep a trailing separator while its value is already usable.
// Do not use parseFloat: malformed suffixes, fractions and precision must never
// be silently discarded. Backend parsers still receive canonical values.
export function numericInputValue(value) {
  return typeof value === 'string' && /^[0-9]+[.,]$/.test(value)
    ? value.slice(0, -1)
    : value;
}

// Text inputs preserve an unfinished decimal separator and the typing caret.
// Retain the former number-input integer/range constraints explicitly instead
// of losing min/max validation when switching away from type="number".
export function integerInputError(value, { min = '', max = '' } = {}) {
  const canonical = numericInputValue(value);
  if (canonical === '') return ''; // The control's required attribute handles it.
  if (typeof canonical !== 'string' || !/^[0-9]+$/.test(canonical)) return 'Enter a whole number.';
  const number = BigInt(canonical);
  if (min !== '' && number < BigInt(min)) return `Enter a number of at least ${min}.`;
  if (max !== '' && number > BigInt(max)) return `Enter a number no greater than ${max}.`;
  return '';
}
