import { httpResource } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { ProjectSummary } from '../../../../core/api/project.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import { desktopBridge } from '../../../../core/desktop/desktop-bridge';

/**
 * Projekte, the start page: every project in the list with the state of its moat.yaml, its
 * counts and gates that still lack a secret. A project is added through the desktop shell's own
 * folder dialog (DT-08) and opens right away.
 */
@Injectable()
export class ProjectsPageService {
  private readonly router = inject(Router);
  private readonly bridge = desktopBridge();

  readonly list = httpResource<readonly ProjectSummary[]>(() =>
    apiUrl('/projects'),
  );
  /** Only Moat Desktop can add a folder. */
  readonly canAdd = this.bridge !== null;
  readonly addFailed = signal(false);

  async add(): Promise<void> {
    if (this.bridge === null) return;
    this.addFailed.set(false);
    try {
      const result = await this.bridge.project.add();
      if (result.status === 'added') {
        await this.router.navigate(['/app/projects', result.id]);
      } else if (result.status === 'failed') {
        this.addFailed.set(true);
      }
    } catch {
      this.addFailed.set(true);
    }
  }
}
