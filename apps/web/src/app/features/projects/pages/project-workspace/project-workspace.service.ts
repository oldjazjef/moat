import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../../../../core/config/runtime-env';
import { desktopBridge } from '../../../../core/desktop/desktop-bridge';
import { ProjectResource } from '../../../../core/project/project-resource.service';

/** The workspace's tabs, in order: `projects.tabs.<id>`, route `<base>/<id>`. */
export const PROJECT_TABS = ['overview', 'gates', 'routes', 'console'] as const;

/**
 * One project's workspace: its header (name, folder, "Neu laden", "Im Ordner zeigen"), the tabs,
 * and taking it off the list — two clicks, and only the list entry: the folder stays untouched.
 */
@Injectable()
export class ProjectWorkspaceService {
  readonly resource = inject(ProjectResource);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly bridge = desktopBridge();

  readonly tabs = PROJECT_TABS;
  /** Only Moat Desktop can show a folder in the file manager. */
  readonly canReveal = this.bridge !== null;
  /** First click on "Aus der Liste entfernen" asks, the second removes. */
  readonly confirmingRemove = signal(false);
  readonly removeFailed = signal(false);

  async reveal(): Promise<void> {
    await this.bridge?.project.reveal(this.resource.id());
  }

  async remove(): Promise<void> {
    if (!this.confirmingRemove()) {
      this.confirmingRemove.set(true);
      return;
    }
    this.removeFailed.set(false);
    try {
      await firstValueFrom(
        this.http.delete(
          apiUrl(`/projects/${encodeURIComponent(this.resource.id())}`),
        ),
      );
      await this.router.navigate(['/app/projects']);
    } catch {
      this.confirmingRemove.set(false);
      this.removeFailed.set(true);
    }
  }

  cancelRemove(): void {
    this.confirmingRemove.set(false);
  }
}
