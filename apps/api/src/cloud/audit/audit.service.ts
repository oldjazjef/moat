import { Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import type { AuditHead } from '@moat/core';
import {
  ExportAuditQuery,
  type ExportAuditResult,
  ListAuditQuery,
  type ListAuditResult,
  VerifyAuditQuery,
  type VerifyAuditResult,
} from './application/audit.commands';

/** The façade of the controller (Controller → Service → Bus → Handler → Port). */
@Injectable()
export class AuditService {
  constructor(private readonly queries: QueryBus) {}

  list(
    actorId: string,
    organisationId: string,
    after: number,
    limit: number,
  ): Promise<ListAuditResult> {
    return this.queries.execute(
      new ListAuditQuery(actorId, organisationId, after, limit),
    );
  }

  verify(
    actorId: string,
    organisationId: string,
    expectedHead: AuditHead | null,
  ): Promise<VerifyAuditResult> {
    return this.queries.execute(
      new VerifyAuditQuery(actorId, organisationId, expectedHead),
    );
  }

  export(
    actorId: string,
    organisationId: string,
    after: number,
  ): Promise<ExportAuditResult> {
    return this.queries.execute(
      new ExportAuditQuery(actorId, organisationId, after),
    );
  }
}
