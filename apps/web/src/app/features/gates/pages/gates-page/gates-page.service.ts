import { computed, inject, Injectable } from '@angular/core';
import type { GateState } from '../../../../core/api/project.types';
import { ProjectResource } from '../../../../core/project/project-resource.service';

export type ValidGate = Extract<GateState, { status: 'valid' }>;

/**
 * Gates: every gate pinned in the project folder (`gates/<name>.json`) with its id, the
 * fingerprint of its box key to compare with what the gate printed (SEC-32), its trust mode,
 * the secrets sealed for it (names only, SEC-31), the last bundle built, its environment and
 * whether moat.yaml locks it — and whether the last bundle already carries that.
 */
@Injectable()
export class GatesPageService {
  readonly resource = inject(ProjectResource);
  readonly valid = computed(() =>
    this.resource
      .gates()
      .filter((gate): gate is ValidGate => gate.status === 'valid'),
  );
  readonly invalid = computed(() =>
    this.resource.gates().filter((gate) => gate.status === 'invalid'),
  );

  /**
   * When moat.yaml and the last bundle disagree about the lock: the change applies only with the
   * next bundle. Null when they agree, or there is no readable bundle to compare with.
   */
  pending(gate: ValidGate): 'lockPending' | 'unlockPending' | null {
    if (gate.lock === null || gate.latestBundleLocked === null) return null;
    if (!gate.lock.enabled && !gate.latestBundleLocked) return 'lockPending';
    if (gate.lock.enabled && gate.latestBundleLocked) return 'unlockPending';
    return null;
  }
}
