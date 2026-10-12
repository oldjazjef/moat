import { computed, inject, Injectable, signal } from '@angular/core';
import {
  desktopBridge,
  type ProjectChangeResult,
} from '../../../../core/desktop/desktop-bridge';
import { ProjectResource } from '../../../../core/project/project-resource.service';

/**
 * The overview (Übersicht): which project folder is open, whether its moat.yaml is valid, how
 * many routes, upstreams and gates it has, and the trust mode. Opening another folder goes
 * through the desktop shell's own dialog (DT-08) and restarts the app with it.
 */
@Injectable()
export class OverviewPageService {
  readonly resource = inject(ProjectResource);
  private readonly bridge = desktopBridge();
  /** Only Moat Desktop can open a folder. */
  readonly canChoose = this.bridge !== null;
  /** The last folder choice that did not restart the app ('failed' shows a message). */
  readonly choice = signal<ProjectChangeResult['status'] | null>(null);

  readonly counts = computed(() => {
    const config = this.resource.config();
    const valid = config?.status === 'valid' ? config : null;
    return {
      routes: valid ? Object.keys(valid.config.routes).length : 0,
      upstreams: valid ? Object.keys(valid.config.upstreams).length : 0,
      secrets: valid ? valid.secretNames.length : 0,
      gates: this.resource.gates().length,
    };
  });

  /** Secrets the config uses that some gate has not sealed yet. */
  readonly gatesMissingSecrets = computed(() =>
    this.resource
      .gates()
      .filter(
        (gate) => gate.status === 'valid' && gate.missingSecrets.length > 0,
      )
      .map((gate) => gate.name),
  );

  async choose(): Promise<void> {
    if (this.bridge === null) return;
    this.choice.set(null);
    try {
      this.choice.set((await this.bridge.project.choose()).status);
    } catch {
      this.choice.set('failed');
    }
  }

  async reveal(): Promise<void> {
    await this.bridge?.project.reveal();
  }
}
