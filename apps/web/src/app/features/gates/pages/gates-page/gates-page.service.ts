import { computed, inject, Injectable } from '@angular/core';
import type { GateState } from '../../../../core/api/project.types';
import { ProjectResource } from '../../../../core/project/project-resource.service';

export type ValidGate = Extract<GateState, { status: 'valid' }>;

/**
 * Gates: every gate pinned in the project folder (`gates/<name>.json`) with its id, the
 * fingerprint of its box key to compare with what the gate printed (SEC-32), its trust mode,
 * the secrets sealed for it (names only, SEC-31) and the last bundle built.
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
}
