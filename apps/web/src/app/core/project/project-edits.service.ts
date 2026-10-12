import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  type ConfigEdit,
  EDIT_ERROR_CODES,
  type EditErrorCode,
  type ProjectView,
} from '../api/project.types';
import { apiUrl } from '../config/runtime-env';
import { ProjectResource } from './project-resource.service';

export type EditOutcome =
  | { readonly kind: 'saved' }
  | { readonly kind: 'error'; readonly code: EditErrorCode };

function errorCode(error: unknown): EditErrorCode {
  if (!(error instanceof HttpErrorResponse)) return 'failed';
  const body: unknown = error.error;
  const code =
    typeof body === 'object' && body !== null && 'error' in body
      ? body.error
      : null;
  return EDIT_ERROR_CODES.find((known) => known === code) ?? 'failed';
}

/**
 * Edits of the workspace project's moat.yaml (`POST /api/projects/:id/config/edits`), provided
 * next to ProjectResource. Each edit names the moat.yaml version the window shows; when the file
 * changed on disk meanwhile, nothing is written and the project is read again. An edit changes
 * the config only: a gate sees it with the next bundle (`moat build`), which the page says.
 */
@Injectable()
export class ProjectEdits {
  private readonly resource = inject(ProjectResource);
  private readonly http = inject(HttpClient);

  private readonly runningEdit = signal(false);
  /** One edit at a time: every edit button is disabled while one runs. */
  readonly busy = computed(
    () => this.runningEdit() || this.resource.view.isLoading(),
  );
  /** The outcome of the last edit, shown above the tabs until the next one. */
  readonly outcome = signal<EditOutcome | null>(null);

  async run(edit: ConfigEdit): Promise<boolean> {
    const view = this.resource.view.hasValue()
      ? this.resource.view.value()
      : null;
    if (view === null || view.configHash === null || this.busy()) return false;
    this.runningEdit.set(true);
    this.outcome.set(null);
    try {
      const next = await firstValueFrom(
        this.http.post<ProjectView>(
          apiUrl(`/projects/${encodeURIComponent(view.id)}/config/edits`),
          { base: view.configHash, ...edit },
        ),
      );
      this.resource.view.set(next);
      this.outcome.set({ kind: 'saved' });
      return true;
    } catch (error) {
      const code = errorCode(error);
      this.outcome.set({ kind: 'error', code });
      // Show what is on disk now; the edit can then be made again on top of it.
      if (code === 'config_changed') this.resource.reload();
      return false;
    } finally {
      this.runningEdit.set(false);
    }
  }

  dismiss(): void {
    this.outcome.set(null);
  }
}
