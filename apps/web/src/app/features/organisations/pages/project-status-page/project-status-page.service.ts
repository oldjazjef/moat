import { httpResource } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { ProjectStatus } from '../../../../core/api/gates.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import { OrgScope } from '../../org-scope';

/**
 * «Status» of a Cloud project: what needs attention, worked out from what Moat Cloud stores
 * (FR-51/52). No gate reports to Moat Cloud, so this says nothing about traffic, errors or
 * latency; the page says so.
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
