import { httpResource } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  GateTraffic,
  ProjectStatus,
  ProjectTraffic,
  TrafficDays,
} from '../../../../core/api/gates.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import { OrgScope } from '../../org-scope';

/**
 * «Status» of a Cloud project: what needs attention, worked out from what Moat Cloud stores
 * (FR-51/52), and the traffic the gates with a report address reported (FR-50, T-110) — shown as
 * reported by the gate, never as fact.
 */
@Injectable()
export class ProjectStatusPageService {
  readonly scope = inject(OrgScope);
  private readonly source = signal<(() => string) | null>(null);
  readonly projectId = computed(() => this.source()?.() ?? null);

  bind(projectId: () => string): void {
    this.source.set(projectId);
  }

  private base(): string | null {
    const org = this.scope.orgId();
    const project = this.projectId();
    return org === null || project === null
      ? null
      : `/orgs/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}`;
  }

  readonly project = httpResource<{
    readonly project: { readonly name: string };
  }>(() => {
    const base = this.base();
    return base === null ? undefined : apiUrl(base);
  });
  readonly status = httpResource<ProjectStatus>(() => {
    const base = this.base();
    return base === null ? undefined : apiUrl(`${base}/status`);
  });

  /** The window of the traffic shown: the last 1, 7 or 30 days. */
  readonly days = signal<TrafficDays>(7);
  readonly traffic = httpResource<ProjectTraffic>(() => {
    const base = this.base();
    return base === null
      ? undefined
      : apiUrl(`${base}/traffic?days=${this.days()}`);
  });

  trafficOf(gate: string): GateTraffic | null {
    return this.traffic.hasValue()
      ? (this.traffic.value().gates.find((entry) => entry.gate === gate) ??
          null)
      : null;
  }

  /** Answers of 400 and above, as a share of all requests (one decimal). */
  failedShare(traffic: GateTraffic): string {
    const { requests, s4, s5 } = traffic.totals;
    return requests === 0 ? '0' : ((100 * (s4 + s5)) / requests).toFixed(1);
  }

  /** The busiest hour, as the scale of the little bars. */
  peak(traffic: GateTraffic): number {
    return traffic.hours.reduce((max, hour) => Math.max(max, hour.requests), 0);
  }

  /** Findings of the whole project and of its gates, counted. */
  readonly attention = computed(() => {
    const value = this.status.hasValue() ? this.status.value() : null;
    if (value === null) return 0;
    return (
      value.project.filter((f) => f.severity !== 'info').length +
      value.gates.reduce(
        (sum, gate) =>
          sum + gate.findings.filter((f) => f.severity !== 'info').length,
        0,
      )
    );
  });
}
