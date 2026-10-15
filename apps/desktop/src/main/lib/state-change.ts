/**
 * Two settings the page can ask to change — «Schlüsselwechsel abgeschlossen» (SEC-08) and a gate's
 * passkey signing (trust mode 2) — are changed only after a message box of the main process (the
 * page may be compromised, T-59 style): `confirmed` shows the box and applies the change only on a
 * yes. The pure parts live here so they can be tested without Electron.
 */
export async function confirmed(
  ask: () => Promise<boolean>,
  apply: () => void,
): Promise<boolean> {
  if (!(await ask())) return false;
  apply();
  return true;
}

/**
 * The passkey gate list after turning a gate on or off, or null when nothing may change: turning
 * on needs a passkey; turning off is always possible. Sorted, without duplicates.
 */
export function passkeyGatesAfter(
  gates: readonly string[],
  key: string,
  on: boolean,
  hasPasskey: boolean,
): string[] | null {
  if (on && !hasPasskey) return null;
  const rest = gates.filter((known) => known !== key);
  return on ? [...rest, key].sort() : rest;
}
