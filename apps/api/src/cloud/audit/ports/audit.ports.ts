import type { AuditRow } from '@moat/core';

/** `conflict`: another row took this seq first (a lost race); the caller reads the head again. */
export type AppendOutcome = 'ok' | 'conflict';

/**
 * The append-only audit log (SEC-53). Every method takes the organisation: a row of another one is
 * never reachable (SEC-50). There is no update and no delete here, on purpose; the database
 * refuses both as well.
 */
export abstract class AuditLogPort {
  /** The organisation's last row, if any. */
  abstract head(organisationId: string): Promise<AuditRow | null>;
  abstract append(row: AuditRow): Promise<AppendOutcome>;
  /** Rows with `seq > afterSeq`, in seq order, at most `limit`. */
  abstract list(
    organisationId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly AuditRow[]>;
}
