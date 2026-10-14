import {
  HttpClient,
  HttpErrorResponse,
  httpResource,
} from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { firstValueFrom } from 'rxjs';
import type { ProjectView } from '../../../../core/api/project.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import {
  desktopBridge,
  type SigningKeyStatus,
} from '../../../../core/desktop/desktop-bridge';
import { RichText } from '../../../../shared/components/rich-text';
import { HelpLink } from '../../../help/components/help-link';
import { SetupPageService } from '../../pages/setup-page/setup-page.service';
import { provideSetupStep, SetupStepComponent } from '../setup-step';
import { parseGateAddLine } from './gate-line';

/** `POST /api/projects/:id/gates/check`. */
interface GatePreview {
  readonly name: string;
  readonly gateId: string;
  readonly boxKeyId: string;
  readonly boxKeyFingerprint: string;
}

export const GATE_ERRORS = [
  'name_invalid',
  'gate_id_invalid',
  'box_key_invalid',
  'gate_exists',
  'gate_id_exists',
  'fingerprint_mismatch',
  'not_writable',
  'assign_failed',
  'failed',
] as const;
type GateError = (typeof GATE_ERRORS)[number];

/** `setup.gate.notices.<notice>` */
export const GATE_NOTICES = [
  ...GATE_ERRORS,
  'required',
  'rejected',
  'noProject',
] as const;
type Notice = (typeof GATE_NOTICES)[number] | null;

const NAME = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * FR-73, step «Erstes Gate»: install the gate with the signing key's public key, then pin it in
 * the project. The gate's id and box key are checked first and only written after the person
 * confirmed that the fingerprint matches what the gate printed (SEC-32) — the API writes the
 * file only with that fingerprint. The new gate goes into the project's first environment.
 */
@Component({
  selector: 'mt-setup-gate-step',
  imports: [
    TranslatePipe,
    ReactiveFormsModule,
    RichText,
    HelpLink,
    ...HlmButtonImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  providers: [provideSetupStep(() => GateStep)],
  template: `
    @if (service.project() === null) {
      <p class="mt-note" data-gate-no-project>
        {{ 'setup.gate.noProject' | translate }}
      </p>
    } @else {
      @if (gates().length > 0) {
        <div class="mb-6" data-gate-existing>
          <p class="text-sm font-medium">
            {{ 'setup.gate.existing' | translate }}
          </p>
          <ul class="mt-2 flex flex-col gap-1 text-sm">
            @for (gate of gates(); track gate.name) {
              <li class="flex flex-wrap gap-x-3">
                <span class="mt-code font-medium">{{ gate.name }}</span>
                <span class="mt-code text-muted-foreground">{{
                  gate.fingerprint
                }}</span>
              </li>
            }
          </ul>
        </div>
      }

      <ol class="flex list-decimal flex-col gap-5 pl-5 text-sm">
        <li data-gate-install>
          <div class="flex items-center gap-1">
            <mt-rich-text [text]="'setup.gate.install' | translate" />
            <mt-help-link section="gate" />
          </div>
          <pre class="mt-command" data-gate-command>{{ command() }}</pre>
          @if (key()?.status !== 'ready') {
            <p class="mt-warning-text mt-1" data-gate-no-key>
              {{ 'setup.gate.noKey' | translate }}
            </p>
          }
        </li>

        <li>
          <mt-rich-text [text]="'setup.gate.enter' | translate" />
          @if (preview() === null) {
            <form
              class="mt-3 grid max-w-xl gap-3"
              [formGroup]="form"
              (ngSubmit)="check()"
              data-gate-form
            >
              <div class="grid gap-1">
                <label hlmLabel for="gate-name">{{
                  'setup.gate.name' | translate
                }}</label>
                <input
                  hlmInput
                  id="gate-name"
                  class="mt-code"
                  formControlName="name"
                  autocomplete="off"
                  spellcheck="false"
                />
                <p class="text-muted-foreground text-xs">
                  {{ 'setup.gate.nameHint' | translate }}
                </p>
              </div>
              <div class="grid gap-1">
                <label hlmLabel for="gate-id">{{
                  'setup.gate.gateId' | translate
                }}</label>
                <input
                  hlmInput
                  id="gate-id"
                  class="mt-code"
                  formControlName="gateId"
                  autocomplete="off"
                  spellcheck="false"
                  (paste)="paste($event)"
                />
              </div>
              <div class="grid gap-1">
                <label hlmLabel for="gate-box-key">{{
                  'setup.gate.boxKey' | translate
                }}</label>
                <input
                  hlmInput
                  id="gate-box-key"
                  class="mt-code"
                  formControlName="boxKey"
                  autocomplete="off"
                  spellcheck="false"
                  (paste)="paste($event)"
                />
                <p class="text-muted-foreground text-xs">
                  <mt-rich-text [text]="'setup.gate.pasteHint' | translate" />
                </p>
              </div>
              <div>
                <button
                  hlmBtn
                  type="submit"
                  data-gate-check
                  [disabled]="busy()"
                >
                  {{ 'setup.gate.check' | translate }}
                </button>
              </div>
            </form>
          } @else {
            <div class="mt-3 flex max-w-xl flex-col gap-3" data-gate-compare>
              <dl class="mt-facts">
                <dt>{{ 'setup.gate.name' | translate }}</dt>
                <dd class="mt-code">{{ preview()?.name }}</dd>
                <dt>{{ 'setup.gate.gateId' | translate }}</dt>
                <dd class="mt-code">{{ preview()?.gateId }}</dd>
              </dl>
              <p class="mt-fingerprint" data-gate-fingerprint>
                {{ preview()?.boxKeyFingerprint }}
              </p>
              <p>
                <mt-rich-text [text]="'setup.gate.compare' | translate" />
              </p>
              <div class="flex flex-wrap gap-2">
                <button
                  hlmBtn
                  type="button"
                  data-gate-confirm
                  [disabled]="busy()"
                  (click)="confirm()"
                >
                  {{ 'setup.gate.matches' | translate }}
                </button>
                <button
                  hlmBtn
                  variant="outline"
                  type="button"
                  data-gate-reject
                  [disabled]="busy()"
                  (click)="reject()"
                >
                  {{ 'setup.gate.differs' | translate }}
                </button>
              </div>
            </div>
          }
        </li>
      </ol>

      @if (saved(); as name) {
        <p class="mt-4 text-sm" role="status" data-gate-saved>
          {{ 'setup.gate.saved' | translate: { gate: name } }}
        </p>
      }
    }
    @if (notice(); as code) {
      <p
        class="text-destructive mt-4 text-sm"
        role="alert"
        data-gate-notice
        [attr.data-code]="code"
      >
        {{ 'setup.gate.notices.' + code | translate }}
      </p>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GateStep extends SetupStepComponent {
  protected readonly service = inject(SetupPageService);
  private readonly http = inject(HttpClient);
  private readonly bridge = desktopBridge();

  protected readonly project = httpResource<ProjectView>(() => {
    const id = this.service.project();
    return id === null
      ? undefined
      : apiUrl(`/projects/${encodeURIComponent(id)}`);
  });
  protected readonly gates = computed(() => {
    const view = this.project.hasValue() ? this.project.value() : null;
    return (view?.project?.gates ?? []).flatMap((gate) =>
      gate.status === 'valid'
        ? [{ name: gate.name, fingerprint: gate.boxKeyFingerprint }]
        : [],
    );
  });
  protected readonly key = signal<SigningKeyStatus | null>(null);
  protected readonly command = computed(() => {
    const key = this.key();
    const signer = key?.status === 'ready' ? key.key.publicKey : '<…>';
    return `php moat-gate.php install --signer=${signer}`;
  });

  protected readonly form = new FormGroup({
    name: new FormControl('www', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(NAME)],
    }),
    gateId: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    boxKey: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
  });
  /** What «Prüfen» showed, with the key it was computed from: exactly that is pinned. */
  protected readonly preview = signal<
    (GatePreview & { boxKey: string }) | null
  >(null);
  protected readonly saved = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice>(null);

  constructor() {
    super();
    void this.loadKey();
    // Another project: start over.
    effect(() => {
      this.service.project();
      this.preview.set(null);
      this.saved.set(null);
    });
  }

  /** Pasting the whole `moat gate add …` line fills both fields. */
  protected paste(event: ClipboardEvent): void {
    const parsed = parseGateAddLine(event.clipboardData?.getData('text') ?? '');
    if (parsed === null) return;
    event.preventDefault();
    this.form.patchValue(parsed);
  }

  /** «Prüfen»: the fingerprint to compare; nothing is written yet. */
  protected async check(): Promise<void> {
    const id = this.service.project();
    if (id === null || this.busy()) return;
    this.notice.set(null);
    this.saved.set(null);
    const value = this.form.getRawValue();
    if (!NAME.test(value.name)) {
      this.notice.set('name_invalid');
      return;
    }
    if (this.form.invalid) {
      this.notice.set('required');
      return;
    }
    const input = {
      name: value.name,
      gateId: value.gateId.trim(),
      boxKey: value.boxKey.trim(),
    };
    await this.run(async () => {
      const preview = await firstValueFrom(
        this.http.post<GatePreview>(
          apiUrl(`/projects/${encodeURIComponent(id)}/gates/check`),
          input,
        ),
      );
      this.preview.set({ ...preview, boxKey: input.boxKey });
    });
  }

  /** «Stimmt überein»: pins the gate with the fingerprint shown, then puts it in an environment. */
  protected async confirm(): Promise<void> {
    const id = this.service.project();
    const preview = this.preview();
    if (id === null || preview === null || this.busy()) return;
    await this.run(async () => {
      const view = await firstValueFrom(
        this.http.post<ProjectView>(
          apiUrl(`/projects/${encodeURIComponent(id)}/gates`),
          {
            name: preview.name,
            gateId: preview.gateId,
            boxKey: preview.boxKey,
            fingerprint: preview.boxKeyFingerprint,
          },
        ),
      );
      this.project.set(view);
      this.preview.set(null);
      this.saved.set(preview.name);
      this.form.reset();
      await this.assign(view, preview.name);
    });
  }

  /** «Stimmt nicht»: nothing was written; the fields are cleared. */
  protected reject(): void {
    this.preview.set(null);
    this.form.patchValue({ gateId: '', boxKey: '' });
    this.notice.set('rejected');
  }

  /** «Weiter» needs a pinned gate in the chosen project; without one, «Später». */
  async submit(): Promise<boolean> {
    if (this.service.project() === null) {
      this.notice.set('noProject');
      return false;
    }
    if (this.gates().length > 0) return true;
    this.notice.set('required');
    return false;
  }

  /** The project's first environment, when it has one and the gate is in none (FR-01). */
  private async assign(view: ProjectView, gate: string): Promise<void> {
    const config = view.project?.config;
    if (config?.status !== 'valid' || view.configHash === null) return;
    const environment = config.environments[0]?.name;
    if (environment === undefined) return;
    try {
      this.project.set(
        await firstValueFrom(
          this.http.post<ProjectView>(
            apiUrl(`/projects/${encodeURIComponent(view.id)}/config/edits`),
            { base: view.configHash, op: 'assignGate', gate, environment },
          ),
        ),
      );
    } catch {
      this.notice.set('assign_failed');
    }
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.notice.set(null);
    try {
      await work();
    } catch (error) {
      this.notice.set(errorOf(error));
    } finally {
      this.busy.set(false);
    }
  }

  private async loadKey(): Promise<void> {
    if (this.bridge === null) return;
    try {
      this.key.set(await this.bridge.key.status());
    } catch {
      this.key.set({ status: 'unreadable' });
    }
  }
}

function errorOf(error: unknown): GateError {
  if (!(error instanceof HttpErrorResponse)) return 'failed';
  const code = (error.error as { error?: unknown } | null)?.error;
  return GATE_ERRORS.find((known) => known === code) ?? 'failed';
}
