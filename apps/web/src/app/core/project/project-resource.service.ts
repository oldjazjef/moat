import { httpResource } from '@angular/common/http';
import { computed, Injectable } from '@angular/core';
import type { ProjectView } from '../api/project.types';
import { apiUrl } from '../config/runtime-env';

/**
 * The open project (`GET /api/project`), shared by the pages that show it: loaded once,
 * re-read with `reload()` (the "Neu laden" button — the folder may change on disk).
 */
@Injectable({ providedIn: 'root' })
export class ProjectResource {
  readonly view = httpResource<ProjectView>(() => apiUrl('/project'));

  /** The project, or null while none is open (or still loading). */
  readonly project = computed(() =>
    this.view.hasValue() ? this.view.value().project : null,
  );
  readonly folder = computed(() =>
    this.view.hasValue() ? this.view.value().folder : null,
  );
  readonly config = computed(() => this.project()?.config ?? null);
  readonly gates = computed(() => this.project()?.gates ?? []);

  reload(): void {
    this.view.reload();
  }
}
