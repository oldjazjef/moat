/**
 * Key rotation in Moat Desktop (SEC-08, gates/php/README.md "Key rotation"): when another signing
 * key replaces the current one, the desktop remembers the old public key until the person says
 * every gate pins the new key alone. The gates are changed only on their own servers (`trust`).
 */
export function previousKeyAfter(
  /** The public key of the key used so far; null when there was none or it is unreadable. */
  current: string | null,
  /** The rotation still open, if any. */
  previous: string | null,
  /** The public key of the key chosen or created now. */
  next: string,
): string | null {
  // Choosing the same key again changes nothing; going back to the old key ends the rotation.
  if (current === next) return previous;
  if (previous === next) return null;
  // A rotation in the middle of another keeps the oldest key: the gates may still pin it.
  return previous ?? current;
}
