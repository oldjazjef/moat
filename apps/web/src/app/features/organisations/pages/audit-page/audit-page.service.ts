import { HttpClient } from '@angular/common/http';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  AuditEntryView,
  AuditVerification,
} from '../../../../core/auth/account.types';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import { apiUrl } from '../../../../core/config/runtime-env';
import { OrgScope } from '../../org-scope';

const PAGE = 50;

/**
 * «Protokoll»: the organisation's audit log (SEC-53, FR-53), newest rows last as the chain runs.
 * The page reads it page by page (`next` continues with `after`) and can ask Moat Cloud to
 * re-compute the whole chain. The check is tamper-evident only: the head shown after it is what
 * an auditor writes down outside the database to catch a cut-off tail (T-87).
 */
@Injectable()
export class AuditPageService {
  private readonly http = inject(HttpClient);
  readonly scope = inject(OrgScope);

  readonly canRead = computed(() => this.scope.can('audit:read'));
  readonly entries = signal<readonly AuditEntryView[]>([]);
  /** `after` for the next page; null: everything is loaded. */
  readonly next = signal<number | null>(null);
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly error = signal<ApiErrorCode | null>(null);
  readonly verification = signal<AuditVerification | null>(null);
  readonly verifying = signal(false);

  readonly exportJsonUrl = computed(() => this.exportUrl('json'));
  readonly exportCsvUrl = computed(() => this.exportUrl('csv'));

  private started = false;

  constructor() {
    // Read the first page once the API has said the account may read the log.
    effect(() => {
      if (this.canRead() && !this.started) {
        this.started = true;
        void this.loadMore();
      }
    });
  }

  async loadMore(): Promise<void> {
    const orgId = this.scope.orgId();
    if (orgId === null || this.loading()) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const after = this.next() ?? 0;
      const page = await firstValueFrom(
        this.http.get<{
          readonly entries: readonly AuditEntryView[];
          readonly next: number | null;
        }>(
          apiUrl(
            `/orgs/${encodeURIComponent(orgId)}/audit?after=${after}&limit=${PAGE}`,
          ),
        ),
      );
      this.entries.update((rows) => [...rows, ...page.entries]);
      this.next.set(page.next);
    } catch (error) {
      this.error.set(apiErrorCode(error));
    } finally {
      this.loaded.set(true);
      this.loading.set(false);
    }
  }

  async verify(): Promise<void> {
    const orgId = this.scope.orgId();
    if (orgId === null || this.verifying()) return;
    this.verifying.set(true);
    this.error.set(null);
    try {
      this.verification.set(
        await firstValueFrom(
          this.http.get<AuditVerification>(
            apiUrl(`/orgs/${encodeURIComponent(orgId)}/audit/verify`),
          ),
        ),
      );
    } catch (error) {
      this.error.set(apiErrorCode(error));
    } finally {
      this.verifying.set(false);
    }
  }

  /** The details of a row as `key: value` pairs; anything that is not a flat object shows as is. */
  detailPairs(entry: AuditEntryView): readonly (readonly [string, string])[] {
    try {
      const value: unknown = JSON.parse(entry.details);
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        return [];
      return Object.entries(value as Record<string, unknown>).map(
        ([key, item]) => [key, String(item)] as const,
      );
    } catch {
      return [];
    }
  }

  private exportUrl(format: 'json' | 'csv'): string | null {
    const orgId = this.scope.orgId();
    return orgId === null || !this.canRead()
      ? null
      : apiUrl(
          `/orgs/${encodeURIComponent(orgId)}/audit/export?format=${format}`,
        );
  }
}
