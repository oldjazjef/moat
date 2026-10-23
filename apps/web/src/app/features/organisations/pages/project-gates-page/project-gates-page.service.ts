import { HttpClient, httpResource } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import type {
  GateView,
  GatesAnswer,
  ReleasePreview,
  SecretView,
} from '../../../../core/api/gates.types';
import {
  type ApiErrorCode,
  apiErrorCode,
} from '../../../../core/auth/api-error';
import { apiUrl } from '../../../../core/config/runtime-env';
import { zodValidator } from '../../../../core/forms/zod-validator';
import { sealInBrowser } from '../../../../shared/crypto/browser-seal';
import { gateSchema } from '../../gates.schema';
import { OrgScope } from '../../org-scope';

/** What the page knows about one gate besides the list: opened on demand, never persisted. */
export interface GateUi {
  readonly busy: boolean;
  readonly error: ApiErrorCode | null;
  /** For `secrets_missing`: the secrets the config uses that are not stored yet. */
  readonly missingSecrets: readonly string[];
  readonly preview: ReleasePreview | null;
  /** A release or an upload went through: its version. */
  readonly done: {
    readonly kind: 'released' | 'uploaded';
    readonly version: number;
  } | null;
  /** The pull address, shown once, right after it was made. */
  readonly address: string | null;
  readonly secrets: readonly SecretView[] | null;
  readonly secretSaved: string | null;
}

const EMPTY: GateUi = {
  busy: false,
  error: null,
  missingSecrets: [],
  preview: null,
  done: null,
  address: null,
  secrets: null,
  secretSaved: null,
};

/**
 * «Gates» of a Cloud project: enrolling a gate with the fingerprint compared at the gate (SEC-32),
 * its sealed secrets, the next bundle (Moat Cloud signs it in «Bequem», after a preview whose
 * digest the signing must match; for «Signiert» the customer's signed bundle is uploaded) and the
 * gate's pull address. What a person may do is the API's decision: a refusal is shown with a fixed,
 * translated text.
 */
@Injectable()
export class ProjectGatesPageService {
  private readonly http = inject(HttpClient);
  readonly scope = inject(OrgScope);
  private readonly source = signal<(() => string) | null>(null);
  readonly projectId = computed(() => this.source()?.() ?? null);

  bind(projectId: () => string): void {
    this.source.set(projectId);
  }

  private base(): string | null {
    const org = this.scope.orgId();
    const project = this.projectId();
    return org === null || project === null
      ? null
      : `/orgs/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}`;
  }

  readonly project = httpResource<{
    readonly project: { readonly name: string };
  }>(() => {
    const base = this.base();
    return base === null ? undefined : apiUrl(base);
  });
  readonly gates = httpResource<GatesAnswer>(() => {
    const base = this.base();
    return base === null ? undefined : apiUrl(`${base}/gates`);
  });

  readonly canManage = computed(() => this.scope.can('gate:manage'));
  readonly canSealSecrets = computed(() => this.scope.can('secret:write'));
  readonly canRelease = computed(() => this.scope.can('release'));

  // ── Enrolling ──────────────────────────────────────────────────────────────────────────

  readonly addForm = new FormGroup(
    {
      name: new FormControl('', { nonNullable: true }),
      gateId: new FormControl('', { nonNullable: true }),
      boxKey: new FormControl('', { nonNullable: true }),
      fingerprint: new FormControl('', { nonNullable: true }),
      signerKey: new FormControl('', { nonNullable: true }),
    },
    { validators: zodValidator(gateSchema) },
  );
  readonly addBusy = signal(false);
  readonly addError = signal<ApiErrorCode | null>(null);

  async addGate(): Promise<void> {
    this.addError.set(null);
    const base = this.base();
    if (base === null) return;
    if (this.addForm.invalid) {
      this.addForm.markAllAsTouched();
      return;
    }
    const value = this.addForm.getRawValue();
    this.addBusy.set(true);
    try {
      await firstValueFrom(
        this.http.post(apiUrl(`${base}/gates`), {
          name: value.name,
          gateId: value.gateId,
          boxKey: value.boxKey,
          fingerprint: value.fingerprint.trim(),
          ...(value.signerKey.trim() === ''
            ? {}
            : { signerKey: value.signerKey.trim() }),
        }),
      );
      this.addForm.reset();
      this.gates.reload();
    } catch (error) {
      this.addError.set(apiErrorCode(error));
    } finally {
      this.addBusy.set(false);
    }
  }

  // ── One gate ───────────────────────────────────────────────────────────────────────────

  private readonly state = signal<Readonly<Record<string, GateUi>>>({});
  readonly ui = (gate: string): GateUi => this.state()[gate] ?? EMPTY;
  private patch(gate: string, change: Partial<GateUi>): void {
    this.state.update((all) => ({
      ...all,
      [gate]: { ...(all[gate] ?? EMPTY), ...change },
    }));
  }

  /** Runs an API call for a gate with the busy flag and the error shown on that gate. */
  private async run<T>(
    gate: string,
    call: () => Promise<T>,
  ): Promise<T | null> {
    this.patch(gate, { busy: true, error: null, missingSecrets: [] });
    try {
      return await call();
    } catch (error) {
      const secrets = (error as { error?: { secrets?: unknown } }).error
        ?.secrets;
      this.patch(gate, {
        error: apiErrorCode(error),
        missingSecrets: Array.isArray(secrets)
          ? secrets.filter((s): s is string => typeof s === 'string')
          : [],
      });
      return null;
    } finally {
      this.patch(gate, { busy: false });
    }
  }

  private gateUrl(gate: string): string | null {
    const base = this.base();
    return base === null
      ? null
      : apiUrl(`${base}/gates/${encodeURIComponent(gate)}`);
  }

  async loadSecrets(gate: string): Promise<void> {
    const url = this.gateUrl(gate);
    if (url === null) return;
    const answer = await this.run(gate, () =>
      firstValueFrom(
        this.http.get<{ secrets: readonly SecretView[] }>(`${url}/secrets`),
      ),
    );
    if (answer !== null) this.patch(gate, { secrets: answer.secrets });
  }

  /**
   * A secret sealed on this person's machine (`moat secret seal`, Moat Desktop): its JSON is pasted
   * here. Moat Cloud keeps the ciphertext and has no key to open it (SEC-31).
   */
  async putSecret(
    gate: string,
    name: string,
    sealedText: string,
  ): Promise<void> {
    let sealed: unknown;
    try {
      sealed = JSON.parse(sealedText);
    } catch {
      this.patch(gate, { error: 'secret_invalid', secretSaved: null });
      return;
    }
    await this.storeSealed(gate, name, sealed);
  }

  /**
   * The value typed into the page, sealed here in the browser to the gate's box key under the next
   * version of that name, and only the ciphertext sent. The value is never put in a signal, a
   * form control of the service or a request: the caller passes it once and clears its field.
   */
  async sealAndPut(gate: GateView, name: string, value: string): Promise<void> {
    const secretName = name.trim();
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(secretName) || value === '') {
      this.patch(gate.name, {
        error: value === '' ? 'secret_invalid' : 'name_invalid',
        secretSaved: null,
      });
      return;
    }
    // The next version: one above what is stored (the API refuses anything not higher).
    if (this.ui(gate.name).secrets === null) await this.loadSecrets(gate.name);
    const current = this.ui(gate.name).secrets?.find(
      (s) => s.name === secretName,
    );
    let sealed: unknown;
    try {
      sealed = await sealInBrowser(
        value,
        gate,
        secretName,
        (current?.secretVersion ?? 0) + 1,
      );
    } catch {
      this.patch(gate.name, { error: 'unknown', secretSaved: null });
      return;
    }
    await this.storeSealed(gate.name, secretName, sealed);
  }

  private async storeSealed(
    gate: string,
    name: string,
    sealed: unknown,
  ): Promise<void> {
    const url = this.gateUrl(gate);
    if (url === null) return;
    const answer = await this.run(gate, () =>
      firstValueFrom(
        this.http.put<{ secret: SecretView }>(
          `${url}/secrets/${encodeURIComponent(name.trim())}`,
          { sealed },
        ),
      ),
    );
    if (answer === null) return;
    this.patch(gate, { secretSaved: answer.secret.name });
    await this.loadSecrets(gate);
  }

  async loadPreview(gate: string): Promise<void> {
    const url = this.gateUrl(gate);
    if (url === null) return;
    this.patch(gate, { preview: null, done: null });
    const answer = await this.run(gate, () =>
      firstValueFrom(
        this.http.get<{ preview: ReleasePreview }>(`${url}/release`),
      ),
    );
    if (answer !== null) this.patch(gate, { preview: answer.preview });
  }

  /** Moat Cloud signs exactly the bundle of the preview the person looked at. */
  async release(gate: string): Promise<void> {
    const url = this.gateUrl(gate);
    const preview = this.ui(gate).preview;
    if (url === null || preview === null) return;
    const answer = await this.run(gate, () =>
      firstValueFrom(
        this.http.post<{ version: number }>(`${url}/releases`, {
          digest: preview.digest,
        }),
      ),
    );
    if (answer === null) return;
    this.patch(gate, {
      preview: null,
      done: { kind: 'released', version: answer.version },
    });
    this.gates.reload();
  }

  async upload(gate: string, envelope: string): Promise<void> {
    const url = this.gateUrl(gate);
    if (url === null) return;
    const answer = await this.run(gate, () =>
      firstValueFrom(
        this.http.post<{ version: number }>(`${url}/bundles`, { envelope }),
      ),
    );
    if (answer === null) return;
    this.patch(gate, { done: { kind: 'uploaded', version: answer.version } });
    this.gates.reload();
  }

  /** The gate whose deletion waits for the second click. */
  readonly confirmingRemove = signal<string | null>(null);

  askRemove(gate: string): void {
    this.confirmingRemove.set(gate);
  }

  cancelRemove(): void {
    this.confirmingRemove.set(null);
  }

  /**
   * Deletes the gate with its sealed secrets, bundles and pull address. The gate on the server keeps
   * running with the last bundle it accepted, and moat.yaml is not changed.
   */
  async removeGate(gate: string): Promise<void> {
    const url = this.gateUrl(gate);
    if (url === null) return;
    this.confirmingRemove.set(null);
    const answer = await this.run(gate, () =>
      firstValueFrom(this.http.delete(url)).then(() => true),
    );
    if (answer === null) return;
    this.state.update((all) => {
      const { [gate]: _gone, ...rest } = all;
      return rest;
    });
    this.gates.reload();
  }

  /** A new address ends the old one; it is shown once and then only as «exists». */
  async createAddress(gate: string): Promise<void> {
    const url = this.gateUrl(gate);
    if (url === null) return;
    const answer = await this.run(gate, () =>
      firstValueFrom(
        this.http.post<{ url: string }>(`${url}/pull-address`, {}),
      ),
    );
    if (answer !== null) {
      this.patch(gate, { address: answer.url });
      this.gates.reload();
    }
  }
}
