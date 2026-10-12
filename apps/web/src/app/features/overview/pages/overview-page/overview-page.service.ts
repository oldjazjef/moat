import { computed, inject, Injectable } from '@angular/core';
import { ProjectResource } from '../../../../core/project/project-resource.service';

/**
 * A project's overview (Übersicht): where its folder is, whether its moat.yaml is valid, how many
 * routes, upstreams, secrets and gates it has, the trust mode, and its environments with their
 * locks (FR-01).
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

  /** moat.yaml `environments`; empty while the config is not valid. */
  readonly environments = computed(() => {
    const config = this.resource.config();
    return config?.status === 'valid' ? config.environments : [];
  });

  /** Pinned gates of no environment. */
  readonly unassigned = computed(() =>
    this.resource
      .gates()
      .filter(
        (gate) => gate.status === 'valid' && gate.lock?.environment === null,
      )
      .map((gate) => gate.name),
  );

  /** Gates locked on their own (an environment's lock shows on the environment). */
  readonly gatesLocked = computed(
    () =>
      new Set(
        this.resource
          .gates()
          .filter((gate) => gate.status === 'valid' && gate.lock?.gateLocked)
          .map((gate) => gate.name),
      ),
  );
}
