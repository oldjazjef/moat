import {
  HttpClient,
  HttpErrorResponse,
  httpResource,
} from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  ConfigText,
  ConfigTextIssue,
} from '../../../../core/api/project.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import { ProjectResource } from '../../../../core/project/project-resource.service';

/** `configEditor.errors.<code>`: why «Speichern» wrote nothing (besides the issues). */
export const CONFIG_EDITOR_ERRORS = [
  'config_changed',
  'config_too_large',
  'not_writable',
  'failed',
] as const;
export type ConfigEditorError = (typeof CONFIG_EDITOR_ERRORS)[number];

/**
 * The project's moat.yaml in the editor: loaded as text with its hash, saved as a whole against
 * that hash (nothing is lost to a change on disk in between), checked by the API as strictly as
 * the CLI before anything is written. It is the project's one file: every gate gets what it says,
 * with its next signed bundle.
 */
@Injectable()
export class ConfigPageService {
  private readonly http = inject(HttpClient);
  readonly resource = inject(ProjectResource);

  readonly loaded = httpResource<ConfigText>(() =>
    this.resource.id() === ''
      ? undefined
      : apiUrl(`/projects/${encodeURIComponent(this.resource.id())}/config`),
  );
  /** What the editor holds; null: untouched, the loaded text. */
  private readonly draft = signal<string | null>(null);
  readonly text = computed(
    () =>
      this.draft() ??
      (this.loaded.hasValue() ? (this.loaded.value().text ?? '') : ''),
  );
  readonly dirty = computed(() => {
    const draft = this.draft();
    if (draft === null || !this.loaded.hasValue()) return false;
    return draft !== (this.loaded.value().text ?? '');
  });
  readonly busy = signal(false);
  readonly saved = signal(false);
  readonly issues = signal<readonly ConfigTextIssue[]>([]);
  readonly error = signal<ConfigEditorError | null>(null);

  edit(text: string): void {
    this.draft.set(text);
    this.saved.set(false);
  }

  /** «Verwerfen» and «Neu laden»: back to what is on disk. */
  reload(): void {
    this.draft.set(null);
    this.issues.set([]);
    this.error.set(null);
    this.saved.set(false);
    this.loaded.reload();
  }

  async save(): Promise<void> {
    if (this.busy() || !this.loaded.hasValue()) return;
    this.busy.set(true);
    this.issues.set([]);
    this.error.set(null);
    this.saved.set(false);
    try {
      const result = await firstValueFrom(
        this.http.put<ConfigText>(
          apiUrl(`/projects/${encodeURIComponent(this.resource.id())}/config`),
          { base: this.loaded.value().hash, text: this.text() },
        ),
      );
      this.loaded.set(result);
      this.draft.set(null);
      this.saved.set(true);
      // Gates, routes and the overview read the project again.
      this.resource.reload();
    } catch (error) {
      this.refused(error);
    } finally {
      this.busy.set(false);
    }
  }

  private refused(error: unknown): void {
    if (!(error instanceof HttpErrorResponse)) {
      this.error.set('failed');
      return;
    }
    const body = error.error as {
      error?: unknown;
      issues?: readonly ConfigTextIssue[];
    } | null;
    if (body?.error === 'config_invalid' && Array.isArray(body.issues)) {
      this.issues.set(body.issues);
      return;
    }
    this.error.set(
      CONFIG_EDITOR_ERRORS.find((code) => code === body?.error) ?? 'failed',
    );
  }
}
