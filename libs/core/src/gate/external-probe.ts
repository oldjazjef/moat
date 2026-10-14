import type { ExternalResult } from './hardening';

/**
 * The check from outside (SEC-49) as Moat Desktop runs it against a deployed gate (DT-07): the
 * same probes as `php moat-gate.php check --url` (gates/php/src/Hardening/ExternalCheck.php), but
 * from the admin's computer, which cannot leave a nonce on the server. So it cannot prove that
 * the URL reaches *this* gate, only that it answers like a gate: a reachable data file is still
 * proof (H1 «Unsicher für Secrets»), but nothing reachable proves no level (§1.5). The level comes
 * from the gate's own check, which also knows the web process's user (SEC-49a).
 */

/** The data files a gate may keep in its data folder (`<name>.php`), the key file first. */
export const DATA_FILES = [
  'identity',
  'trust',
  'policy',
  'bundle',
  'state',
  'limits',
  'lock',
  'budget',
  'kill',
  'killlock',
  'webfacts',
  'pull',
  'pulllock',
] as const;

/** `moat-data-<hex>`: the random name `php moat-gate.php install` printed. */
export const DATA_FOLDER = /^moat-data-[0-9a-f]{32}$/;

/** Every data file starts with this marker; its source coming back means the file is readable. */
export const DATA_MARKER = '__halt_compiler';

/**
 * One probe's answer as classifyProbes needs it: the status and what the body showed, never the
 * body itself (a readable data file holds key bytes, DT-07). null: nothing came back.
 */
export type ProbeAnswer = {
  readonly status: number;
  /** The data-file marker is in the body: the file's source came back. */
  readonly marker: boolean;
  /** The body names a data file (`<name>.php`): a folder listing. */
  readonly listsData: boolean;
} | null;

/** The gate's own answer to `/moat-check`: status and body (a short JSON error, no secret). */
export type GateProbeAnswer = {
  readonly status: number;
  readonly body: string;
} | null;

export type DesktopExternalResult = Exclude<ExternalResult, 'not_checked'>;

export interface ExternalProbe {
  readonly result: DesktopExternalResult;
  /** The data files (or `/` for the folder listing) whose content came back. */
  readonly reachable: readonly string[];
}

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const MARKER_BYTES = ascii(DATA_MARKER);
const FILE_NAME_BYTES = DATA_FILES.map((name) => ascii(`${name}.php`));

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1)
      if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Looks at a probe's raw bytes without turning them into a string (the caller wipes them). */
export function inspectProbe(
  status: number,
  body: Uint8Array,
): NonNullable<ProbeAnswer> {
  return {
    status,
    marker: contains(body, MARKER_BYTES),
    listsData: FILE_NAME_BYTES.some((name) => contains(body, name)),
  };
}

/** The gate's own error answer: exactly `{"error":"<code>"}`. */
export function answersLikeGate(answer: GateProbeAnswer): boolean {
  if (answer === null) return false;
  try {
    const value = JSON.parse(answer.body.replace(/\n$/, '')) as unknown;
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof (value as { error?: unknown }).error === 'string' &&
      /^[a-z_]{1,64}$/.test((value as { error: string }).error)
    );
  } catch {
    return false;
  }
}

/**
 * An answer that shows the file is kept from the web: 2xx without the marker (PHP ran the file,
 * or the host serves a page of its own), or a refusal (401, 403, 404, 410). Anything else (no
 * answer, a redirect, 429, 5xx, …) leaves the file unchecked, so the check failed.
 */
function kept(answer: ProbeAnswer): boolean {
  if (answer === null) return false;
  const { status } = answer;
  return (
    (status >= 200 && status < 300) ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 410
  );
}

/**
 * What the probes found: `gate` = the gate URL plus `/moat-check`, `folder` = the data folder,
 * `files` = each of DATA_FILES and `index.php`, in that order (fewer when the check stopped).
 * A marker or listing counts whatever the status (erring toward caution).
 */
export function classifyProbes(
  gate: GateProbeAnswer,
  folder: ProbeAnswer,
  files: readonly ProbeAnswer[],
): ExternalProbe {
  if (gate === null) return { result: 'failed', reachable: [] };
  if (!answersLikeGate(gate)) return { result: 'not_gate', reachable: [] };
  const reachable: string[] = [];
  if (folder?.listsData === true) reachable.push('/');
  const names = [...DATA_FILES.map((name) => `${name}.php`), 'index.php'];
  files.forEach((answer, i) => {
    if (answer?.marker === true) reachable.push(names[i] ?? '');
  });
  if (reachable.length > 0) return { result: 'reachable', reachable };
  const complete =
    files.length === names.length && kept(folder) && files.every(kept);
  return { result: complete ? 'blocked' : 'failed', reachable: [] };
}

/** The paths to probe, relative to the folder of the gate file. */
export function probePaths(dataFolder: string): {
  readonly folder: string;
  readonly files: readonly string[];
} {
  return {
    folder: `${dataFolder}/`,
    files: [...DATA_FILES.map((name) => `${name}.php`), 'index.php'].map(
      (file) => `${dataFolder}/${file}`,
    ),
  };
}
