import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { Request, Response } from 'express';
import type { Principal } from '../auth/application/auth.commands';
import { CurrentPrincipal, Public } from '../auth/auth.http';
import {
  CreateReportAddressCommand,
  type GateTrafficView,
  ProjectTrafficQuery,
  ReceiveReportCommand,
  TRAFFIC_DAYS,
  type TrafficDays,
} from './application/traffic.handlers';

function denied(status: 'not_found' | 'forbidden'): never {
  if (status === 'not_found') throw new NotFoundException();
  throw new ForbiddenException({ statusCode: 403, error: 'forbidden' });
}

/**
 * Reported traffic of a Cloud project's gates (FR-50, FR-51, T-110), and the report address a
 * gate's local policy names.
 */
@Controller('orgs/:orgId/projects/:projectId')
export class TrafficController {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
  ) {}

  /** The address is shown once; creating a new one ends the old. */
  @Post('gates/:gate/report-address')
  @Header('Cache-Control', 'no-store')
  async reportAddress(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Param('gate') gate: string,
  ): Promise<{ url: string }> {
    const r = await this.commands.execute(
      new CreateReportAddressCommand(me.accountId, org, project, gate),
    );
    if (r.status !== 'ok') denied(r.status);
    return { url: r.url };
  }

  /** What the gates reported over the last 1, 7 or 30 days (default 7). */
  @Get('traffic')
  @Header('Cache-Control', 'no-store')
  async traffic(
    @CurrentPrincipal() me: Principal,
    @Param('orgId') org: string,
    @Param('projectId') project: string,
    @Query('days') days?: string,
  ): Promise<{ from: number; to: number; gates: readonly GateTrafficView[] }> {
    const parsed = days === undefined ? 7 : Number(days);
    if (!(TRAFFIC_DAYS as readonly number[]).includes(parsed))
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'days_invalid',
      });
    const r = await this.queries.execute(
      new ProjectTrafficQuery(
        me.accountId,
        org,
        project,
        parsed as TrafficDays,
      ),
    );
    if (r.status !== 'ok') denied(r.status);
    return { from: r.from, to: r.to, gates: r.gates };
  }
}

/**
 * Where a gate sends its traffic report (FR-50, T-110). No session: the address holds a 256-bit
 * token and is that gate's credential for reporting only. An unknown or malformed token answers
 * 404, a refused report 422 with a code, a too eager sender 429. The answer is empty (204): the
 * gate takes nothing from it.
 */
@Controller('report')
export class ReportController {
  constructor(private readonly commands: CommandBus) {}

  @Public()
  @Post(':token')
  @HttpCode(204)
  async report(
    @Param('token') token: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const body: unknown = request.body;
    const bytes = Buffer.isBuffer(body)
      ? new Uint8Array(body)
      : new Uint8Array();
    const r = await this.commands.execute(
      new ReceiveReportCommand(token, bytes, request.ip ?? 'unknown'),
    );
    if (r.status === 'not_found') throw new NotFoundException();
    if (r.status === 'limited') {
      response.setHeader('Retry-After', String(r.retryAfter));
      throw new HttpException({ statusCode: 429, error: 'rate_limited' }, 429);
    }
    if (r.status === 'refused')
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: r.code,
      });
  }
}
