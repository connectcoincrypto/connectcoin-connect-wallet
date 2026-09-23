// Keep the live controls when an unlocked page receives background updates.
// In particular, number inputs have no selectionStart/setSelectionRange API:
// replacing them and restoring focus cannot preserve their native caret.
function sameKind(current, next) {
  if (current.nodeType !== next.nodeType) return false;
  if (current.nodeType !== 1) return true;
  return current.namespaceURI === next.namespaceURI && current.localName === next.localName &&
    current.id === next.id && current.getAttribute('data-render-key') === next.getAttribute('data-render-key') &&
    current.classList.item(0) === next.classList.item(0);
}

function patchElement(current, next) {
  // Inline errors are managed by showError/run, not by state snapshots. A
  // progress update must not silently dismiss an autosave error.
  if (current.id === 'view-error') return;
  const focused = current === current.ownerDocument.activeElement;
  const input = current.localName === 'input';
  const textarea = current.localName === 'textarea';
  const details = current.localName === 'details';
  const keepAttribute = name => (details && name === 'open') ||
    (focused && (input || textarea) && name === 'value');
  for (const attribute of Array.from(current.attributes)) {
    if (!keepAttribute(attribute.name) && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (!keepAttribute(attribute.name) && current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value);
    }
  }
  if (input || textarea) {
    // Avoid assigning even an equivalent value while typing: intermediate
    // numeric input (e.g. an exponent or a minus sign) can have an empty value.
    if (!focused && current.value !== next.value) current.value = next.value;
    if (input && current.checked !== next.checked) current.checked = next.checked;
    return;
  }
  reconcileChildren(current, next);
  if (current.localName === 'select' && current.value !== next.value) current.value = next.value;
}

export function reconcileChildren(current, next) {
  let cursor = current.firstChild;
  for (const desired of next.childNodes) {
    let match = cursor;
    while (match && !sameKind(match, desired)) match = match.nextSibling;
    if (!match) {
      current.insertBefore(desired.cloneNode(true), cursor);
      continue;
    }
    // The page's layout is stable; conditional notices can appear/disappear
    // before a form. Remove obsolete siblings, never detach/reinsert the form
    // or its ancestors (doing so would also reset focus and the numeric caret).
    while (cursor !== match) {
      const obsolete = cursor;
      cursor = cursor.nextSibling;
      obsolete.remove();
    }
    if (match.nodeType === 1) patchElement(match, desired);
    else if (match.nodeValue !== desired.nodeValue) match.nodeValue = desired.nodeValue;
    cursor = match.nextSibling;
  }
  while (cursor) {
    const obsolete = cursor;
    cursor = cursor.nextSibling;
    obsolete.remove();
  }
}
