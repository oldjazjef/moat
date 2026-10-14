import { computed, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { GateState } from '../../../../core/api/project.types';
import {
  type BundleSignResult,
  type DeployResult,
  type DeployTarget,
  desktopBridge,
  type SecretSealResult,
} from '../../../../core/desktop/desktop-bridge';
import type { RowAction } from '../../../../shared/components/row-actions';
import { ProjectEdits } from '../../../../core/project/project-edits.service';
import { ProjectResource } from '../../../../core/project/project-resource.service';

/** Every seal outcome with a text (`gates.sealResult.<outcome>`); a cancel says nothing. */
export const SEAL_OUTCOMES = [
  'sealed',
  'config_missing',
  'config_invalid',
  'gate_unknown',
  'secret_unknown',
  'secret_unreadable',
  'not_writable',
  'failed',
] as const;

/** One secret of a gate: what the config uses and what is sealed for the gate. */
export interface SecretRow {
  readonly name: string;
  /** Sealed version, null when not sealed for this gate yet. */
  readonly version: number | null;
  /** moat.yaml uses it (an upstream sends it). */
  readonly used: boolean;
}

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

/** Every deploy outcome with a text (`gates.deployResult.<outcome>`); a cancel says nothing. */
export const DEPLOY_OUTCOMES = [
  'exported_zip',
  'exported_folder',
  'key_missing',
  'gate_unknown',
  'bundle_missing',
  'bundle_unverified',
  'gate_changed',
  'bundle_older',
  'exists',
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
  /** Only Moat Desktop seals (in its own window: the page never sees a value). */
  readonly canSeal = this.bridge !== null;
  /** Only Moat Desktop checks from outside (DT-07): the Cloud does not call out (T-59). */
  readonly canCheck = this.bridge !== null;
  /** Only Moat Desktop saves deploy packages (where: its own dialog, DT-05). */
  readonly canDeploy = this.bridge !== null;
  /** The gate whose deploy dialog is open. */
  readonly deploying = signal<string | null>(null);
  readonly deployed = signal<{
    readonly gate: string;
    readonly result: Exclude<DeployResult, { status: 'cancelled' }>;
  } | null>(null);
  /** `<gate>/<secret>` whose seal window is open. */
  readonly sealing = signal<string | null>(null);
  readonly sealed = signal<{
    readonly gate: string;
    readonly name: string;
    readonly result: Exclude<SecretSealResult, { status: 'cancelled' }>;
  } | null>(null);

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

  /** The latest bundle as a ZIP or into a folder, where the person chooses in the desktop. */
  async deploy(gate: ValidGate, target: DeployTarget): Promise<void> {
    if (this.bridge === null || this.deploying() !== null) return;
    this.deploying.set(gate.name);
    this.deployed.set(null);
    let result: DeployResult;
    try {
      result = await this.bridge.gate.deploy(
        this.resource.id(),
        gate.name,
        target,
        this.translate.getCurrentLang() ?? '',
      );
    } catch {
      result = { status: 'failed' };
    } finally {
      this.deploying.set(null);
    }
    if (result.status !== 'cancelled')
      this.deployed.set({ gate: gate.name, result });
  }

  /** The i18n key for a deploy outcome (`gates.deployResult.*`). */
  deployText(result: Exclude<DeployResult, { status: 'cancelled' }>): string {
    if (result.status === 'exported')
      return `gates.deployResult.exported_${result.target}`;
    return result.status === 'refused'
      ? `gates.deployResult.${result.code}`
      : `gates.deployResult.${result.status}`;
  }

  deployParams(
    result: Exclude<DeployResult, { status: 'cancelled' }>,
    gate: string,
  ): Record<string, string | number> {
    return result.status === 'exported'
      ? { gate, version: result.version }
      : { gate };
  }

  /** What the config uses and what is sealed, by name; names only (SEC-31). */
  secretRows(gate: ValidGate): readonly SecretRow[] {
    const config = this.resource.config();
    const used = new Set(config?.status === 'valid' ? config.secretNames : []);
    const versions = new Map(
      gate.secrets.map((secret) => [secret.name, secret.secretVersion]),
    );
    return [...new Set([...used, ...versions.keys()])].sort().map((name) => ({
      name,
      version: versions.get(name) ?? null,
      used: used.has(name),
    }));
  }

  /** One action, so a plain button at the row's end: seal, or seal a new version. */
  secretActions(row: SecretRow): readonly RowAction[] {
    return [
      {
        id: 'seal',
        labelKey: row.version === null ? 'gates.seal' : 'gates.reseal',
      },
    ];
  }

  async seal(gate: ValidGate, name: string): Promise<void> {
    if (this.bridge === null || this.sealing() !== null) return;
    this.sealing.set(`${gate.name}/${name}`);
    this.sealed.set(null);
    let result: SecretSealResult;
    try {
      result = await this.bridge.secret.seal(
        this.resource.id(),
        gate.name,
        name,
        this.translate.getCurrentLang() ?? '',
      );
    } catch {
      result = { status: 'failed' };
    } finally {
      this.sealing.set(null);
    }
    if (result.status === 'cancelled') return;
    this.sealed.set({ gate: gate.name, name, result });
    if (result.status === 'sealed' || result.status === 'refused')
      this.resource.reload();
  }

  sealText(result: Exclude<SecretSealResult, { status: 'cancelled' }>): string {
    return result.status === 'refused'
      ? `gates.sealResult.${result.code}`
      : `gates.sealResult.${result.status}`;
  }

  sealParams(
    result: Exclude<SecretSealResult, { status: 'cancelled' }>,
    gate: string,
    name: string,
  ): Record<string, string | number> {
    return result.status === 'sealed'
      ? { gate, name, version: result.secretVersion }
      : { gate, name };
  }
}
