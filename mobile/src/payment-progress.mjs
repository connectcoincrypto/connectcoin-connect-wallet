// Progress is informational only; native review remains the authority for funds.
export function paymentProgressText(event, { operation, address, busy, active }) {
  if (!busy || !active || !['reviewPayment', 'reviewP2C'].includes(operation) ||
      !event || event.operation !== operation || event.address !== address ||
      !['outputs', 'funding', 'waiting', 'signing', 'broadcasting'].includes(event.stage)) return '';
  if (![event.completed, event.total].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 50000) ||
      event.total > 0 && event.completed > event.total ||
      !Number.isSafeInteger(event.retryAfterMs) || event.retryAfterMs < 0 || event.retryAfterMs > 900000) return '';
  const count = event.total ? `${event.completed} / ${event.total}` : String(event.completed);
  if (event.stage === 'signing' || event.stage === 'broadcasting') {
    if (operation !== 'reviewPayment' || event.total < 2 || event.total > 32) return '';
    return event.stage === 'signing'
      ? `Signing the approved payment… ${count} transactions. Nothing has been submitted yet.`
      : `Submitting the approved payment… ${count} transactions processed. Some parts may already be sent. Check the payment result before making another payment.`;
  }
  const status = event.stage === 'outputs' ? `Checking spendable outputs… ${count} checked.`
    : event.stage === 'funding' ? `Verifying funding transactions… ${count}.`
    : `Waiting for the server's request limit (about ${Math.max(1, Math.ceil(event.retryAfterMs / 1000))} seconds)… ${count} checked.`;
  return `${status} You can cancel with Lock. Nothing is sent until you confirm.`;
}
