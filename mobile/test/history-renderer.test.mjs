import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryRenderer } from '../src/history-renderer.mjs';

function fixture() {
  const document = { activeElement: null, writes: 0, indexedCollectionReads: 0 };
  class Element {
    constructor(tag) { this.tag = tag; this.ownerDocument = document; this.dataset = {}; this.nodes = []; this.parent = null; }
    get children() { document.indexedCollectionReads++; return this.nodes; }
    get firstElementChild() { return this.nodes[0] ?? null; }
    get nextElementSibling() { return this.parent?.nodes[this.parent.nodes.indexOf(this) + 1] ?? null; }
    get isConnected() { return this === document.body || this.parent?.isConnected === true; }
    get textContent() { return this.text ?? ''; }
    set textContent(value) { this.text = value; document.writes++; }
    setAttribute(name, value) { this[name] = value; document.writes++; }
    contains(other) { return other != null && (other === this || this.nodes.some(child => child.contains(other))); }
    append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
    insertBefore(node, before) {
      if (before !== null && !this.nodes.includes(before)) throw new Error('Cursor is not a current child');
      node.remove();
      const index = before === null ? this.nodes.length : this.nodes.indexOf(before);
      this.nodes.splice(index, 0, node); node.parent = this; document.writes++;
    }
    remove() {
      if (!this.parent) return;
      // Simulate a WebView which drops focus when a connected row is moved.
      if (this.contains(document.activeElement)) document.activeElement = null;
      this.parent.nodes.splice(this.parent.nodes.indexOf(this), 1); this.parent = null; document.writes++;
    }
    replaceChildren(...nodes) { for (const node of [...this.nodes]) node.remove(); this.append(...nodes); }
    focus() { if (this.isConnected) document.activeElement = this; }
  }
  document.createElement = tag => new Element(tag);
  document.body = new Element('body');
  const container = new Element('ul'); document.body.append(container);
  return { document, container, render: createHistoryRenderer(container),
    rows: () => new Map(container.nodes.map(node => [node.nodes[0].dataset.txid, node])) };
}
const row = id => ({ txid: String(id).padStart(64, '0'), status: 'confirmed', confirmations: 5, balance_delta: '10000000000' });

test('sibling reconciliation preserves exact order and surviving rows through insertion, removal and permutations', () => {
  const f = fixture(); let previous = new Map();
  for (const ids of [[1, 2, 3, 4], [4, 3, 2, 1], [2, 1, 4, 3], [0, 2, 1, 4, 3, 5], [2, 4, 5], [], [4, 2], [4, 2]]) {
    f.render('owner', ids.map(row));
    const current = f.rows();
    assert.deepEqual([...current.keys()], ids.map(id => row(id).txid));
    for (const [id, node] of current) if (previous.has(id)) assert.equal(node, previous.get(id));
    for (const [id, node] of previous) if (!current.has(id)) assert.equal(node.isConnected, false);
    previous = current;
  }
  const writes = f.document.writes;
  f.render('owner', [row(4), row(2)]);
  assert.equal(f.document.writes, writes);
  assert.equal(f.document.indexedCollectionReads, 0);
});

test('large reversed and deterministic permuted histories use only the sibling cursor', () => {
  const f = fixture(), rows = Array.from({ length: 2000 }, (_, index) => row(index));
  f.render('owner', rows); const original = f.rows();
  for (const reordered of [rows.toReversed(), [...rows.slice(997), ...rows.slice(0, 997)],
    rows.filter((_, index) => index % 2).concat(rows.filter((_, index) => index % 2 === 0)), rows]) {
    f.render('owner', reordered);
    assert.deepEqual([...f.rows().keys()], reordered.map(item => item.txid));
    for (const [id, node] of f.rows()) assert.equal(node, original.get(id));
  }
  assert.equal(f.document.indexedCollectionReads, 0);
});

test('moving a focused row restores focus but removal or owner replacement cannot refocus it', () => {
  const f = fixture(); f.render('owner', [row(1), row(2), row(3)]);
  const focusedRow = f.rows().get(row(3).txid), button = focusedRow.nodes[0]; button.focus();
  f.render('owner', [row(3), row(1), row(2)]);
  assert.equal(f.document.activeElement, button);
  f.render('owner', [row(2), row(3)]);
  assert.equal(f.document.activeElement, button);
  f.render('replacement', [row(2), row(3)]);
  assert.notEqual(f.rows().get(row(3).txid), focusedRow);
  assert.equal(focusedRow.isConnected, false); assert.notEqual(f.document.activeElement, button);
  const replacement = f.rows().get(row(3).txid); replacement.nodes[0].focus();
  f.render('replacement', [row(2)]);
  assert.equal(replacement.isConnected, false); assert.notEqual(f.document.activeElement, replacement.nodes[0]);
  f.render('', []); assert.equal(f.container.nodes.length, 0);
});

test('reordering still updates changed amounts and pending/confirmed labels on the retained nodes', () => {
  const f = fixture(); f.render('owner', [row(1), row(2)]); const original = f.rows();
  f.render('owner', [{ ...row(2), status: 'pending', confirmations: 0, balance_delta: '-1234567891' },
    { ...row(1), confirmations: 9, balance_delta: '0' }]);
  const second = f.rows().get(row(2).txid), first = f.rows().get(row(1).txid);
  assert.equal(second, original.get(row(2).txid)); assert.equal(first, original.get(row(1).txid));
  assert.deepEqual(second.nodes[0].nodes.slice(0, 3).map(node => node.textContent), ['Sent', '-0.1234567891 CONN', 'Unconfirmed']);
  assert.deepEqual(first.nodes[0].nodes.slice(0, 3).map(node => node.textContent), ['Transaction', '0 CONN', '9 confirmations']);
});
