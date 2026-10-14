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
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import { firstValueFrom } from 'rxjs';
import type { ProjectView } from '../../../../core/api/project.types';
import {
  GATE_TEST_REFUSALS,
  type GateAnswer,
  type Recipe,
} from '../../../../core/api/recipe.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import {
  desktopBridge,
  type BundleSignResult,
  type SecretSealResult,
} from '../../../../core/desktop/desktop-bridge';
import { RichText } from '../../../../shared/components/rich-text';
import { HelpLink } from '../../../help/components/help-link';
import { SetupPageService } from '../../pages/setup-page/setup-page.service';
import { provideSetupStep, SetupStepComponent } from '../setup-step';

/** `setup.recipe.notices.<notice>` */
export const RECIPE_NOTICES = [
  'route_exists',
  'upstream_exists',
  'value_invalid',
  'config_changed',
  'not_writable',
  'policy_failed',
  'failed',
  'required',
  'noProject',
  ...GATE_TEST_REFUSALS,
] as const;
type Notice = (typeof RECIPE_NOTICES)[number];

/**
 * Gate answers the wizard explains (`setup.recipe.codes.<code>`, gates/php/README.md Requests):
 * the ones a first test runs into. Any other answer is shown as it came.
 */
export const GATE_CODES = [
  'gate_not_configured',
  'gate_disabled',
  'route_disabled',
  'not_found',
  'method_not_allowed',
  'unsupported_media_type',
  'body_too_large',
  'body_invalid',
  'origin_forbidden',
  'request_unbounded',
  'rate_limited',
  'quota_exceeded',
  'budget_exhausted',
  'secret_unavailable',
  'upstream_forbidden',
  'upstream_unreachable',
  'upstream_timeout',
  'internal_error',
] as const;
type GateCode = (typeof GATE_CODES)[number];

/** What «Testen» brought back, as the template shows it. */
export type TestOutcome =
  | { readonly kind: 'failed'; readonly reason: string }
  | {
      readonly kind: 'gate';
      readonly status: number;
      readonly code: GateCode;
    }
  | {
      readonly kind: 'upstream';
      readonly status: number;
      readonly ok: boolean;
      readonly excerpt: string;
      readonly truncated: boolean;
    };

/** The gate's own error (`{"error":"<code>"}`) or the upstream's answer. */
export function outcomeOf(answer: GateAnswer): TestOutcome {
  if (answer.status === 'failed')
    return { kind: 'failed', reason: answer.reason };
  let code: unknown = null;
  try {
    code = (JSON.parse(answer.excerpt) as { error?: unknown } | null)?.error;
  } catch {
    code = null;
  }
  const known = GATE_CODES.find((gate) => gate === code);
  if (known !== undefined && answer.httpStatus >= 400)
    return { kind: 'gate', status: answer.httpStatus, code: known };
  return {
    kind: 'upstream',
    status: answer.httpStatus,
    ok: answer.httpStatus >= 200 && answer.httpStatus < 300,
    excerpt: answer.excerpt,
    truncated: answer.truncated,
  };
}

/**
 * FR-73, step «Erstes Recipe»: adds a recipe's upstream and route to the project (FR-43, the
 * `applyRecipe` edit), walks through sealing its secret and signing a bundle (the same main-process
 * windows as «Gates»), shows the local policy and the commands for the server, and sends one
 * test request through the gate («Testen»). The test reaches the real API, so the step says so.
 */
@Component({
  selector: 'mt-setup-recipe-step',
  imports: [
    TranslatePipe,
    ReactiveFormsModule,
    RichText,
    HelpLink,
    ...HlmButtonImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  providers: [provideSetupStep(() => RecipeStep)],
  template: `
    @if (service.project() === null) {
      <p class="mt-note" data-recipe-no-project>
        {{ 'setup.recipe.noProject' | translate }}
      </p>
    } @else {
      @if (applied(); as recipe) {
        <p class="text-sm" role="status" data-recipe-applied>
          {{
            'setup.recipe.applied'
              | translate
                : {
                    recipe:
                      'setup.recipe.recipes.' + recipe.id + '.title'
                      | translate,
                    route: recipe.route.input.path,
                  }
          }}
        </p>
      } @else {
        <form
          class="flex max-w-2xl flex-col gap-4"
          [formGroup]="form"
          (ngSubmit)="apply()"
          data-recipe-form
        >
          <fieldset class="flex flex-col gap-2">
            <legend class="mb-2 text-sm font-medium">
              {{ 'setup.recipe.choose' | translate }}
            </legend>
            @for (recipe of recipes(); track recipe.id) {
              <label class="mt-choice" [attr.data-recipe]="recipe.id">
                <input
                  type="radio"
                  formControlName="recipe"
                  [value]="recipe.id"
                />
                <span class="min-w-0">
                  <span class="block font-medium">{{
                    'setup.recipe.recipes.' + recipe.id + '.title' | translate
                  }}</span>
                  <span class="text-muted-foreground block text-sm">{{
                    'setup.recipe.recipes.' + recipe.id + '.description'
                      | translate
                  }}</span>
                  <span class="mt-code text-muted-foreground block text-xs"
                    >{{ recipe.route.input.method }}
                    {{ recipe.route.input.path }} →
                    {{ recipe.upstream.input.origin
                    }}{{ recipe.route.input.upstreamPath }}</span
                  >
                </span>
              </label>
            }
          </fieldset>
          <div class="grid gap-1">
            <label hlmLabel for="recipe-site">{{
              'setup.recipe.site' | translate
            }}</label>
            <input
              hlmInput
              id="recipe-site"
              class="mt-code"
              formControlName="site"
              [placeholder]="'setup.recipe.sitePlaceholder' | translate"
              autocomplete="off"
              spellcheck="false"
            />
            <p class="text-muted-foreground text-xs">
              {{ 'setup.recipe.siteHint' | translate }}
            </p>
          </div>
          <div>
            <button hlmBtn type="submit" data-recipe-apply [disabled]="busy()">
              {{ 'setup.recipe.apply' | translate }}
            </button>
          </div>
        </form>
      }

      @if (applied(); as recipe) {
        @if (gate(); as gate) {
          <ol class="mt-6 flex list-decimal flex-col gap-5 pl-5 text-sm">
            <li data-recipe-seal>
              <p>
                {{
                  'setup.recipe.seal'
                    | translate: { secret: recipe.secret, gate: gate.name }
                }}
              </p>
              <p class="text-muted-foreground mt-1">
                {{ 'setup.recipe.scopes.' + recipe.id | translate }}
              </p>
              <div class="mt-2 flex flex-wrap items-center gap-3">
                @if (sealedVersion(); as version) {
                  <span data-recipe-sealed>{{
                    'setup.recipe.sealed' | translate: { version: version }
                  }}</span>
                }
                @if (bridge !== null) {
                  <button
                    hlmBtn
                    size="sm"
                    [variant]="sealedVersion() === null ? 'default' : 'outline'"
                    type="button"
                    data-recipe-seal-button
                    [disabled]="busy()"
                    (click)="seal(gate.name, recipe.secret)"
                  >
                    {{ 'gates.seal' | translate }}
                  </button>
                }
              </div>
              @if (sealResult(); as result) {
                <p class="mt-1" role="status" data-recipe-seal-result>
                  <mt-rich-text
                    [text]="
                      sealText(result)
                        | translate
                          : sealParams(result, gate.name, recipe.secret)
                    "
                  />
                </p>
              }
            </li>

            <li data-recipe-sign>
              <p>{{ 'setup.recipe.sign' | translate: { gate: gate.name } }}</p>
              <div class="mt-2 flex flex-wrap items-center gap-3">
                @if (gate.latestBundle > 0) {
                  <span data-recipe-bundle>{{
                    'setup.recipe.bundle'
                      | translate: { version: gate.latestBundle }
                  }}</span>
                }
                @if (bridge !== null) {
                  <button
                    hlmBtn
                    size="sm"
                    type="button"
                    data-recipe-sign-button
                    [disabled]="busy() || sealedVersion() === null"
                    (click)="sign(gate.name)"
                  >
                    {{ 'gates.sign' | translate }}
                  </button>
                }
              </div>
              @if (signResult(); as result) {
                <p class="mt-1" role="status" data-recipe-sign-result>
                  <mt-rich-text
                    [text]="
                      signText(result)
                        | translate: signParams(result, gate.name)
                    "
                  />
                </p>
              }
            </li>

            <li data-recipe-server>
              <div class="flex items-center gap-1">
                <mt-rich-text [text]="'setup.recipe.server' | translate" />
                <mt-help-link section="gate" />
              </div>
              <div class="mt-2">
                <button
                  hlmBtn
                  size="sm"
                  variant="outline"
                  type="button"
                  data-recipe-policy-button
                  [disabled]="busy()"
                  (click)="loadPolicy()"
                >
                  {{ 'setup.recipe.showPolicy' | translate }}
                </button>
              </div>
              @if (policy(); as text) {
                <pre class="mt-command" data-recipe-policy>{{ text }}</pre>
              }
              <pre class="mt-command" data-recipe-commands>{{
                commands()
              }}</pre>
              <p class="text-muted-foreground mt-1">
                <mt-rich-text
                  [text]="
                    'setup.recipe.bundleFile'
                      | translate
                        : {
                            file:
                              'bundles/' +
                              gate.name +
                              '/' +
                              (gate.latestBundle || 1) +
                              '.json',
                          }
                  "
                />
              </p>
            </li>

            <li data-recipe-test>
              <p>
                <mt-rich-text [text]="'setup.recipe.test' | translate" />
              </p>
              <p class="mt-warning-text mt-1" data-recipe-test-warning>
                {{ 'setup.recipe.testWarning.' + recipe.id | translate }}
              </p>
              <form
                class="mt-3 grid max-w-2xl gap-3"
                [formGroup]="testForm"
                (ngSubmit)="test(recipe)"
                data-recipe-test-form
              >
                <div class="grid gap-1">
                  <label hlmLabel for="recipe-gate-url">{{
                    'setup.recipe.gateUrl' | translate
                  }}</label>
                  <input
                    hlmInput
                    id="recipe-gate-url"
                    class="mt-code"
                    formControlName="url"
                    [placeholder]="
                      'setup.recipe.gateUrlPlaceholder' | translate
                    "
                    autocomplete="off"
                    spellcheck="false"
                  />
                </div>
                <div class="grid gap-1">
                  <label hlmLabel for="recipe-body">{{
                    'setup.recipe.body' | translate
                  }}</label>
                  <textarea
                    hlmInput
                    id="recipe-body"
                    class="mt-code min-h-32"
                    formControlName="body"
                    spellcheck="false"
                  ></textarea>
                </div>
                <div>
                  <button
                    hlmBtn
                    type="submit"
                    data-recipe-test-button
                    [disabled]="busy()"
                  >
                    {{ 'setup.recipe.testButton' | translate }}
                  </button>
                </div>
              </form>
              @if (outcome(); as result) {
                <div
                  class="mt-3"
                  role="status"
                  data-recipe-outcome
                  [attr.data-kind]="result.kind"
                >
                  @switch (result.kind) {
                    @case ('failed') {
                      <p class="text-destructive">
                        <mt-rich-text
                          [text]="
                            'setup.recipe.failed.' + result.reason | translate
                          "
                        />
                      </p>
                    }
                    @case ('gate') {
                      <p [attr.data-code]="result.code">
                        <span class="mt-code"
                          >{{ result.status }} {{ result.code }}</span
                        >
                        ·
                        <mt-rich-text
                          [text]="
                            'setup.recipe.codes.' + result.code | translate
                          "
                        />
                      </p>
                    }
                    @case ('upstream') {
                      <p
                        [class.text-destructive]="!result.ok"
                        [class.text-[var(--trust-strong)]]="result.ok"
                      >
                        {{
                          (result.ok
                            ? 'setup.recipe.passed'
                            : 'setup.recipe.upstreamError'
                          ) | translate: { status: result.status }
                        }}
                      </p>
                      @if (result.excerpt !== '') {
                        <pre
                          class="mt-command"
                          data-recipe-excerpt>{{ result.excerpt }}@if (result.truncated) {…}</pre>
                      }
                    }
                  }
                </div>
              }
            </li>
          </ol>
        } @else {
          <p class="mt-note mt-6" data-recipe-no-gate>
            {{ 'setup.recipe.noGate' | translate }}
          </p>
        }
      }
    }
    @if (notice(); as code) {
      <p
        class="text-destructive mt-4 text-sm"
        role="alert"
        data-recipe-notice
        [attr.data-code]="code"
      >
        {{ 'setup.recipe.notices.' + code | translate }}
      </p>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecipeStep extends SetupStepComponent {
  protected readonly service = inject(SetupPageService);
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  protected readonly bridge = desktopBridge();

  private readonly recipeList = httpResource<readonly Recipe[]>(() =>
    apiUrl('/recipes'),
  );
  protected readonly recipes = computed(() =>
    this.recipeList.hasValue() ? this.recipeList.value() : [],
  );
  protected readonly project = httpResource<ProjectView>(() => {
    const id = this.service.project();
    return id === null
      ? undefined
      : apiUrl(`/projects/${encodeURIComponent(id)}`);
  });
  private readonly view = computed(() =>
    this.project.hasValue() ? this.project.value() : null,
  );
  private readonly routes = computed(() => {
    const config = this.view()?.project?.config;
    return config?.status === 'valid' ? config.config.routes : {};
  });
  /** The first recipe whose route is in the project (applied now or before). */
  protected readonly applied = computed(() => {
    const routes = this.routes();
    return (
      this.recipes().find((recipe) =>
        Object.hasOwn(routes, recipe.route.name),
      ) ?? null
    );
  });
  /** The project's first valid gate: the one the test goes through. */
  protected readonly gate = computed(() => {
    const gates = this.view()?.project?.gates ?? [];
    for (const gate of gates) if (gate.status === 'valid') return gate;
    return null;
  });
  protected readonly sealedVersion = computed(() => {
    const recipe = this.applied();
    const gate = this.gate();
    if (recipe === null || gate === null) return null;
    return (
      gate.secrets.find((secret) => secret.name === recipe.secret)
        ?.secretVersion ?? null
    );
  });
  protected readonly commands = computed(() => {
    const gate = this.gate();
    const version =
      gate === null || gate.latestBundle === 0 ? 1 : gate.latestBundle;
    return [
      'php moat-gate.php policy policy.json',
      `php moat-gate.php accept ${version}.json`,
    ].join('\n');
  });

  protected readonly form = new FormGroup({
    recipe: new FormControl('hubspot-newsletter', { nonNullable: true }),
    site: new FormControl('', { nonNullable: true }),
  });
  protected readonly testForm = new FormGroup({
    url: new FormControl('', { nonNullable: true }),
    body: new FormControl('', { nonNullable: true }),
  });
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice | null>(null);
  protected readonly policy = signal<string | null>(null);
  protected readonly outcome = signal<TestOutcome | null>(null);
  protected readonly sealResult = signal<Exclude<
    SecretSealResult,
    { status: 'cancelled' }
  > | null>(null);
  protected readonly signResult = signal<Exclude<
    BundleSignResult,
    { status: 'cancelled' }
  > | null>(null);

  constructor() {
    super();
    // The applied recipe's test body, once (the person may change it).
    effect(() => {
      const recipe = this.applied();
      if (recipe !== null && this.testForm.controls.body.value === '')
        this.testForm.controls.body.setValue(recipe.testBody);
    });
    // Another project: start over.
    effect(() => {
      this.service.project();
      this.policy.set(null);
      this.outcome.set(null);
      this.sealResult.set(null);
      this.signResult.set(null);
    });
  }

  /** «Übernehmen»: the recipe's upstream and route go into moat.yaml (applyRecipe edit). */
  protected async apply(): Promise<void> {
    const view = this.view();
    if (view === null || view.configHash === null || this.busy()) return;
    const { recipe, site } = this.form.getRawValue();
    const origin = site.trim().replace(/\/+$/, '');
    await this.run(async () => {
      this.project.set(
        await firstValueFrom(
          this.http.post<ProjectView>(
            apiUrl(`/projects/${encodeURIComponent(view.id)}/config/edits`),
            {
              base: view.configHash,
              op: 'applyRecipe',
              recipe,
              ...(origin === '' ? {} : { origins: [origin] }),
            },
          ),
        ),
      );
    });
  }

  protected async seal(gate: string, name: string): Promise<void> {
    const id = this.service.project();
    if (this.bridge === null || id === null || this.busy()) return;
    this.busy.set(true);
    let result: SecretSealResult;
    try {
      result = await this.bridge.secret.seal(id, gate, name, this.locale());
    } catch {
      result = { status: 'failed' };
    } finally {
      this.busy.set(false);
    }
    if (result.status === 'cancelled') return;
    this.sealResult.set(result);
    this.project.reload();
  }

  protected async sign(gate: string): Promise<void> {
    const id = this.service.project();
    if (this.bridge === null || id === null || this.busy()) return;
    this.busy.set(true);
    let result: BundleSignResult;
    try {
      result = await this.bridge.bundle.sign(id, gate, this.locale());
    } catch {
      result = { status: 'failed' };
    } finally {
      this.busy.set(false);
    }
    if (result.status === 'cancelled') return;
    this.signResult.set(result);
    this.project.reload();
  }

  protected sealText(
    result: Exclude<SecretSealResult, { status: 'cancelled' }>,
  ): string {
    return result.status === 'refused'
      ? `gates.sealResult.${result.code}`
      : `gates.sealResult.${result.status}`;
  }

  protected sealParams(
    result: Exclude<SecretSealResult, { status: 'cancelled' }>,
    gate: string,
    name: string,
  ): Record<string, string | number> {
    return result.status === 'sealed'
      ? { gate, name, version: result.secretVersion }
      : { gate, name };
  }

  protected signText(
    result: Exclude<BundleSignResult, { status: 'cancelled' }>,
  ): string {
    return result.status === 'refused'
      ? `gates.signResult.${result.code}`
      : `gates.signResult.${result.status}`;
  }

  protected signParams(
    result: Exclude<BundleSignResult, { status: 'cancelled' }>,
    gate: string,
  ): Record<string, string | number> {
    if (result.status === 'signed') return { gate, version: result.version };
    if (result.status === 'refused')
      return { gate, secrets: result.secrets.join(', ') };
    return { gate };
  }

  /** «Richtlinie anzeigen»: what `moat policy suggest` prints, to install on the gate. */
  protected async loadPolicy(): Promise<void> {
    const id = this.service.project();
    if (id === null || this.busy()) return;
    await this.run(async () => {
      try {
        const policy = await firstValueFrom(
          this.http.get<unknown>(
            apiUrl(`/projects/${encodeURIComponent(id)}/policy`),
          ),
        );
        this.policy.set(`${JSON.stringify(policy, null, 2)}\n`);
      } catch {
        this.notice.set('policy_failed');
      }
    });
  }

  /**
   * «Testen»: one request through the gate; nothing is stored. Moat Desktop asks in a window of
   * its own before the first request to an address (T-59).
   */
  protected async test(recipe: Recipe): Promise<void> {
    const id = this.service.project();
    if (id === null || this.busy()) return;
    this.outcome.set(null);
    const { url, body } = this.testForm.getRawValue();
    await this.run(async () => {
      const answer = await firstValueFrom(
        this.http.post<GateAnswer>(
          apiUrl(`/projects/${encodeURIComponent(id)}/test-request`),
          {
            url: url.trim(),
            route: recipe.route.name,
            body,
            locale: this.locale(),
          },
        ),
      );
      this.outcome.set(outcomeOf(answer));
    });
  }

  /** «Weiter» needs a route in the project; the test itself is up to the person. */
  async submit(): Promise<boolean> {
    if (this.service.project() === null) {
      this.notice.set('noProject');
      return false;
    }
    if (Object.keys(this.routes()).length > 0) return true;
    this.notice.set('required');
    return false;
  }

  private locale(): string {
    return this.translate.getCurrentLang() ?? '';
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.notice.set(null);
    try {
      await work();
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
  return RECIPE_NOTICES.find((known) => known === code) ?? 'failed';
}
