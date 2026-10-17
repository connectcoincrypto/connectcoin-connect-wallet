import { formatConn } from './model.mjs';

// History is already validated by WalletSession. Keep only its identity here:
// confirmations, pending status and amounts must follow the current snapshot.
// This view never queries RPC, signs a transaction or infers a fee from net flow.
export function createTransactionDetails({ document, readState, canOpenExplorer, openExplorer }) {
  const $ = id => document.getElementById(id);
  const dialog = $('transaction-details');
  let selected = null, opening = false;
  // At most three inputs for already-formatted text, never a history row or
  // spending authority.
  // A changed value must pass formatConn again; each render/action still reads
  // the current owner, row, confirmations and stale/permission state below.
  const amounts = new Map();

  function close({ restoreFocus = true } = {}) {
    const previous = selected;
    selected = null;
    amounts.clear();
    if (dialog.open) dialog.close();
    $('transaction-explorer-error').textContent = '';
    if (restoreFocus && previous) {
      const row = [...$('history').querySelectorAll('button[data-txid]')]
        .find(button => button.dataset.txid === previous.txid);
      (row ?? $('activity-title')).focus({ preventScroll: true });
    }
  }

  function render(frameState) {
    if (!selected) return;
    // The app can supply its already-projected synchronous render snapshot.
    // Do not retain it: asynchronous completions must reread the current owner.
    const state = frameState ?? readState();
    const item = state.address === selected.address && state.history.find(row => row.txid === selected.txid);
    if (!item) { close({ restoreFocus: state.address === selected.address }); return; }
    $('transaction-id').textContent = item.txid;
    const hd = state.scope === 'hd';
    $('transaction-address').textContent = hd ? item.addresses.join('\n') : state.address;
    $('transaction-received-label').textContent = hd ? 'Received by this wallet' : 'Received by this address';
    $('transaction-spent-label').textContent = hd ? 'Spent from this wallet' : 'Spent from this address';
    $('transaction-address-label').textContent = hd ? 'Involved wallet addresses' : 'Wallet address';
    $('transaction-scope-note').textContent = hd ? "Amounts combine this wallet's addresses. Received includes change and transfers between your addresses; net change is not necessarily the transaction fee."
      : "Amounts show this address's part of the transaction. Received includes any change returned to it; net change is not the transaction fee.";
    $('transaction-status').textContent = item.status === 'pending' ? 'Unconfirmed' : 'Confirmed';
    $('transaction-confirmations').textContent = item.confirmations.toLocaleString('en-US');
    $('transaction-block').hidden = item.status === 'pending';
    $('transaction-block-height').textContent = item.block_height === null ? '' : item.block_height.toLocaleString('en-US');
    $('transaction-block-hash').textContent = item.block_hash ?? '';
    for (const [id, field] of [['received', 'received'], ['spent', 'spent'], ['net', 'balance_delta']]) {
      const value = item[field];
      if (!amounts.has(field) || amounts.get(field) !== value) {
        // Record only successfully formatted values: malformed changed input
        // must keep failing instead of becoming a cached display value.
        const text = `${formatConn(value)} CONN`;
        $('transaction-' + id).textContent = text;
        amounts.set(field, value);
      }
    }
    $('transaction-stale').hidden = !(state.stale || state.historyStale || state.confirmationsStale);
    $('transaction-open-explorer').disabled = opening || !canOpenExplorer();
    $('transaction-open-explorer').textContent = opening ? 'Opening explorer…' : 'Open in explorer ↗';
  }

  function open(txid) {
    const state = readState();
    if (!state.address || !state.history.some(row => row.txid === txid)) return;
    selected = { address: state.address, txid };
    amounts.clear();
    $('transaction-explorer-error').textContent = '';
    render(state);
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop = 0;
  }

  $('transaction-close').addEventListener('click', () => close());
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  // Handle a platform-driven dismissal too, but not an old queued close event
  // that arrives after a different transaction has already been opened.
  dialog.addEventListener('close', () => { if (!dialog.open) close(); });
  $('transaction-open-explorer').addEventListener('click', async () => {
    if (!selected || opening || !canOpenExplorer()) return;
    const expected = selected;
    const state = readState();
    if (state.address !== expected.address || !state.history.some(row => row.txid === expected.txid)) { close(); return; }
    opening = true;
    $('transaction-explorer-error').textContent = '';
    render(state);
    try {
      // The native bridge accepts only a txid and constructs its own fixed
      // HTTPS mainnet explorer URL. No server-supplied URL is ever launched.
      await openExplorer(expected.txid);
    } catch {
      if (selected === expected) $('transaction-explorer-error').textContent = 'Could not open the explorer. Check that a browser is installed and try again.';
    } finally { opening = false; render(); }
  });
  return { open, close, render, isOpen: () => dialog.open };
}
