import { computed, inject, Injectable } from '@angular/core';
import type { GateState } from '../../../../core/api/project.types';
import { ProjectEdits } from '../../../../core/project/project-edits.service';
import { ProjectResource } from '../../../../core/project/project-resource.service';

export type ValidGate = Extract<GateState, { status: 'valid' }>;

/**
 * Gates: every gate pinned in the project folder (`gates/<name>.json`) with its id, the
 * fingerprint of its box key to compare with what the gate printed (SEC-32), its trust mode,
 * the secrets sealed for it (names only, SEC-31), the last bundle built, its environment and
 * whether moat.yaml locks it — and whether the last bundle already carries that. The environment
 * and the gate's own lock are changed here (ProjectEdits).
 */
@Injectable()
export class GatesPageService {
  readonly resource = inject(ProjectResource);
  readonly edits = inject(ProjectEdits);

  /** The environments a gate can be put into; empty while the config is not valid. */
  readonly environments = computed(() => {
    const config = this.resource.config();
    return config?.status === 'valid'
      ? config.environments.map((environment) => environment.name)
      : [];
  });
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

  /** The «Umgebung» list of a gate changed. */
  async choose(gate: ValidGate, event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    // Refused or failed: the list shows what moat.yaml says again.
    if (!(await this.assign(gate, target.value)))
      target.value = gate.lock?.environment ?? '';
  }

  /** Puts the gate into `environment` (moving it out of its current one). */
  assign(gate: ValidGate, environment: string): Promise<boolean> {
    if (environment === '' || environment === gate.lock?.environment)
      return Promise.resolve(false);
    return this.edits.run({ op: 'assignGate', gate: gate.name, environment });
  }

  setLocked(gate: ValidGate, locked: boolean): Promise<boolean> {
    return this.edits.run({
      op: locked ? 'lockGate' : 'unlockGate',
      gate: gate.name,
    });
  }
}
