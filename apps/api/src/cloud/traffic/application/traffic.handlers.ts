import { createHash, randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  Command,
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  Query,
  QueryHandler,
} from '@nestjs/cqrs';
import {
  HOUR,
  parseTrafficReport,
  type TrafficReportRefusal,
} from '@moat/core';
import type { Env } from '../../../config/env';
import { AuditTrail } from '../../audit/application/audit-trail';
import {
  RateLimiter,
  REPORT_PER_GATE,
  REPORT_PER_IP,
} from '../../auth/application/rate-limiter';
import { Clock, iso } from '../../common/clock';
import { guard } from '../../gates/application/gates.handlers';
import { CloudProjectStorePort } from '../../gates/ports/gates.ports';
import {
  OrganisationRepositoryPort,
  OrgProjectRepositoryPort,
} from '../../tenancy/ports/tenancy.ports';
import {
  CloudTrafficStorePort,
  TRAFFIC_RETENTION_HOURS,
  type TrafficRecord,
} from '../ports/traffic.ports';

const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

type Access = { readonly status: 'not_found' | 'forbidden' };

// ── The report address ──────────────────────────────────────────────────────────────────────

export type ReportAddressResult =
  Access | { readonly status: 'ok'; readonly url: string };

/**
 * A gate's report address (FR-50, T-110), shown once: the gate's credential towards Moat Cloud
 * for reporting only. A new one ends the old. Needs `gate:manage` (Owner, Admin).
 */
export class CreateReportAddressCommand extends Command<ReportAddressResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
    readonly gate: string,
  ) {
    super();
  }
}

@CommandHandler(CreateReportAddressCommand)
export class CreateReportAddressHandler implements ICommandHandler<CreateReportAddressCommand> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly projects: OrgProjectRepositoryPort,
    private readonly traffic: CloudTrafficStorePort,
    private readonly config: ConfigService<Env, true>,
    private readonly clock: Clock,
    private readonly audit: AuditTrail,
  ) {}

  async execute(
    command: CreateReportAddressCommand,
  ): Promise<ReportAddressResult> {
    const access = await guard(
      this.organisations,
      this.projects,
      command.actorId,
      command.organisationId,
      command.projectId,
      'gate:manage',
    );
    if (access !== 'ok') return { status: access };
    if (!NAME.test(command.gate)) return { status: 'not_found' };
    // 256 random bits: nothing to guess. Only the hash is kept; the old address stops working.
    const token = randomBytes(32).toString('base64url');
    const stored = await this.traffic.setReportTokenHash(
      command.projectId,
      command.gate,
      sha256(token),
      iso(this.clock.now()),
    );
    if (!stored) return { status: 'not_found' };
    await this.audit.record(command.organisationId, command.actorId, {
      action: 'gate.report_token',
      target: command.projectId,
      details: { gate: command.gate },
    });
    const origin = this.config.get('MOAT_PUBLIC_ORIGIN', { infer: true });
    return { status: 'ok', url: `${origin}/api/report/${token}` };
  }
}

// ── Receiving a report ───────────────────────────────────────────────────────────────────────

export type ReceiveReportResult =
  /** Unknown or malformed token: the same answer, nothing tells which. */
  | { readonly status: 'not_found' }
  | { readonly status: 'limited'; readonly retryAfter: number }
  | {
      readonly status: 'refused';
      readonly code: TrafficReportRefusal | 'gate_mismatch';
    }
  | { readonly status: 'ok'; readonly buckets: number };

/**
 * A gate's report (no session: the token in the address is the credential). Read as the core
 * reads it (strict JSON, exact keys, sums consistent, hours complete and at most 30 days old);
 * the gate id must be the one pinned for this address. Stored as "reported by the gate" —
 * the numbers are the gate's claim and never change what any gate does.
 */
export class ReceiveReportCommand extends Command<ReceiveReportResult> {
  constructor(
    readonly token: string,
    readonly body: Uint8Array,
    readonly ip: string,
  ) {
    super();
  }
}

@CommandHandler(ReceiveReportCommand)
export class ReceiveReportHandler implements ICommandHandler<ReceiveReportCommand> {
  constructor(
    private readonly traffic: CloudTrafficStorePort,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
  ) {}

  async execute(command: ReceiveReportCommand): Promise<ReceiveReportResult> {
    const ipWait = await this.limiter.retryAfter(REPORT_PER_IP, command.ip);
    if (ipWait !== null) return { status: 'limited', retryAfter: ipWait };
    await this.limiter.record(REPORT_PER_IP, command.ip);
    if (!TOKEN.test(command.token)) return { status: 'not_found' };
    const gate = await this.traffic.findGateByReportTokenHash(
      sha256(command.token),
    );
    if (gate === null) return { status: 'not_found' };
    const subject = `${gate.projectId}/${gate.name}`;
    const gateWait = await this.limiter.retryAfter(REPORT_PER_GATE, subject);
    if (gateWait !== null) return { status: 'limited', retryAfter: gateWait };
    await this.limiter.record(REPORT_PER_GATE, subject);

    const now = this.clock.now();
    const seconds = Math.floor(now.getTime() / 1000);
    const parsed = parseTrafficReport(command.body, seconds);
    if (!parsed.ok) return { status: 'refused', code: parsed.code };
    if (parsed.report.gateId !== gate.gateId)
      return { status: 'refused', code: 'gate_mismatch' };
    const receivedAt = iso(now);
    const current = Math.floor(seconds / HOUR) * HOUR;
    await this.traffic.record(
      gate.projectId,
      gate.name,
      parsed.report.hours.map((bucket) => ({ ...bucket, receivedAt })),
      current - TRAFFIC_RETENTION_HOURS * HOUR,
    );
    return { status: 'ok', buckets: parsed.report.hours.length };
  }
}

// ── What the dashboard shows ─────────────────────────────────────────────────────────────────

export const TRAFFIC_DAYS = [1, 7, 30] as const;
export type TrafficDays = (typeof TRAFFIC_DAYS)[number];

export interface TrafficTotals {
  readonly requests: number;
  readonly s2: number;
  readonly s3: number;
  readonly s4: number;
  readonly s5: number;
  /** null without requests. */
  readonly msAverage: number | null;
  readonly msMax: number;
}

export interface GateTrafficView {
  readonly gate: string;
  readonly hasReportAddress: boolean;
  /** When the last report that holds an hour in the window arrived; null: none. */
  readonly lastReceivedAt: string | null;
  readonly totals: TrafficTotals;
  /** Per route (null = no route), most requests first. */
  readonly routes: readonly (TrafficTotals & {
    readonly route: string | null;
  })[];
  /** The gate's error codes in the window, most frequent first. */
  readonly errors: readonly { readonly code: string; readonly count: number }[];
  /** Per hour, oldest first, only hours with requests. */
  readonly hours: readonly {
    readonly hour: number;
    readonly requests: number;
    readonly failed: number;
  }[];
}

export type TrafficResult =
  | Access
  | {
      readonly status: 'ok';
      readonly from: number;
      readonly to: number;
      readonly gates: readonly GateTrafficView[];
    };

/** The project's reported traffic over the last `days` (FR-51). Needs `config:read`. */
export class ProjectTrafficQuery extends Query<TrafficResult> {
  constructor(
    readonly actorId: string,
    readonly organisationId: string,
    readonly projectId: string,
    readonly days: TrafficDays,
  ) {
    super();
  }
}

function totalsOf(rows: readonly TrafficRecord[]): TrafficTotals {
  const sum = (pick: (row: TrafficRecord) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);
  const requests = sum((row) => row.requests);
  return {
    requests,
    s2: sum((row) => row.s2),
    s3: sum((row) => row.s3),
    s4: sum((row) => row.s4),
    s5: sum((row) => row.s5),
    msAverage:
      requests === 0 ? null : Math.round(sum((row) => row.msTotal) / requests),
    msMax: rows.reduce((max, row) => Math.max(max, row.msMax), 0),
  };
}

@QueryHandler(ProjectTrafficQuery)
export class ProjectTrafficHandler implements IQueryHandler<ProjectTrafficQuery> {
  constructor(
    private readonly organisations: OrganisationRepositoryPort,
    private readonly projects: OrgProjectRepositoryPort,
    private readonly store: CloudProjectStorePort,
    private readonly traffic: CloudTrafficStorePort,
    private readonly clock: Clock,
  ) {}

  async execute(query: ProjectTrafficQuery): Promise<TrafficResult> {
    const access = await guard(
      this.organisations,
      this.projects,
      query.actorId,
      query.organisationId,
      query.projectId,
      'config:read',
    );
    if (access !== 'ok') return { status: access };
    const seconds = Math.floor(this.clock.now().getTime() / 1000);
    const to = Math.floor(seconds / HOUR) * HOUR;
    const from = to - query.days * 24 * HOUR;
    const [gates, withAddress, rows] = await Promise.all([
      this.store.listGates(query.projectId),
      this.traffic.gatesWithReportAddress(query.projectId),
      this.traffic.traffic(query.projectId, from),
    ]);
    return {
      status: 'ok',
      from,
      to,
      gates: gates.map((gate) => {
        const mine = rows.filter((row) => row.gate === gate.name);
        const routes = new Map<string | null, TrafficRecord[]>();
        const hours = new Map<number, TrafficRecord[]>();
        const errors = new Map<string, number>();
        for (const row of mine) {
          routes.set(row.route, [...(routes.get(row.route) ?? []), row]);
          hours.set(row.hour, [...(hours.get(row.hour) ?? []), row]);
          for (const [code, count] of Object.entries(row.errors))
            errors.set(code, (errors.get(code) ?? 0) + count);
        }
        return {
          gate: gate.name,
          hasReportAddress: withAddress.includes(gate.name),
          lastReceivedAt: mine.reduce<string | null>(
            (last, row) =>
              last === null || row.receivedAt > last ? row.receivedAt : last,
            null,
          ),
          totals: totalsOf(mine),
          routes: [...routes.entries()]
            .map(([route, list]) => ({ route, ...totalsOf(list) }))
            .sort((a, b) => b.requests - a.requests),
          errors: [...errors.entries()]
            .map(([code, count]) => ({ code, count }))
            .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1)),
          hours: [...hours.entries()]
            .map(([hour, list]) => ({
              hour,
              requests: list.reduce((n, row) => n + row.requests, 0),
              failed: list.reduce((n, row) => n + row.s4 + row.s5, 0),
            }))
            .sort((a, b) => a.hour - b.hour),
        };
      }),
    };
  }
}

export const TRAFFIC_HANDLERS = [
  CreateReportAddressHandler,
  ReceiveReportHandler,
  ProjectTrafficHandler,
];
