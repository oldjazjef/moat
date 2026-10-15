import type { PushPlan, RemoteProject } from '@moat/core';

/**
 * Why a database was not used; nothing was changed in it.
 *   url_invalid      not a `postgresql://` URL Moat accepts (only `sslmode` as an option)
 *   tls_required     a host other than this machine without verified TLS
 *   connect_failed   no connection, refused sign-in, or a certificate that does not verify
 *   foreign_tables   the database holds tables that are not Moat's
 *   schema_newer     a newer Moat set the database up
 *   schema_damaged   Moat's tables without their record, or a failed or changed migration
 */
export const DATABASE_REFUSALS = [
  'url_invalid',
  'tls_required',
  'connect_failed',
  'foreign_tables',
  'schema_newer',
  'schema_damaged',
] as const;
export type DatabaseRefusal = (typeof DATABASE_REFUSALS)[number];

/** write() found the database changed since read() (DT-13); nothing was written. */
export class SyncConflictError extends Error {
  override readonly name = 'SyncConflictError';
}

/** A connected, migrated database, for one sync. */
export interface SyncSession {
  /** The project stored under `key` (empty when there is none yet); bundles without their text. */
  read(key: string): Promise<RemoteProject>;
  /** A bundle's exact text, or null. */
  bundleText(
    key: string,
    gate: string,
    version: number,
  ): Promise<string | null>;
  /**
   * Writes the plan in one transaction, each part only if the database still holds what the
   * plan expected (revision, secret version, absent bundle); else SyncConflictError, nothing
   * written. `at`: ISO-8601 UTC.
   */
  write(key: string, plan: PushPlan, at: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * An external database as sync and backup target (DT-03, DT-13). The connection string comes from
 * the desktop's main process (typed in its own window, kept only as keychain ciphertext) and is
 * never stored or logged here.
 */
export abstract class SyncTargetPort {
  /**
   * Connects, checks the schema and migrates it when Moat's structure is missing (Eme,
   * 14.10.2026), or refuses.
   */
  abstract open(
    url: string,
  ): Promise<
    | { readonly status: 'open'; readonly session: SyncSession }
    | { readonly status: 'refused'; readonly code: DatabaseRefusal }
  >;
}
