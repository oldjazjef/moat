import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { computed, inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';
import type { ProjectView } from '../api/project.types';
import { apiUrl } from '../config/runtime-env';

/**
 * The project of the workspace (`GET /api/projects/:id`), provided by the project workspace and
 * shared by its tabs (Übersicht, Gates, Routen): loaded once, re-read with `reload()` (the
 * "Neu laden" button — the folder may change on disk).
 */
@Injectable()
export class ProjectResource {
  private readonly route = inject(ActivatedRoute);

  readonly id = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    { initialValue: '' },
  );
  readonly view = httpResource<ProjectView>(() =>
    this.id() === ''
      ? undefined
      : apiUrl(`/projects/${encodeURIComponent(this.id())}`),
  );

  /** `/app/projects/<id>`, the base of the workspace's tabs. */
  readonly base = computed(() => `/app/projects/${this.id()}`);
  readonly name = computed(() =>
    this.view.hasValue() ? this.view.value().name : null,
  );
  readonly folder = computed(() =>
    this.view.hasValue() ? this.view.value().folder : null,
  );
  /** The project's contents; null while loading, or when its folder can no longer be read. */
  readonly project = computed(() =>
    this.view.hasValue() ? this.view.value().project : null,
  );
  readonly config = computed(() => this.project()?.config ?? null);
  readonly gates = computed(() => this.project()?.gates ?? []);
  /** The id is not (or no longer) in the project list. */
  readonly notFound = computed(() => {
    const error = this.view.error();
    return error instanceof HttpErrorResponse && error.status === 404;
  });

  reload(): void {
    this.view.reload();
  }
}
