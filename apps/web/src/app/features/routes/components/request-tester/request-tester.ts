import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { firstValueFrom } from 'rxjs';
import type {
  BodyField,
  BodyFields,
  CompiledRoute,
} from '../../../../core/api/project.types';
import {
  GATE_TEST_REFUSALS,
  type GateAnswer,
} from '../../../../core/api/recipe.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import { RichText } from '../../../../shared/components/rich-text';
import { outcomeOf, type TestOutcome } from '../recipe-panel';

/** `routes.tester.notices.<notice>`: why nothing was sent. */
export const REQUEST_TESTER_NOTICES = [
  ...GATE_TEST_REFUSALS,
  'failed',
] as const;
type Notice = (typeof REQUEST_TESTER_NOTICES)[number];

/** Methods whose body the gate forwards (BODY_METHODS in libs/core). */
const BODY_METHODS = ['POST', 'PUT', 'PATCH'];

/** A JSON body that fits the route's listed fields, to start from; `{}` without fields. */
export function sampleBody(fields: BodyFields | undefined): string {
  return `${JSON.stringify(sampleObject(fields ?? {}), null, 2)}\n`;
}

function sampleObject(fields: BodyFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields))
    out[name] = sampleValue(field);
  return out;
}

function sampleValue(field: BodyField): unknown {
  switch (field.type) {
    case 'string':
      if (field.enum !== undefined && field.enum.length > 0)
        return field.enum[0];
      return field.format === 'email' ? 'test@example.com' : '';
    case 'integer':
      return field.minimum ?? 0;
    case 'boolean':
      return false;
    case 'object':
      return sampleObject(field.fields ?? {});
    case 'array':
      return [];
  }
}

/** A JSON answer indented for reading; anything else (or a cut-off answer) as it came. */
export function prettyBody(
  excerpt: string,
  contentType: string | null,
  truncated: boolean,
): string {
  if (truncated || !(contentType ?? '').toLowerCase().includes('json'))
    return excerpt;
  try {
    return JSON.stringify(JSON.parse(excerpt), null, 2);
  } catch {
    return excerpt;
  }
}

/** The project's gate address, remembered per project in this browser only (a convenience). */
function storedUrl(projectId: string): string {
  try {
    return localStorage.getItem(`mt-gate-url-${projectId}`) ?? '';
  } catch {
    return '';
  }
}

function storeUrl(projectId: string, url: string): void {
  try {
    localStorage.setItem(`mt-gate-url-${projectId}`, url);
  } catch {
    // Storage blocked: the address is typed again next time.
  }
}

/**
 * «Testen» on a route (FR-42, FR-73): sends one request with the route's method and path,
 * a body and optionally one of its own origins **through the installed gate** — the desktop
 * holds the secret sealed only, so the gate adds it, exactly as for the website. Moat Desktop
 * asks in a window of its own before the first request to an address (T-59). Shows status,
 * duration, the listed answer headers and the body.
 */
@Component({
  selector: 'mt-request-tester',
  imports: [
    TranslatePipe,
    ReactiveFormsModule,
    RichText,
    ...HlmButtonImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  template: `
    <section
      class="mt-panel flex flex-col gap-4 p-4"
      aria-labelledby="request-tester-title"
      data-request-tester
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="request-tester-title" class="font-semibold">
            {{ 'routes.tester.title' | translate: { route: name() } }}
          </h3>
          <p class="text-muted-foreground text-sm">
            {{ 'routes.tester.intro' | translate }}
          </p>
        </div>
        <button
          hlmBtn
          size="sm"
          variant="ghost"
          type="button"
          data-tester-close
          (click)="closed.emit()"
        >
          {{ 'routes.tester.close' | translate }}
        </button>
      </div>
      <p class="mt-warning-text text-sm" data-tester-warning>
        {{ 'routes.tester.warning' | translate }}
      </p>
      @if (route().client) {
        <p class="mt-note text-sm" data-tester-client>
          <mt-rich-text [text]="'routes.tester.client' | translate" />
        </p>
      }
      <form
        class="grid max-w-3xl gap-3"
        [formGroup]="form"
        (ngSubmit)="send()"
        data-tester-form
      >
        <div class="grid gap-1">
          <label hlmLabel for="tester-gate-url">{{
            'recipe.gateUrl' | translate
          }}</label>
          <input
            hlmInput
            id="tester-gate-url"
            class="mt-code"
            formControlName="url"
            [placeholder]="'recipe.gateUrlPlaceholder' | translate"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <p class="text-muted-foreground text-sm" data-tester-request>
          <span class="mt-code"
            ><span class="font-semibold">{{ route().method }}</span>
            {{ target() }}</span
          >
        </p>
        @if (route().origins.length > 0) {
          <div class="grid gap-1">
            <label hlmLabel for="tester-origin">{{
              'routes.tester.origin' | translate
            }}</label>
            <select
              hlmInput
              id="tester-origin"
              class="mt-code max-w-md"
              formControlName="origin"
              data-tester-origin
            >
              <option value="">
                {{ 'routes.tester.noOrigin' | translate }}
              </option>
              @for (origin of route().origins; track origin) {
                <option [value]="origin">{{ origin }}</option>
              }
            </select>
          </div>
        }
        @if (hasBody()) {
          <div class="grid gap-1">
            <label hlmLabel for="tester-body">{{
              'recipe.body' | translate
            }}</label>
            <textarea
              hlmInput
              id="tester-body"
              class="mt-code min-h-40"
              formControlName="body"
              spellcheck="false"
              data-tester-body
            ></textarea>
          </div>
        } @else {
          <p class="text-muted-foreground text-sm" data-tester-no-body>
            {{ 'routes.tester.noBody' | translate: { method: route().method } }}
          </p>
        }
        <div>
          <button hlmBtn type="submit" data-tester-send [disabled]="busy()">
            {{
              (busy() ? 'routes.tester.sending' : 'routes.tester.send')
                | translate
            }}
          </button>
        </div>
      </form>
      @if (notice(); as code) {
        <p
          class="text-destructive text-sm"
          role="alert"
          data-tester-notice
          [attr.data-code]="code"
        >
          {{ 'routes.tester.notices.' + code | translate }}
        </p>
      }
      @if (answer(); as result) {
        <div
          class="flex flex-col gap-3"
          role="status"
          data-tester-outcome
          [attr.data-kind]="result.outcome.kind"
        >
          <h4 class="font-semibold">
            {{ 'routes.tester.response' | translate }}
          </h4>
          @switch (result.outcome.kind) {
            @case ('failed') {
              <p class="text-destructive">
                <mt-rich-text
                  [text]="'recipe.failed.' + result.outcome.reason | translate"
                />
              </p>
            }
            @case ('gate') {
              <p [attr.data-code]="result.outcome.code">
                <span class="mt-code"
                  >{{ result.outcome.status }} {{ result.outcome.code }}</span
                >
                ·
                <mt-rich-text
                  [text]="'recipe.codes.' + result.outcome.code | translate"
                />
              </p>
            }
            @case ('upstream') {
              <p
                [class.text-destructive]="!result.outcome.ok"
                [class.text-[var(--trust-strong)]]="result.outcome.ok"
                data-tester-summary
              >
                {{
                  (result.outcome.ok
                    ? 'routes.tester.ok'
                    : 'routes.tester.upstreamError'
                  ) | translate: { status: result.outcome.status }
                }}
              </p>
            }
          }
          @if (result.answer.status === 'answered') {
            <dl class="mt-facts" data-tester-facts>
              <dt>{{ 'routes.tester.status' | translate }}</dt>
              <dd class="mt-code" data-tester-status>
                {{ result.answer.httpStatus }}
              </dd>
              <dt>{{ 'routes.tester.duration' | translate }}</dt>
              <dd data-tester-duration>
                {{
                  'routes.tester.ms'
                    | translate: { ms: result.answer.durationMs }
                }}
              </dd>
            </dl>
            @if (result.headers.length > 0) {
              <div>
                <h5 class="text-sm font-medium">
                  {{ 'routes.tester.headers' | translate }}
                </h5>
                <dl class="mt-facts mt-1" data-tester-headers>
                  @for (header of result.headers; track header[0]) {
                    <dt class="mt-code">{{ header[0] }}</dt>
                    <dd class="mt-code break-all">{{ header[1] }}</dd>
                  }
                </dl>
              </div>
            }
            <div>
              <h5 class="text-sm font-medium">
                {{ 'routes.tester.body' | translate }}
              </h5>
              @if (result.body === '') {
                <p class="text-muted-foreground text-sm" data-tester-empty>
                  {{ 'routes.tester.empty' | translate }}
                </p>
              } @else {
                <pre
                  class="mt-command mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-all"
                  data-tester-response
                  >{{ result.body }}</pre>
              }
              @if (result.answer.truncated) {
                <p class="text-muted-foreground text-xs" data-tester-truncated>
                  {{ 'routes.tester.truncated' | translate }}
                </p>
              }
            </div>
          }
        </div>
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RequestTester {
  readonly projectId = input.required<string>();
  readonly name = input.required<string>();
  readonly route = input.required<CompiledRoute>();
  readonly closed = output();
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);

  protected readonly form = new FormGroup({
    url: new FormControl('', { nonNullable: true }),
    origin: new FormControl('', { nonNullable: true }),
    body: new FormControl('', { nonNullable: true }),
  });
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice | null>(null);
  protected readonly answer = signal<{
    readonly answer: GateAnswer;
    readonly outcome: TestOutcome;
    readonly headers: readonly (readonly [string, string])[];
    readonly body: string;
  } | null>(null);
  protected readonly hasBody = computed(() =>
    BODY_METHODS.includes(this.route().method),
  );
  private readonly url = signal('');
  /** The address the gate will be asked at, as gateTestTarget builds it. */
  protected readonly target = computed(() => {
    const base = this.url().trim().replace(/\/+$/, '');
    return `${base === '' ? '…' : base}${this.route().path}`;
  });

  constructor() {
    this.form.controls.url.valueChanges.subscribe((value) =>
      this.url.set(value),
    );
    // Another project or route: start from its own address, origin and body. A reload of the
    // same route (after an edit elsewhere) keeps what the person typed.
    effect(() => {
      const id = this.projectId();
      this.name();
      const route = untracked(() => this.route());
      this.form.setValue({
        url: storedUrl(id),
        origin: route.origins[0] ?? '',
        body: BODY_METHODS.includes(route.method) ? sampleBody(route.body) : '',
      });
      this.answer.set(null);
      this.notice.set(null);
    });
  }

  /** «Senden»: one request through the gate; nothing is stored but the gate's address. */
  protected async send(): Promise<void> {
    if (this.busy()) return;
    const id = this.projectId();
    const { url, origin, body } = this.form.getRawValue();
    this.busy.set(true);
    this.notice.set(null);
    this.answer.set(null);
    try {
      const answer = await firstValueFrom(
        this.http.post<GateAnswer>(
          apiUrl(`/projects/${encodeURIComponent(id)}/test-request`),
          {
            url: url.trim(),
            route: this.name(),
            body: this.hasBody() ? body : '',
            locale: this.translate.getCurrentLang() ?? '',
            ...(origin === '' ? {} : { origin }),
          },
        ),
      );
      storeUrl(id, url.trim());
      this.answer.set({
        answer,
        outcome: outcomeOf(answer),
        headers:
          answer.status === 'answered'
            ? Object.entries(answer.headers).sort(([a], [b]) =>
                a.localeCompare(b),
              )
            : [],
        body:
          answer.status === 'answered'
            ? prettyBody(answer.excerpt, answer.contentType, answer.truncated)
            : '',
      });
    } catch (error) {
      this.notice.set(noticeOf(error));
    } finally {
      this.busy.set(false);
    }
  }
}

function noticeOf(error: unknown): Notice {
  if (!(error instanceof HttpErrorResponse)) return 'failed';
  const code = (error.error as { error?: unknown } | null)?.error;
  return REQUEST_TESTER_NOTICES.find((known) => known === code) ?? 'failed';
}
