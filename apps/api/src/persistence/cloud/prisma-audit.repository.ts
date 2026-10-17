import { Injectable } from '@nestjs/common';
import type { AuditAction, AuditRow } from '@moat/core';
import {
  type AppendOutcome,
  AuditLogPort,
} from '../../cloud/audit/ports/audit.ports';
import { CloudDatabase } from './cloud-database';

/** The database's CHECK keeps `action` to the known list. */
function rowOf(row: {
  seq: number;
  organisationId: string;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  details: string;
  prevHash: string;
  hash: string;
}): AuditRow {
  return { ...row, action: row.action as AuditAction };
}

@Injectable()
export class PrismaAuditLogRepository extends AuditLogPort {
  constructor(private readonly database: CloudDatabase) {
    super();
  }

  private get db() {
    return this.database.client;
  }

  async head(organisationId: string): Promise<AuditRow | null> {
    const row = await this.db.auditEntry.findFirst({
      where: { organisationId },
      orderBy: { seq: 'desc' },
    });
    return row === null ? null : rowOf(row);
  }

  async append(row: AuditRow): Promise<AppendOutcome> {
    try {
      await this.db.auditEntry.create({ data: { ...row } });
      return 'ok';
    } catch (error) {
      // The primary key (organisation, seq) or the unique hash: another writer took this seq.
      if ((error as { code?: unknown }).code === 'P2002') return 'conflict';
      throw error;
    }
  }

  async list(
    organisationId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly AuditRow[]> {
    const rows = await this.db.auditEntry.findMany({
      where: { organisationId, seq: { gt: afterSeq } },
      orderBy: { seq: 'asc' },
      take: limit,
    });
    return rows.map(rowOf);
  }
}
