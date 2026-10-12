import { computed, inject, Injectable } from '@angular/core';
import { ProjectResource } from '../../../../core/project/project-resource.service';

/**
 * A project's overview (Übersicht): where its folder is, whether its moat.yaml is valid, how many
 * routes, upstreams, secrets and gates it has, and the trust mode.
 */
@Injectable()
export class OverviewPageService {
  readonly resource = inject(ProjectResource);

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
}
