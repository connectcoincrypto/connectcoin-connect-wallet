// Interruptions never acquire/release the busy state of the operation they
// interrupt. A stopped engine can still own a runtime session after an error.
export function nativeActionState(action, native, busy) {
  const interrupt = action === 'lock' || action === 'claimsStop';
  return { allowed: native && (!busy || interrupt), ownsBusy: !interrupt };
}

export function nativeControlState({ native, address, claims, locked, busy }) {
  const session = claims?.enabled === true || claims?.requested === true;
  return {
    startDisabled: !native || !address || session || busy,
    stopDisabled: !native || !session,
    lockDisabled: !native || (locked && !busy),
  };
}
