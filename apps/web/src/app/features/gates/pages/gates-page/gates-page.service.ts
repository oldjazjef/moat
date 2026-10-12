import { computed, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { GateState } from '../../../../core/api/project.types';
import {
  type BundleSignResult,
  desktopBridge,
} from '../../../../core/desktop/desktop-bridge';
import { ProjectEdits } from '../../../../core/project/project-edits.service';
import { ProjectResource } from '../../../../core/project/project-resource.service';

/** Every outcome with a text (`gates.signResult.<outcome>`); a cancel says nothing. */
export const SIGN_OUTCOMES = [
  'signed',
  'config_missing',
  'config_invalid',
  'gate_unknown',
  'secrets_missing',
  'not_writable',
  'failed',
] as const;

export type ValidGate = Extract<GateState, { status: 'valid' }>;

/**
 * Gates: every gate pinned in the project folder (`gates/<name>.json`) with its id, the
 * fingerprint of its box key to compare with what the gate printed (SEC-32), its trust mode,
 * the secrets sealed for it (names only, SEC-31), the last bundle built, its environment and
 * whether moat.yaml locks it — and whether the last bundle already carries that. The environment
 * and the gate's own lock are changed here (ProjectEdits). In Moat Desktop, «Bundle signieren»
 * opens the main process's signing dialog (DT-15); the page only shows the outcome.
 */
@Injectable()
export class GatesPageService {
  readonly resource = inject(ProjectResource);
  readonly edits = inject(ProjectEdits);
  private readonly bridge = desktopBridge();
  private readonly translate = inject(TranslateService);

  /** Only Moat Desktop signs (with the key file, in its own dialog). */
  readonly canSign = this.bridge !== null;
  /** The gate whose signing dialog is open. */
  readonly signing = signal<string | null>(null);
  /** The last signing outcome worth saying, by gate (a cancel says nothing). */
  readonly signed = signal<{
    readonly gate: string;
    readonly result: Exclude<BundleSignResult, { status: 'cancelled' }>;
  } | null>(null);

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

  async sign(gate: ValidGate): Promise<void> {
    if (this.bridge === null || this.signing() !== null) return;
    this.signing.set(gate.name);
    this.signed.set(null);
    let result: BundleSignResult;
    try {
      result = await this.bridge.bundle.sign(
        this.resource.id(),
        gate.name,
        this.translate.getCurrentLang() ?? '',
      );
    } catch {
      result = { status: 'failed' };
    } finally {
      this.signing.set(null);
    }
    if (result.status !== 'cancelled')
      this.signed.set({ gate: gate.name, result });
    // A new bundle file, or what blocked it may be shown differently now: read the project again.
    if (result.status === 'signed' || result.status === 'refused')
      this.resource.reload();
  }

  /** The i18n key for a signing outcome (`gates.signResult.*`). */
  signText(result: Exclude<BundleSignResult, { status: 'cancelled' }>): string {
    return result.status === 'refused'
      ? `gates.signResult.${result.code}`
      : `gates.signResult.${result.status}`;
  }

  signParams(
    result: Exclude<BundleSignResult, { status: 'cancelled' }>,
    gate: string,
  ): Record<string, string | number> {
    if (result.status === 'signed') return { gate, version: result.version };
    if (result.status === 'refused')
      return { gate, secrets: result.secrets.join(', ') };
    return { gate };
  }
}
