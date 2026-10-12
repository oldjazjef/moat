/** A window length for display: the largest whole unit (`600` → 10 min, `86400` → 1 d). */
export function durationParts(seconds: number): {
  readonly value: number;
  readonly unitKey: string;
} {
  if (seconds % 86_400 === 0)
    return { value: seconds / 86_400, unitKey: 'units.days' };
  if (seconds % 3_600 === 0)
    return { value: seconds / 3_600, unitKey: 'units.hours' };
  if (seconds % 60 === 0)
    return { value: seconds / 60, unitKey: 'units.minutes' };
  return { value: seconds, unitKey: 'units.seconds' };
}

/** A byte size for display: KiB/MiB when it divides evenly, else bytes. */
export function sizeParts(bytes: number): {
  readonly value: number;
  readonly unitKey: string;
} {
  if (bytes >= 1_048_576 && bytes % 1_048_576 === 0)
    return { value: bytes / 1_048_576, unitKey: 'units.mib' };
  if (bytes >= 1_024 && bytes % 1_024 === 0)
    return { value: bytes / 1_024, unitKey: 'units.kib' };
  return { value: bytes, unitKey: 'units.bytes' };
}
