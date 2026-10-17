import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { type AuditRow, verifyAudit } from '@moat/core';
import { ID_PATTERN } from '../../common/clock';
import { can } from '../../tenancy/domain/permissions';
import { OrganisationRepositoryPort } from '../../tenancy/ports/tenancy.ports';
import { AuditLogPort } from '../ports/audit.ports';
import {
  ExportAuditQuery,
  type ExportAuditResult,
  ListAuditQuery,
  type ListAuditResult,
  MAX_EXPORT,
  MAX_PAGE,
  VerifyAuditQuery,
  type VerifyAuditResult,
} from './audit.commands';

/**
 * The tenant check and the right to read the log (SEC-50, SEC-52): a non-member and a foreign
 * organisation are both `not_found`; a member without `audit:read` is `forbidden`.
 */
async function reader(
  organisations: OrganisationRepositoryPort,
  actorId: string,
  organisationId: string,
): Promise<'not_found' | 'forbidden' | 'ok'> {
  if (!ID_PATTERN.test(organisationId)) return 'not_found';
  const member = await organisations.membership(organisationId, actorId);
  if (member === null) return 'not_found';
  return can(member.role, member.releaseGranted, 'audit:read')
    ? 'ok'
    : 'forbidden';
}

@QueryHandler(ListAuditQuery)
export class ListAuditHandler implements IQueryHandler<ListAuditQuery> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly log: AuditLogPort,
  ) {}

  async execute(query: ListAuditQuery): Promise<ListAuditResult> {
    const access = await reader(
      this.organisations,
      query.actorId,
      query.organisationId,
    );
    if (access === 'not_found') return { status: 'not_found' };
    if (access === 'forbidden') return { status: 'forbidden' };
    const limit = Math.min(Math.max(query.limit, 1), MAX_PAGE);
    // One more than asked: its presence says there is a next page.
    const rows = await this.log.list(
      query.organisationId,
      query.after,
      limit + 1,
    );
    const entries = rows.slice(0, limit);
    return {
      status: 'ok',
      entries,
      next: rows.length > limit ? (entries.at(-1)?.seq ?? null) : null,
    };
  }
}

@QueryHandler(ExportAuditQuery)
export class ExportAuditHandler implements IQueryHandler<ExportAuditQuery> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly log: AuditLogPort,
  ) {}

  async execute(query: ExportAuditQuery): Promise<ExportAuditResult> {
    const access = await reader(
      this.organisations,
      query.actorId,
      query.organisationId,
    );
    if (access === 'not_found') return { status: 'not_found' };
    if (access === 'forbidden') return { status: 'forbidden' };
    const rows = await this.log.list(
      query.organisationId,
      query.after,
      MAX_EXPORT + 1,
    );
    const entries = rows.slice(0, MAX_EXPORT);
    return {
      status: 'ok',
      entries,
      next: rows.length > MAX_EXPORT ? (entries.at(-1)?.seq ?? null) : null,
    };
  }
}

@QueryHandler(VerifyAuditQuery)
export class VerifyAuditHandler implements IQueryHandler<VerifyAuditQuery> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly log: AuditLogPort,
  ) {}

  async execute(query: VerifyAuditQuery): Promise<VerifyAuditResult> {
    const access = await reader(
      this.organisations,
      query.actorId,
      query.organisationId,
    );
    if (access === 'not_found') return { status: 'not_found' };
    if (access === 'forbidden') return { status: 'forbidden' };
    const rows: AuditRow[] = [];
    for (;;) {
      const page = await this.log.list(
        query.organisationId,
        rows.at(-1)?.seq ?? 0,
        1000,
      );
      if (page.length === 0) break;
      rows.push(...page);
    }
    const last = rows.at(-1);
    return {
      status: 'ok',
      check: await verifyAudit(query.organisationId, rows, query.expectedHead),
      head: last === undefined ? null : { seq: last.seq, hash: last.hash },
    };
  }
}

export const AUDIT_HANDLERS = [
  ListAuditHandler,
  ExportAuditHandler,
  VerifyAuditHandler,
];
