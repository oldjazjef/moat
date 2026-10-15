import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { firstValueFrom } from 'rxjs';
import { apiUrl } from '../../../../core/config/runtime-env';
import type { SigningKeyStatus } from '../../../../core/desktop/desktop-bridge';
import { RichText } from '../../../../shared/components/rich-text';

/** What `POST /api/projects/:id/gates/setup` reads from the gate's setup mode (T-73). */
export interface GateSetupIdentity {
  readonly gateId: string;
  readonly boxKey: string;
  readonly boxKeyFingerprint: string;
  readonly signers: readonly { kid: string; fingerprint: string }[];
  readonly threshold: number;
  readonly mode: number;
}

type SetupReply =
  | { status: 'read'; identity: GateSetupIdentity }
  | { status: 'failed'; reason: string };

/** `setup.gate.fetch.errors.<code>`: the API's refusals and the reasons no answer came. */
export const GATE_FETCH_ERRORS = [
  'url_invalid',
  'token_invalid',
  'not_confirmed',
  'busy',
  'setup_off',
  'answer_invalid',
  'address_forbidden',
  'not_found',
  'unreachable',
  'timeout',
  'tls',
  'failed',
] as const;
export type GateFetchError = (typeof GATE_FETCH_ERRORS)[number];

/** The token as `php moat-gate.php setup` prints it: 32 bytes, base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Moat Desktop only: reads gate id and box key from the gate's setup mode over HTTPS (SEC-28,
 * SEC-32, T-73), so a person without a shell on the server can pin it. The API fetches after the
 * main process confirmed the address (T-59). The token is typed here, sent once and not kept; the
 * answer fills the fields of the step, and the person still compares the fingerprint before the
 * gate is pinned. Whether the desktop's own signer is pinned on the gate is shown, never assumed.
 */
@Component({
  selector: 'mt-gate-fetch',
  imports: [
    TranslatePipe,
    ReactiveFormsModule,
    RichText,
    ...HlmButtonImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  template: `
    <div class="mt-3 max-w-xl" data-gate-fetch>
      <button
        hlmBtn
        variant="outline"
        type="button"
        data-gate-fetch-toggle
        [attr.aria-expanded]="open()"
        (click)="open.set(!open())"
      >
        {{ 'setup.gate.fetch.toggle' | translate }}
      </button>
      @if (open()) {
        <form
          class="mt-3 grid gap-3"
          [formGroup]="form"
          (ngSubmit)="fetch()"
          data-gate-fetch-form
        >
          <p class="text-sm">
            <mt-rich-text [text]="'setup.gate.fetch.intro' | translate" />
          </p>
          <div class="grid gap-1">
            <label hlmLabel for="gate-fetch-url">{{
              'setup.gate.fetch.url' | translate
            }}</label>
            <input
              hlmInput
              id="gate-fetch-url"
              class="mt-code"
              formControlName="url"
              autocomplete="off"
              spellcheck="false"
            />
            <p class="text-muted-foreground text-xs">
              <mt-rich-text [text]="'setup.gate.fetch.urlHint' | translate" />
            </p>
          </div>
          <div class="grid gap-1">
            <label hlmLabel for="gate-fetch-token">{{
              'setup.gate.fetch.token' | translate
            }}</label>
            <input
              hlmInput
              id="gate-fetch-token"
              class="mt-code"
              type="password"
              formControlName="token"
              autocomplete="off"
              spellcheck="false"
            />
            <p class="text-muted-foreground text-xs">
              {{ 'setup.gate.fetch.tokenHint' | translate }}
            </p>
          </div>
          <div>
            <button
              hlmBtn
              type="submit"
              data-gate-fetch-run
              [disabled]="busy()"
            >
              {{ 'setup.gate.fetch.run' | translate }}
            </button>
          </div>
        </form>
        @if (error(); as code) {
          <p
            class="text-destructive mt-3 text-sm"
            role="alert"
            data-gate-fetch-error
            [attr.data-code]="code"
          >
            {{ 'setup.gate.fetch.errors.' + code | translate }}
          </p>
        }
        @if (identity(); as found) {
          <div class="mt-3 flex flex-col gap-2 text-sm" data-gate-fetch-result>
            <p class="font-medium">{{ 'setup.gate.fetch.read' | translate }}</p>
            <dl class="mt-facts">
              <dt>{{ 'setup.gate.gateId' | translate }}</dt>
              <dd class="mt-code">{{ found.gateId }}</dd>
              <dt>{{ 'setup.gate.fetch.boxFingerprint' | translate }}</dt>
              <dd class="mt-code" data-gate-fetch-box>
                {{ found.boxKeyFingerprint }}
              </dd>
              <dt>{{ 'setup.gate.fetch.signers' | translate }}</dt>
              <dd class="flex flex-col gap-1">
                @for (signer of found.signers; track signer.kid) {
                  <span class="mt-code" data-gate-fetch-signer>{{
                    signer.fingerprint
                  }}</span>
                }
              </dd>
            </dl>
            @switch (signerState()) {
              @case ('pinned') {
                <p role="status" data-gate-fetch-signer-state="pinned">
                  {{ 'setup.gate.fetch.signerPinned' | translate }}
                </p>
              }
              @case ('missing') {
                <p
                  class="mt-warning-text"
                  role="alert"
                  data-gate-fetch-signer-state="missing"
                >
                  {{ 'setup.gate.fetch.signerMissing' | translate }}
                </p>
              }
              @default {
                <p
                  class="text-muted-foreground"
                  data-gate-fetch-signer-state="unknown"
                >
                  {{ 'setup.gate.fetch.signerUnknown' | translate }}
                </p>
              }
            }
            <p class="text-muted-foreground text-xs">
              {{ 'setup.gate.fetch.claim' | translate }}
            </p>
            <p>
              <mt-rich-text [text]="'setup.gate.fetch.next' | translate" />
            </p>
          </div>
        }
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GateFetch {
  readonly project = input.required<string>();
  /** The desktop's own signing key, from the bridge. */
  readonly key = input<SigningKeyStatus | null>(null);
  /** The identity read, for the step to fill its fields. */
  readonly fetched = output<GateSetupIdentity>();

  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);

  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<GateFetchError | null>(null);
  protected readonly identity = signal<GateSetupIdentity | null>(null);
  protected readonly form = new FormGroup({
    url: new FormControl('', { nonNullable: true }),
    token: new FormControl('', { nonNullable: true }),
  });

  /** Is the desktop's own signer among those the gate pinned (fingerprints, exact match)? */
  protected readonly signerState = computed<'pinned' | 'missing' | 'unknown'>(
    () => {
      const found = this.identity();
      const key = this.key();
      if (found === null || key?.status !== 'ready') return 'unknown';
      return found.signers.some(
        (signer) => signer.fingerprint === key.key.fingerprint,
      )
        ? 'pinned'
        : 'missing';
    },
  );

  protected async fetch(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    this.identity.set(null);
    const url = this.form.controls.url.value.trim();
    const token = this.form.controls.token.value.trim();
    if (!TOKEN.test(token)) {
      this.error.set('token_invalid');
      return;
    }
    this.busy.set(true);
    try {
      const reply = await firstValueFrom(
        this.http.post<SetupReply>(
          apiUrl(`/projects/${encodeURIComponent(this.project())}/gates/setup`),
          { url, token, locale: this.translate.getCurrentLang() ?? '' },
        ),
      );
      if (reply.status === 'read') {
        this.identity.set(reply.identity);
        this.fetched.emit(reply.identity);
        // The token is spent on this request; it is not kept in the form.
        this.form.controls.token.reset('');
      } else {
        this.error.set(errorOf(reply.reason));
      }
    } catch (error) {
      this.error.set(refusalOf(error));
    } finally {
      this.busy.set(false);
    }
  }
}

function errorOf(code: unknown): GateFetchError {
  return GATE_FETCH_ERRORS.find((known) => known === code) ?? 'failed';
}

function refusalOf(error: unknown): GateFetchError {
  if (!(error instanceof HttpErrorResponse)) return 'failed';
  return errorOf((error.error as { error?: unknown } | null)?.error);
}
