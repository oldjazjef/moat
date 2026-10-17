import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuditCheck, AuditHead } from '@moat/core';
import type { Principal } from '../auth/application/auth.commands';
import { CurrentPrincipal } from '../auth/auth.http';
import { type AuditEntryView, MAX_PAGE } from './application/audit.commands';
import { AuditService } from './audit.service';
import {
  auditCsv,
  EXPORT_FORMATS,
  type ExportFormat,
} from './domain/audit-export';

const HEX64 = /^[0-9a-f]{64}$/;

/** A non-negative integer from a query string, or a 400. Nothing else is read. */
function integer(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,9}$/.test(value) || Number(value) < min || Number(value) > max)
    throw new BadRequestException({
      statusCode: 400,
      error: `${name}_invalid`,
    });
  return Number(value);
}

function refuse(status: 'not_found' | 'forbidden'): never {
  if (status === 'not_found') throw new NotFoundException();
  throw new ForbiddenException({ statusCode: 403, error: 'forbidden' });
}

/** The audit log of an organisation (authz-matrix: `/api/orgs/:orgId/audit…`, SEC-53, FR-53). */
@Controller('orgs/:orgId/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async list(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ entries: readonly AuditEntryView[]; next: number | null }> {
    const result = await this.audit.list(
      me.accountId,
      orgId,
      integer(after, 'after', 0, 0, 999_999_999),
      integer(limit, 'limit', 50, 1, MAX_PAGE),
    );
    if (result.status !== 'ok') refuse(result.status);
    return { entries: result.entries, next: result.next };
  }

  /**
   * Re-computes the whole chain. `headSeq` + `headHash` are the last row the caller wrote down
   * earlier: a log that is shorter, or whose last row differs, fails (the cut tail, the rewritten
   * chain).
   */
  @Get('verify')
  async verify(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
    @Query('headSeq') headSeq?: string,
    @Query('headHash') headHash?: string,
  ): Promise<{ check: AuditCheck; head: AuditHead | null }> {
    if ((headSeq === undefined) !== (headHash === undefined))
      throw new BadRequestException({ statusCode: 400, error: 'head_invalid' });
    let expected: AuditHead | null = null;
    if (headSeq !== undefined && headHash !== undefined) {
      if (!HEX64.test(headHash))
        throw new BadRequestException({
          statusCode: 400,
          error: 'head_invalid',
        });
      expected = {
        seq: integer(headSeq, 'head', 1, 1, 999_999_999),
        hash: headHash,
      };
    }
    const result = await this.audit.verify(me.accountId, orgId, expected);
    if (result.status !== 'ok') refuse(result.status);
    return { check: result.check, head: result.head };
  }

  /** JSON or CSV (FR-53), up to 5000 rows; `next` continues with `after`. */
  @Get('export')
  @Header('Cache-Control', 'no-store')
  async export(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') orgId: string,
    @Res({ passthrough: true }) res: Response,
    @Query('format') format?: string,
    @Query('after') after?: string,
  ): Promise<
    string | { entries: readonly AuditEntryView[]; next: number | null }
  > {
    if (
      format !== undefined &&
      !(EXPORT_FORMATS as readonly string[]).includes(format)
    )
      throw new BadRequestException({
        statusCode: 400,
        error: 'format_invalid',
      });
    const chosen: ExportFormat = (format as ExportFormat | undefined) ?? 'json';
    const result = await this.audit.export(
      me.accountId,
      orgId,
      integer(after, 'after', 0, 0, 999_999_999),
    );
    if (result.status !== 'ok') refuse(result.status);
    if (result.next !== null)
      res.setHeader('X-Moat-Audit-Next', String(result.next));
    if (chosen === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="moat-audit.csv"',
      );
      return auditCsv(result.entries);
    }
    return { entries: result.entries, next: result.next };
  }
}
