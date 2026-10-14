/**
 * The line `php moat-gate.php install` prints for the project folder:
 * `moat gate add <name> --gate-id=… --box-key=…`. Pasted whole into the gate step, it fills
 * both fields. Only the two values are taken, as text; the server checks them (planGate).
 */
export function parseGateAddLine(
  text: string,
): { gateId: string; boxKey: string } | null {
  const gateId = /--gate-id=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  const boxKey = /--box-key=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  return gateId === undefined || boxKey === undefined
    ? null
    : { gateId, boxKey };
}
