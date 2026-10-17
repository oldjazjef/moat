import { canonicalJson } from '../canonical/jcs';
import { sodium } from '../crypto/sodium';
import { utf8 } from '../encoding/utf8';
import type { JsonValue } from '../json/strict-json';

/**
 * The audit log of a Moat Cloud organisation (SEC-53, FR-53): who changed what, one row per event,
 * append-only and hash-chained **per organisation**. A row's hash covers the row and the previous
 * row's hash (and the organisation, so a row cannot be moved into another chain), so a row changed,
 * removed or inserted afterwards breaks the chain from there on; the head (last seq + hash) kept by
 * the auditor outside the database also shows a cut-off tail. Tamper-evident, not tamper-proof:
 * whoever can write the database **and** the head can forge a consistent log (T-87).
 *
 * The details are a closed list per action: roles, flags and digests, never free text, a name or an
 * address (an address is recorded as its SHA-256, which lets an auditor check a known address and
 * tells nobody else anything, T-79). Pure: the caller gives the time and the actor.
 */
export const AUDIT_ACTIONS = [
  'org.create',
  'member.add_requested',
  'member.change',
  'member.remove',
  'project.create',
  'project.delete',
  'config.edit',
  'gate.add',
  'gate.pull_token',
  'secret.set',
  'bundle.sign',
  'bundle.upload',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** The roles of an organisation, as the audit log knows them (kept equal to the Cloud's by a spec). */
export const AUDIT_ROLES = [
  'owner',
  'admin',
  'editor',
  'viewer',
  'billing',
] as const;
type AuditRole = (typeof AUDIT_ROLES)[number];

export type AuditEvent =
  | {
      readonly action: 'org.create';
      readonly target: string;
      readonly details: Record<never, never>;
    }
  | {
      readonly action: 'member.add_requested';
      /** The organisation: nobody is named, an unknown address looks the same (T-79). */
      readonly target: null;
      readonly details: {
        readonly role: AuditRole;
        /** SHA-256 hex of the normalised address. */
        readonly emailHash: string;
      };
    }
  | {
      readonly action: 'member.change';
      /** The member's account id. */
      readonly target: string;
      readonly details: {
        readonly fromRole: AuditRole;
        readonly toRole: AuditRole;
        readonly fromRelease: boolean;
        readonly toRelease: boolean;
      };
    }
  | {
      readonly action: 'member.remove';
      readonly target: string;
      readonly details: {
        readonly role: AuditRole;
        /** The member left on their own. */
        readonly self: boolean;
      };
    }
  | {
      readonly action: 'project.create' | 'project.delete';
      /** The project's id. */
      readonly target: string;
      readonly details: Record<never, never>;
    }
  | {
      /** moat.yaml of a project changed: the op's name (the closed list of edits), never a value. */
      readonly action: 'config.edit';
      readonly target: string;
      readonly details: { readonly op: string };
    }
  | {
      readonly action: 'gate.add';
      readonly target: string;
      readonly details: {
        readonly gate: string;
        readonly mode: 'managed' | 'signed';
      };
    }
  | {
      /** A gate's pull address was created or replaced (the token itself is never recorded). */
      readonly action: 'gate.pull_token';
      readonly target: string;
      readonly details: { readonly gate: string };
    }
  | {
      /** A sealed secret was stored: its name and version, never the ciphertext. */
      readonly action: 'secret.set';
      readonly target: string;
      readonly details: {
        readonly gate: string;
        readonly name: string;
        readonly secretVersion: number;
      };
    }
  | {
      /** `bundle.sign`: Moat Cloud signed it (trust mode 0); `bundle.upload`: signed elsewhere. */
      readonly action: 'bundle.sign' | 'bundle.upload';
      readonly target: string;
      readonly details: {
        readonly gate: string;
        readonly version: number;
        /** SHA-256 hex of the bundle file. */
        readonly sha256: string;
        readonly kid: string;
      };
    };

export interface AuditRow {
  readonly seq: number;
  readonly organisationId: string;
  /** ISO-8601 UTC with milliseconds and `Z`. */
  readonly at: string;
  /** The account that did it. */
  readonly actor: string;
  readonly action: AuditAction;
  readonly target: string | null;
  /** The details as canonical JSON (JCS). */
  readonly details: string;
  readonly prevHash: string;
  readonly hash: string;
}

/** The last row of an organisation's chain, as remembered outside the database. */
export interface AuditHead {
  readonly seq: number;
  readonly hash: string;
}

export type AuditCheck =
  | { readonly status: 'intact'; readonly entries: number }
  | {
      readonly status: 'broken';
      readonly entries: number;
      /** The first row that does not fit; null: the tail is missing (head). */
      readonly seq: number | null;
      readonly reason:
        'sequence' | 'organisation' | 'chain' | 'hash' | 'details' | 'head';
    };

export const AUDIT_GENESIS_HASH = '0'.repeat(64);
export const MAX_AUDIT_DETAILS_LENGTH = 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{22}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const OP = /^[a-zA-Z]{1,40}$/;
const AT = /^\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-6]\d\.\d{3}Z$/;

export class AuditEventError extends Error {
  override readonly name = 'AuditEventError';
}

/** The next row of `organisationId`'s chain after `previous` (null: the first row). */
export async function chainAudit(
  previous: AuditHead | null,
  organisationId: string,
  at: string,
  actor: string,
  event: AuditEvent,
): Promise<AuditRow> {
  if (!ID.test(organisationId)) throw new AuditEventError('organisation');
  if (!ID.test(actor)) throw new AuditEventError('actor');
  if (!AT.test(at)) throw new AuditEventError('time');
  if (!eventValid(event.action, event.target, event.details))
    throw new AuditEventError(event.action);
  const details = canonicalJson(event.details as unknown as JsonValue);
  const seq = previous === null ? 1 : previous.seq + 1;
  const prevHash = previous === null ? AUDIT_GENESIS_HASH : previous.hash;
  return {
    seq,
    organisationId,
    at,
    actor,
    action: event.action,
    target: event.target,
    details,
    prevHash,
    hash: await rowHash(
      seq,
      organisationId,
      at,
      actor,
      event.action,
      event.target,
      details,
      prevHash,
    ),
  };
}

/**
 * Checks one organisation's rows (in seq order) and, when given, the head: 1, 2, 3, … without a
 * gap, all of this organisation, each pointing at the previous hash, each hash and its details as
 * written, the last row the head's.
 */
export async function verifyAudit(
  organisationId: string,
  rows: readonly AuditRow[],
  head: AuditHead | null,
): Promise<AuditCheck> {
  let prevHash = AUDIT_GENESIS_HASH;
  for (const [index, row] of rows.entries()) {
    const broken = (
      reason: Exclude<AuditCheck, { status: 'intact' }>['reason'],
    ) =>
      ({
        status: 'broken',
        entries: rows.length,
        seq: row.seq,
        reason,
      }) as const;
    if (row.seq !== index + 1) return broken('sequence');
    if (row.organisationId !== organisationId) return broken('organisation');
    if (row.prevHash !== prevHash) return broken('chain');
    const details = parseDetails(row.details);
    if (
      details === null ||
      !AT.test(row.at) ||
      !ID.test(row.actor) ||
      !eventValid(row.action, row.target, details) ||
      canonicalJson(details as JsonValue) !== row.details
    )
      return broken('details');
    const hash = await rowHash(
      row.seq,
      row.organisationId,
      row.at,
      row.actor,
      row.action,
      row.target,
      row.details,
      prevHash,
    );
    if (hash !== row.hash) return broken('hash');
    prevHash = row.hash;
  }
  if (head !== null) {
    const last = rows.at(-1);
    if (last === undefined || last.seq < head.seq)
      return {
        status: 'broken',
        entries: rows.length,
        seq: null,
        reason: 'head',
      };
    if (last.seq !== head.seq || last.hash !== head.hash)
      return {
        status: 'broken',
        entries: rows.length,
        seq: last.seq,
        reason: 'head',
      };
  }
  return { status: 'intact', entries: rows.length };
}

async function rowHash(
  seq: number,
  organisationId: string,
  at: string,
  actor: string,
  action: string,
  target: string | null,
  details: string,
  prev: string,
): Promise<string> {
  const na = await sodium();
  return na.to_hex(
    na.crypto_hash_sha256(
      utf8(
        canonicalJson({
          domain: 'moat:audit:v1',
          seq,
          org: organisationId,
          at,
          actor,
          action,
          target,
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
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const name = (value: unknown): boolean =>
  typeof value === 'string' && NAME.test(value);

const isRole = (value: unknown): value is AuditRole =>
  typeof value === 'string' &&
  (AUDIT_ROLES as readonly string[]).includes(value);

/** Exactly the target and the keys of the action, each of its type: nothing else is recorded. */
export function eventValid(
  action: string,
  target: string | null,
  details: unknown,
): boolean {
  if (typeof details !== 'object' || details === null || Array.isArray(details))
    return false;
  const d = details as Record<string, unknown>;
  const keys = Object.keys(d).sort();
  const exactly = (...names: string[]) =>
    keys.length === names.length &&
    [...names].sort().every((name, i) => keys[i] === name);
  const id = target !== null && ID.test(target);
  switch (action) {
    case 'org.create':
    case 'project.create':
    case 'project.delete':
      return id && exactly();
    case 'member.add_requested':
      return (
        target === null &&
        exactly('role', 'emailHash') &&
        isRole(d['role']) &&
        typeof d['emailHash'] === 'string' &&
        HEX64.test(d['emailHash'])
      );
    case 'member.change':
      return (
        id &&
        exactly('fromRole', 'toRole', 'fromRelease', 'toRelease') &&
        isRole(d['fromRole']) &&
        isRole(d['toRole']) &&
        typeof d['fromRelease'] === 'boolean' &&
        typeof d['toRelease'] === 'boolean'
      );
    case 'member.remove':
      return (
        id &&
        exactly('role', 'self') &&
        isRole(d['role']) &&
        typeof d['self'] === 'boolean'
      );
    case 'config.edit':
      return (
        id && exactly('op') && typeof d['op'] === 'string' && OP.test(d['op'])
      );
    case 'gate.add':
      return (
        id &&
        exactly('gate', 'mode') &&
        name(d['gate']) &&
        (d['mode'] === 'managed' || d['mode'] === 'signed')
      );
    case 'gate.pull_token':
      return id && exactly('gate') && name(d['gate']);
    case 'secret.set':
      return (
        id &&
        exactly('gate', 'name', 'secretVersion') &&
        name(d['gate']) &&
        name(d['name']) &&
        typeof d['secretVersion'] === 'number' &&
        Number.isSafeInteger(d['secretVersion']) &&
        d['secretVersion'] >= 1
      );
    case 'bundle.sign':
    case 'bundle.upload':
      return (
        id &&
        exactly('gate', 'version', 'sha256', 'kid') &&
        name(d['gate']) &&
        typeof d['version'] === 'number' &&
        Number.isSafeInteger(d['version']) &&
        d['version'] >= 1 &&
        typeof d['sha256'] === 'string' &&
        HEX64.test(d['sha256']) &&
        typeof d['kid'] === 'string' &&
        ID.test(d['kid'])
      );
    default:
      return false;
  }
}
