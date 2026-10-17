import { formatConn } from './model.mjs';

// Presentation only: callers supply already-validated, confirmation-projected
// rows. Retain nodes by transaction ID, not server data or spending authority.
export function createHistoryRenderer(container) {
  const document = container.ownerDocument;
  let owner = null;
  const entries = new Map();
  return (nextOwner, items) => {
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    if (owner !== nextOwner) {
      container.replaceChildren(); entries.clear(); owner = nextOwner;
    }
    const present = new Set(items.map(item => item.txid));
    for (const [txid, entry] of entries) if (!present.has(txid)) {
      entry.row.remove(); entries.delete(txid);
    }
    // Advance a sibling cursor only when the current row is already in place.
    // Indexing the live children collection after each insertion/move can make
    // large initial renders and reordered histories repeatedly rebuild it.
    let position = container.firstElementChild;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      let entry = entries.get(item.txid);
      if (!entry) {
        const row = document.createElement('li'), button = document.createElement('button');
        button.type = 'button'; button.className = 'history-transaction'; button.dataset.txid = item.txid;
        button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-controls', 'transaction-details');
        const label = document.createElement('span'), amount = document.createElement('span');
        amount.className = 'amount';
        const status = document.createElement('span'); status.className = 'state';
        const txid = document.createElement('span'); txid.className = 'txid'; txid.textContent = item.txid;
        const hint = document.createElement('span'); hint.className = 'history-details-hint'; hint.textContent = 'View details ›';
        button.append(label, amount, status, hint, txid); row.append(button);
        entry = { row, label, amount, status }; entries.set(item.txid, entry);
      }
      if (entry.delta !== item.balance_delta) {
        const delta = BigInt(item.balance_delta);
        entry.label.textContent = delta < 0n ? 'Sent' : delta > 0n ? 'Received' : 'Transaction';
        entry.amount.textContent = `${formatConn(item.balance_delta)} CONN`;
        entry.delta = item.balance_delta;
      }
      const statusText = item.status === 'pending' ? 'Unconfirmed' : `${item.confirmations} confirmations`;
      if (entry.statusText !== statusText) { entry.status.textContent = statusText; entry.statusText = statusText; }
      // In the common unchanged-order case this performs no DOM writes at all.
      if (position === entry.row) position = position.nextElementSibling;
      else container.insertBefore(entry.row, position);
    }
    // Moving a surviving row can drop focus on older WebViews; never refocus a
    // removed row or a node belonging to the previous wallet.
    if (focused?.isConnected && container.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
  };
}
