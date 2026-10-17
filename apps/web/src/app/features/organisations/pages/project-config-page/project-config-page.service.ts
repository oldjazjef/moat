import { HttpClient, httpResource } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { ConfigView } from '../../../../core/api/gates.types';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import { apiUrl } from '../../../../core/config/runtime-env';
import { OrgScope } from '../../org-scope';

/**
 * «Konfiguration» of a Cloud project: its moat.yaml as text. A change names the hash of the file
 * the person started from; if it changed meanwhile, nothing is written (`config_changed`) and the
 * person decides: reload, or keep the text and copy it. Moat Cloud parses the file as a gate
 * would and refuses what it refuses. A secret never belongs in this file (SEC-20).
 */
@Injectable()
export class ProjectConfigPageService {
  private readonly http = inject(HttpClient);
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
  readonly config = httpResource<ConfigView>(() => {
    const base = this.base();
    return base === null ? undefined : apiUrl(`${base}/config`);
  });

  /** The editor's text; null until the person types (then the file's text is shown). */
  readonly draft = signal<string | null>(null);
  readonly text = computed(
    () =>
      this.draft() ??
      (this.config.hasValue() ? (this.config.value().text ?? '') : ''),
  );
  readonly dirty = computed(
    () =>
      this.draft() !== null &&
      this.config.hasValue() &&
      this.draft() !== (this.config.value().text ?? ''),
  );
  readonly canWrite = computed(() => this.scope.can('config:write'));
  readonly busy = signal(false);
  readonly error = signal<ApiErrorCode | null>(null);
  readonly saved = signal(false);

  edit(text: string): void {
    this.draft.set(text);
    this.saved.set(false);
  }

  /** Throws away the text and reads the file as it is now. */
  reload(): void {
    this.draft.set(null);
    this.error.set(null);
    this.saved.set(false);
    this.config.reload();
  }

  async save(): Promise<void> {
    const base = this.base();
    const current = this.config.hasValue() ? this.config.value() : null;
    if (base === null || current === null) return;
    this.error.set(null);
    this.saved.set(false);
    this.busy.set(true);
    try {
      await firstValueFrom(
        this.http.put<ConfigView>(apiUrl(`${base}/config`), {
          text: this.text(),
          ...(current.hash === null ? {} : { base: current.hash }),
        }),
      );
      this.draft.set(null);
      this.config.reload();
      this.saved.set(true);
    } catch (error) {
      this.error.set(apiErrorCode(error));
    } finally {
      this.busy.set(false);
    }
  }
}
