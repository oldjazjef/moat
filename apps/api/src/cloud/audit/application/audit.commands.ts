import { Query } from '@nestjs/cqrs';
import type { AuditCheck, AuditHead, AuditRow } from '@moat/core';
import type {
  Forbidden,
  NotFound,
} from '../../tenancy/application/tenancy.commands';

/** What a page of the log holds: the row as stored, so that anyone can recompute its hash. */
export type AuditEntryView = AuditRow;

export const MAX_PAGE = 200;
export const MAX_EXPORT = 5000;

export type ListAuditResult =
  | {
      readonly status: 'ok';
      readonly entries: readonly AuditEntryView[];
      /** Pass as `after` for the next page; null: that was the last one. */
      readonly next: number | null;
    }
  | NotFound
  | Forbidden;

export class ListAuditQuery extends Query<ListAuditResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly after: number,
    readonly limit: number,
  ) {
    super();
  }
}

export type VerifyAuditResult =
  | {
      readonly status: 'ok';
      readonly check: AuditCheck;
      /** The last row: what an auditor keeps outside the database (the anchor). */
      readonly head: AuditHead | null;
    }
  | NotFound
  | Forbidden;

export class VerifyAuditQuery extends Query<VerifyAuditResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    /** The head the caller remembers: a shorter or different log fails the check. */
    readonly expectedHead: AuditHead | null,
  ) {
    super();
  }
}

export type ExportAuditResult =
  | {
      readonly status: 'ok';
      readonly entries: readonly AuditEntryView[];
      readonly next: number | null;
    }
  | NotFound
  | Forbidden;

export class ExportAuditQuery extends Query<ExportAuditResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly after: number,
  ) {
    super();
  }
}
