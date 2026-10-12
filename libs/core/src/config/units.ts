/**
 * Durations and sizes as written in moat.yaml — always a string with a unit (CLAUDE.md, YAML
 * standards), never a bare number. Returns null for anything else.
 */
const DURATION_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const SIZE_BYTES: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 * 1024,
};

export function parseDuration(text: string): number | null {
  const match = /^([1-9][0-9]{0,8})(ms|s|m|h|d)$/.exec(text);
  const factor = DURATION_MS[match?.[2] ?? ''];
  if (match === null || factor === undefined) return null;
  return Number(match[1]) * factor;
}

export function parseSize(text: string): number | null {
  const match = /^(0|[1-9][0-9]{0,8})(B|KiB|MiB)$/.exec(text);
  const factor = SIZE_BYTES[match?.[2] ?? ''];
  if (match === null || factor === undefined) return null;
  return Number(match[1]) * factor;
}
