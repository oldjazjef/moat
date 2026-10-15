import { canonicalJson } from '../canonical/jcs';
import { sodium } from '../crypto/sodium';
import { utf8 } from '../encoding/utf8';
import type { JsonValue } from '../json/strict-json';
import { isRecord, NAME_PATTERN } from './project';

/**
 * The local history of a project (DT-03, «Verlauf»): what Moat Desktop did, one row per event,
 * append-only and hash-chained. Each row's hash covers the row and the previous row's hash, so a
 * row changed, removed or inserted after the fact breaks the chain from there on; the anchor (the
 * last row's seq and hash, kept outside the database) also shows a cut-off tail or a chain
 * rewritten from scratch. Tamper-evident, not tamper-proof: whoever can write both the database
 * and the anchor can forge a consistent history (T-69).
 *
 * The details are a closed list per kind — names, versions, digests, counts — so neither a secret
 * nor a path can ever be recorded (SEC-31, SEC-34). Pure: the caller gives the time.
 */
export const HISTORY_KINDS = [
  'history_started',
  'bundle_signed',
  'secret_sealed',
  'deploy',
  'config_edited',
  'database_pushed',
  'database_pulled',
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export const DEPLOY_TARGET_KINDS = ['zip', 'folder', 'sftp', 'git'] as const;
export type DeployTargetKind = (typeof DEPLOY_TARGET_KINDS)[number];

export interface SyncCounts {
  /** The project's name in the database. */
  readonly key: string;
  /** moat.yaml was written (pushed or pulled). */
  readonly config: boolean;
  readonly gates: number;
  readonly secrets: number;
  readonly bundles: number;
  readonly conflicts: number;
}

export type HistoryEvent =
  | { readonly kind: 'history_started'; readonly details: Record<never, never> }
  | {
      readonly kind: 'bundle_signed';
      readonly details: {
        readonly gate: string;
        readonly version: number;
        /** SHA-256 hex of the bundle file. */
        readonly sha256: string;
        readonly kid: string;
      };
    }
  | {
      readonly kind: 'secret_sealed';
      readonly details: {
        readonly gate: string;
        readonly name: string;
        readonly secretVersion: number;
      };
    }
  | {
      readonly kind: 'deploy';
      readonly details: {
        readonly gate: string;
        readonly version: number;
        readonly target: DeployTargetKind;
        readonly sha256: string;
      };
    }
  | {
      readonly kind: 'config_edited';
      readonly details: {
        /** The edit's op (ConfigEditOp of the API): a name, never a value. */
        readonly op: string;
        /** SHA-256 hex of moat.yaml before and after. */
        readonly before: string;
        readonly after: string;
      };
    }
  | {
      readonly kind: 'database_pushed' | 'database_pulled';
      readonly details: SyncCounts;
    };

export interface HistoryRow {
  readonly seq: number;
  /** ISO-8601 UTC with milliseconds and `Z`. */
  readonly at: string;
  readonly kind: HistoryKind;
  /** The details as canonical JSON (JCS). */
  readonly details: string;
  readonly prevHash: string;
  readonly hash: string;
}

/** The last row as remembered outside the database. */
export interface HistoryAnchor {
  readonly seq: number;
  readonly hash: string;
}

export type HistoryCheck =
  | { readonly status: 'intact'; readonly entries: number }
  | {
      readonly status: 'broken';
      readonly entries: number;
      /** The first row that does not fit; null: the tail is missing (anchor). */
      readonly seq: number | null;
      readonly reason: 'sequence' | 'chain' | 'hash' | 'details' | 'anchor';
    };

export const GENESIS_HASH = '0'.repeat(64);
export const MAX_DETAILS_LENGTH = 4096;
const HEX64 = /^[0-9a-f]{64}$/;
const KID = /^[A-Za-z0-9_-]{22}$/;
const OP = /^[a-zA-Z]{1,40}$/;
const AT = /^\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-6]\d\.\d{3}Z$/;

export class HistoryEventError extends Error {
  override readonly name = 'HistoryEventError';
}

/** The next row after `previous` (null: the first row). Throws HistoryEventError on bad details. */
export async function chainHistory(
  previous: HistoryAnchor | null,
  at: string,
  event: HistoryEvent,
): Promise<HistoryRow> {
  if (!AT.test(at)) throw new HistoryEventError('time');
  if (!detailsValid(event.kind, event.details))
    throw new HistoryEventError(event.kind);
  const details = canonicalJson(event.details as unknown as JsonValue);
  if (details.length > MAX_DETAILS_LENGTH)
    throw new HistoryEventError('too long');
  const seq = previous === null ? 1 : previous.seq + 1;
  const prevHash = previous === null ? GENESIS_HASH : previous.hash;
  return {
    seq,
    at,
    kind: event.kind,
    details,
    prevHash,
    hash: await rowHash(seq, at, event.kind, details, prevHash),
  };
}

/**
 * Checks the rows (in seq order) and, when given, the anchor: 1, 2, 3, … without a gap, each row
 * pointing at the previous row's hash, each hash and its details as written, the last row the
 * anchored one.
 */
export async function verifyHistory(
  rows: readonly HistoryRow[],
  anchor: HistoryAnchor | null,
): Promise<HistoryCheck> {
  let prevHash = GENESIS_HASH;
  for (const [index, row] of rows.entries()) {
    const broken = (
      reason: Exclude<HistoryCheck, { status: 'intact' }>['reason'],
    ) =>
      ({
        status: 'broken',
        entries: rows.length,
        seq: row.seq,
        reason,
      }) as const;
    if (row.seq !== index + 1) return broken('sequence');
    if (row.prevHash !== prevHash) return broken('chain');
    const details = parseDetails(row.details);
    if (
      details === null ||
      !(HISTORY_KINDS as readonly string[]).includes(row.kind) ||
      !detailsValid(row.kind, details) ||
      canonicalJson(details as JsonValue) !== row.details ||
      !AT.test(row.at)
    )
      return broken('details');
    const hash = await rowHash(
      row.seq,
      row.at,
      row.kind,
      row.details,
      prevHash,
    );
    if (hash !== row.hash) return broken('hash');
    prevHash = row.hash;
  }
  if (anchor !== null) {
    const last = rows.at(-1);
    if (last === undefined || last.seq < anchor.seq)
      return {
        status: 'broken',
        entries: rows.length,
        seq: null,
        reason: 'anchor',
      };
    if (last.seq !== anchor.seq || last.hash !== anchor.hash)
      return {
        status: 'broken',
        entries: rows.length,
        seq: last.seq,
        reason: 'anchor',
      };
  }
  return { status: 'intact', entries: rows.length };
}

async function rowHash(
  seq: number,
  at: string,
  kind: string,
  details: string,
  prev: string,
): Promise<string> {
  const na = await sodium();
  return na.to_hex(
    na.crypto_hash_sha256(
      utf8(
        canonicalJson({
          domain: 'moat:history:v1',
          seq,
          at,
          kind,
          details,
          prev,
        }),
      ),
    ),
  );
}

function parseDetails(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Exactly the keys of the kind, each of its type: nothing else is ever recorded. */
export function detailsValid(kind: string, details: unknown): boolean {
  if (!isRecord(details)) return false;
  const keys = Object.keys(details).sort();
  const exactly = (...names: string[]) =>
    keys.length === names.length &&
    names.sort().every((name, i) => keys[i] === name);
  const name = (key: string) =>
    typeof details[key] === 'string' && NAME_PATTERN.test(details[key]);
  const count = (key: string) =>
    typeof details[key] === 'number' &&
    Number.isSafeInteger(details[key]) &&
    details[key] >= 0;
  const version = (key: string) => count(key) && (details[key] as number) >= 1;
  const hex = (key: string) =>
    typeof details[key] === 'string' && HEX64.test(details[key]);
  switch (kind) {
    case 'history_started':
      return exactly();
    case 'bundle_signed':
      return (
        exactly('gate', 'version', 'sha256', 'kid') &&
        name('gate') &&
        version('version') &&
        hex('sha256') &&
        typeof details['kid'] === 'string' &&
        KID.test(details['kid'])
      );
    case 'secret_sealed':
      return (
        exactly('gate', 'name', 'secretVersion') &&
        name('gate') &&
        name('name') &&
        version('secretVersion')
      );
    case 'deploy':
      return (
        exactly('gate', 'version', 'target', 'sha256') &&
        name('gate') &&
        version('version') &&
        (DEPLOY_TARGET_KINDS as readonly unknown[]).includes(
          details['target'],
        ) &&
        hex('sha256')
      );
    case 'config_edited':
      return (
        exactly('op', 'before', 'after') &&
        typeof details['op'] === 'string' &&
        OP.test(details['op']) &&
        hex('before') &&
        hex('after')
      );
    case 'database_pushed':
    case 'database_pulled':
      return (
        exactly('key', 'config', 'gates', 'secrets', 'bundles', 'conflicts') &&
        name('key') &&
        typeof details['config'] === 'boolean' &&
        count('gates') &&
        count('secrets') &&
        count('bundles') &&
        count('conflicts')
      );
    default:
      return false;
  }
}
