import { computed, inject, Injectable, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import type { GateState, TrustMode } from '../../../../core/api/project.types';
import {
  type BundleSignResult,
  type DeployResult,
  type DeployTarget,
  desktopBridge,
  type ImportFrom,
  type ImportResult,
  type PasskeyStatus,
  type RequestLogResult,
  type SecretSealResult,
  type SigningKeyInfo,
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
  'exported_sftp',
  'exported_ftps',
  'exported_git',
  'committed',
  'key_missing',
  'gate_unknown',
  'bundle_missing',
  'bundle_unverified',
  'gate_changed',
  'bundle_older',
  'git_not_a_repo',
  'git_detached',
  'git_no_upstream',
  'git_ignored',
  'git_unsafe_config',
  'git_ahead',
  'exists',
  'not_writable',
  'git_failed',
  'failed',
] as const;

/** Every import outcome with a text (`gates.importResult.<outcome>`); a cancel says nothing. */
export const IMPORT_OUTCOMES = [
  'imported',
  'key_missing',
  'gate_unknown',
  'unreadable',
  'too_large',
  'package_invalid',
  'bundle_invalid',
  'signature_invalid',
  'gate_mismatch',
  'version_not_newer',
  'config_invalid',
  'not_writable',
  'failed',
] as const;

/** Every log refusal with a text (`gates.logResult.<code>`). */
export const LOG_OUTCOMES = [
  'unreadable',
  'too_large',
  'no_entries',
  'failed',
] as const;

/** Why a passkey could not be created or a gate not switched (`gates.passkey.notices.<code>`). */
export const PASSKEY_NOTICES = [
  'unavailable',
  'cancelled',
  'failed',
  'set_failed',
] as const;
export type PasskeyNotice = (typeof PASSKEY_NOTICES)[number];

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
  /** Only Moat Desktop imports bundles (what: its own dialog, FR-45). */
  readonly canImport = this.bridge !== null;
  /** The gate whose import dialog is open. */
  readonly importing = signal<string | null>(null);
  readonly imported = signal<{
    readonly gate: string;
    readonly result: Exclude<ImportResult, { status: 'cancelled' }>;
  } | null>(null);
  /** Only Moat Desktop reads a gate's log files (which: its own dialog, DT-12). */
  readonly canReadLog = this.bridge !== null;
  /** The gate whose log dialog is open. */
  readonly readingLog = signal<string | null>(null);
  readonly logRead = signal<{
    readonly gate: string;
    readonly result: Exclude<RequestLogResult, { status: 'cancelled' }>;
  } | null>(null);
  /** `<gate>/<secret>` whose seal window is open. */
  readonly sealing = signal<string | null>(null);
  readonly sealed = signal<{
    readonly gate: string;
    readonly name: string;
    readonly result: Exclude<SecretSealResult, { status: 'cancelled' }>;
  } | null>(null);

  /** The key an open rotation (SEC-08) replaces, and the one that replaces it. */
  readonly rotation = signal<{
    readonly previous: SigningKeyInfo;
    readonly current: SigningKeyInfo;
  } | null>(null);

  /** The gate whose signing dialog is open. */
  readonly signing = signal<string | null>(null);
  /** The last signing outcome worth saying, by gate (a cancel says nothing). */
  readonly signed = signal<{
    readonly gate: string;
    readonly result: Exclude<BundleSignResult, { status: 'cancelled' }>;
  } | null>(null);

  /** Trust mode 2 (docs/CRYPTO.md §7): only Moat Desktop has a passkey window. */
  readonly canPasskey = this.bridge?.passkey !== undefined;
  /** The passkey and the gates of this project set to sign with it; null until read. */
  readonly passkey = signal<PasskeyStatus | null>(null);
  readonly passkeyBusy = signal(false);
  readonly passkeyNotice = signal<PasskeyNotice | null>(null);
  /** The passkey was created just now: say what to do next. */
  readonly passkeyCreated = signal(false);

  constructor() {
    void this.loadRotation();
    void this.loadPasskey();
  }

  /**
   * The mode the badge shows: "passkey" only for a gate the person set to sign with the passkey
   * (a local setting of Moat Desktop), never anything a project file or the Cloud says (§1.5).
   */
  trustModeOf(gate: ValidGate): TrustMode {
    return this.passkey()?.gates.includes(gate.name) === true
      ? 'passkey'
      : gate.trustMode;
  }

  private async loadPasskey(): Promise<void> {
    if (this.bridge?.passkey === undefined) return;
    try {
      this.passkey.set(await this.bridge.passkey.status(this.resource.id()));
    } catch {
      this.passkey.set({ passkey: null, gates: [] });
    }
  }

  /** «Passkey anlegen»: the main process's passkey window; the page learns the outcome only. */
  async enrollPasskey(): Promise<void> {
    if (this.bridge?.passkey === undefined || this.passkeyBusy()) return;
    this.passkeyBusy.set(true);
    this.passkeyNotice.set(null);
    this.passkeyCreated.set(false);
    try {
      const result = await this.bridge.passkey.enroll(
        this.translate.getCurrentLang() ?? '',
      );
      if (result.status === 'created') {
        this.passkeyCreated.set(true);
        await this.loadPasskey();
      } else {
        this.passkeyNotice.set(result.status);
      }
    } catch {
      this.passkeyNotice.set('failed');
    } finally {
      this.passkeyBusy.set(false);
    }
  }

  /** Marks a gate as signing with the passkey (it pins it), or back with the key file. */
  async usePasskey(gate: ValidGate, on: boolean): Promise<void> {
    if (this.bridge?.passkey === undefined || this.passkeyBusy()) return;
    this.passkeyBusy.set(true);
    this.passkeyNotice.set(null);
    try {
      const done = await this.bridge.passkey.use(
        this.resource.id(),
        gate.name,
        on,
        this.translate.getCurrentLang() ?? '',
      );
      if (!done) this.passkeyNotice.set('set_failed');
      await this.loadPasskey();
    } catch {
      this.passkeyNotice.set('set_failed');
    } finally {
      this.passkeyBusy.set(false);
    }
  }

  private async loadRotation(): Promise<void> {
    if (this.bridge === null) return;
    try {
      const status = await this.bridge.key.status(this.resource.id());
      this.rotation.set(
        status.status === 'ready' && status.previous !== null
          ? { previous: status.previous, current: status.key }
          : null,
      );
    } catch {
      this.rotation.set(null);
    }
  }

  /** The valid gates whose latest bundle carries a signature of the new key (SEC-08 step 2). */
  readonly rotationSigned = computed(() => {
    const rotation = this.rotation();
    return rotation === null
      ? []
      : this.valid().filter((gate) =>
          gate.latestBundleSigners?.includes(rotation.current.kid),
        );
  });
  /** Step 3 is safe only when every gate already has a bundle signed with the new key. */
  readonly rotationReady = computed(
    () =>
      this.rotation() !== null &&
      this.valid().length > 0 &&
      this.rotationSigned().length === this.valid().length,
  );

  /** Step 1 on the server: both keys pinned. */
  readonly pinBothCommand = computed(() => {
    const rotation = this.rotation();
    return rotation === null
      ? ''
      : `php moat-gate.php trust --signer=${rotation.previous.publicKey},${rotation.current.publicKey}`;
  });
  /** Step 3 on the server: the new key alone. */
  readonly pinNewCommand = computed(() => {
    const rotation = this.rotation();
    return rotation === null
      ? ''
      : `php moat-gate.php trust --signer=${rotation.current.publicKey}`;
  });

  signedWithNewKey(gate: ValidGate): boolean {
    return this.rotationSigned().includes(gate);
  }

  /** The person says every gate pins the new key alone: the desktop forgets the old key. */
  async finishRotation(): Promise<void> {
    if (this.bridge === null || !this.rotationReady()) return;
    try {
      await this.bridge.key.rotationDone(
        this.resource.id(),
        this.translate.getCurrentLang() ?? '',
      );
    } catch {
      // Still open: the panel stays.
    }
    await this.loadRotation();
  }

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
    if (result.status === 'signed') void this.loadRotation();
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

  /** The latest bundle as a ZIP, into a folder, over SFTP, FTPS or Git; where: the desktop's dialogs. */
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
    return result.status === 'exported' || result.status === 'committed'
      ? { gate, version: result.version }
      : { gate };
  }

  /**
   * A bundle file, package ZIP or package folder into the gate (FR-45): chosen in the desktop's
   * dialog, checked as the gate would (DT-17); the page learns only the outcome.
   */
  async importBundle(gate: ValidGate, from: ImportFrom): Promise<void> {
    if (this.bridge === null || this.importing() !== null) return;
    this.importing.set(gate.name);
    this.imported.set(null);
    let result: ImportResult;
    try {
      result = await this.bridge.gate.import(
        this.resource.id(),
        gate.name,
        from,
        this.translate.getCurrentLang() ?? '',
      );
    } catch {
      result = { status: 'failed' };
    } finally {
      this.importing.set(null);
    }
    if (result.status === 'cancelled') return;
    this.imported.set({ gate: gate.name, result });
    // A new latest bundle: read the project again.
    if (result.status === 'imported') this.resource.reload();
  }

  /** The i18n key for an import outcome (`gates.importResult.*`). */
  importText(result: Exclude<ImportResult, { status: 'cancelled' }>): string {
    return result.status === 'refused'
      ? `gates.importResult.${result.code}`
      : `gates.importResult.${result.status}`;
  }

  importParams(
    result: Exclude<ImportResult, { status: 'cancelled' }>,
    gate: string,
  ): Record<string, string | number> {
    return result.status === 'imported'
      ? { gate, version: result.version }
      : { gate };
  }

  /**
   * «Log ansehen» (FR-50, DT-12): the gate's log files chosen in the desktop's dialog; the page
   * gets the summary and the newest lines, never a path.
   */
  async readLog(gate: ValidGate): Promise<void> {
    if (this.bridge === null || this.readingLog() !== null) return;
    this.readingLog.set(gate.name);
    let result: RequestLogResult;
    try {
      result = await this.bridge.gate.log(
        this.resource.id(),
        gate.name,
        this.translate.getCurrentLang() ?? '',
      );
    } catch {
      result = { status: 'failed' };
    } finally {
      this.readingLog.set(null);
    }
    if (result.status === 'cancelled') return;
    this.logRead.set({ gate: gate.name, result });
  }

  /** The i18n key of a log refusal (`gates.logResult.*`). */
  logText(
    result: Exclude<RequestLogResult, { status: 'cancelled' | 'read' }>,
  ): string {
    return result.status === 'refused'
      ? `gates.logResult.${result.code}`
      : `gates.logResult.${result.status}`;
  }

  /** Unix seconds as local date and time, in the page's language. */
  logTime(seconds: number | null): string {
    if (seconds === null) return '';
    return new Date(seconds * 1000).toLocaleString(
      this.translate.getCurrentLang() || undefined,
      { dateStyle: 'short', timeStyle: 'medium' },
    );
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
