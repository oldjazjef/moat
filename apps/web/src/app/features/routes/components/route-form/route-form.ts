import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type OnInit,
  output,
} from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmButtonImports } from '@moat/ui/button';
import { HlmCardImports } from '@moat/ui/card';
import { HlmInputImports } from '@moat/ui/input';
import { HlmLabelImports } from '@moat/ui/label';
import {
  METHODS,
  NAME_PATTERN,
  QUOTA_PERIODS,
  USAGE_FORMATS,
  type Budget,
  type Quota,
  type RouteDefinition,
} from '../../../../core/api/project.types';
import { ProjectEdits } from '../../../../core/project/project-edits.service';
import type { RouteRow } from '../../pages/routes-page/routes-page.service';

type Method = (typeof METHODS)[number];

/** moat.yaml's spelling of a compiled size: the largest unit that divides it. */
export function sizeText(bytes: number): string {
  if (bytes >= 1_048_576 && bytes % 1_048_576 === 0)
    return `${bytes / 1_048_576}MiB`;
  if (bytes >= 1_024 && bytes % 1_024 === 0) return `${bytes / 1_024}KiB`;
  return `${bytes}B`;
}

/** moat.yaml's spelling of a compiled window: the largest unit that divides it. */
export function windowText(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** The form control of a budget field the core refused (`budget.cost.limit` → budgetLimit). */
function budgetControl(field: string): string {
  const last = field.split('.').at(-1) ?? '';
  const controls: Record<string, string> = {
    usage: 'budgetUsage',
    period: 'budgetPeriod',
    maxOutputTokens: 'budgetMaxOutput',
    cost: 'budgetLimit',
    limit: 'budgetLimit',
    inputPerMillion: 'budgetInput',
    outputPerMillion: 'budgetOutput',
  };
  // `budget` itself (neither tokens nor cost) and `budget.tokens`: the tokens field.
  return Object.hasOwn(controls, last)
    ? (controls[last] ?? '')
    : 'budgetTokens';
}

/** The size a route gets without `maxBodySize` (DEFAULT_MAX_BODY_BYTES in the core). */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const PATH = /^\//;

/**
 * «Neue Route» / «Route bearbeiten»: the route's fields as moat.yaml writes them. The form checks
 * only what it can show at once (a name, a leading "/"); everything else is checked by the core
 * like any moat.yaml, and a refused field is marked here (`value_invalid`).
 */
@Component({
  selector: 'mt-route-form',
  imports: [
    ReactiveFormsModule,
    TranslatePipe,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  templateUrl: './route-form.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RouteForm implements OnInit {
  protected readonly edits = inject(ProjectEdits);

  /** The route to change; null for a new one. */
  readonly route = input<RouteRow | null>(null);
  readonly upstreams = input.required<readonly string[]>();
  readonly closed = output();

  protected readonly methods = METHODS;
  protected readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(NAME_PATTERN)],
    }),
    method: new FormControl<Method>('POST', { nonNullable: true }),
    path: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(PATH)],
    }),
    upstream: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    upstreamPath: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(PATH)],
    }),
    maxBodySize: new FormControl('', { nonNullable: true }),
    origins: new FormControl('', { nonNullable: true }),
    limited: new FormControl(false, { nonNullable: true }),
    requests: new FormControl(10, { nonNullable: true }),
    window: new FormControl('1m', { nonNullable: true }),
    per: new FormControl<'ip' | 'route'>('ip', { nonNullable: true }),
    quotaOn: new FormControl(false, { nonNullable: true }),
    quotaRequests: new FormControl(1000, { nonNullable: true }),
    quotaPeriod: new FormControl<Quota['period']>('day', { nonNullable: true }),
    budgetOn: new FormControl(false, { nonNullable: true }),
    budgetUsage: new FormControl<Budget['usage']>('openai', {
      nonNullable: true,
    }),
    budgetPeriod: new FormControl<Budget['period']>('month', {
      nonNullable: true,
    }),
    budgetMaxOutput: new FormControl('4000', { nonNullable: true }),
    /** Empty = no token limit (then a cost limit is needed). */
    budgetTokens: new FormControl('', { nonNullable: true }),
    /** All three empty = no cost limit. */
    budgetLimit: new FormControl('', { nonNullable: true }),
    budgetInput: new FormControl('', { nonNullable: true }),
    budgetOutput: new FormControl('', { nonNullable: true }),
  });
  protected readonly periods = QUOTA_PERIODS;
  protected readonly usageFormats = USAGE_FORMATS;

  /** Fields the core refused in the last save, as form control names. */
  protected readonly refused = computed(() => {
    const outcome = this.edits.outcome();
    if (outcome?.kind !== 'error' || outcome.code !== 'value_invalid')
      return new Set<string>();
    return new Set(
      outcome.fields.map((field) => {
        const [first, second] = field.split('.');
        if (first === 'rateLimit') return second ?? 'requests';
        if (first === 'quota')
          return second === 'period' ? 'quotaPeriod' : 'quotaRequests';
        if (first === 'budget') return budgetControl(field);
        return first ?? '';
      }),
    );
  });

  ngOnInit(): void {
    const row = this.route();
    if (row === null) {
      this.form.controls.upstream.setValue(this.upstreams()[0] ?? '');
      return;
    }
    const { route } = row;
    this.form.controls.name.disable();
    this.form.patchValue({
      name: row.name,
      method: route.method as Method,
      path: route.path,
      upstream: route.upstream,
      upstreamPath: route.upstreamPath,
      maxBodySize:
        route.maxBodyBytes === DEFAULT_MAX_BODY_BYTES
          ? ''
          : sizeText(route.maxBodyBytes),
      origins: route.origins.join('\n'),
      limited: route.rateLimit !== null,
      requests: route.rateLimit?.requests ?? 10,
      window:
        route.rateLimit === null
          ? '1m'
          : windowText(route.rateLimit.windowSeconds),
      per: route.rateLimit?.per ?? 'ip',
      quotaOn: route.quota !== undefined,
      quotaRequests: route.quota?.requests ?? 1000,
      quotaPeriod: route.quota?.period ?? 'day',
      budgetOn: route.budget !== undefined,
      budgetUsage: route.budget?.usage ?? 'openai',
      budgetPeriod: route.budget?.period ?? 'month',
      budgetMaxOutput: String(route.budget?.maxOutputTokens ?? 4000),
      budgetTokens:
        route.budget?.tokens === undefined ? '' : String(route.budget.tokens),
      budgetLimit: route.budget?.cost?.limit ?? '',
      budgetInput: route.budget?.cost?.inputPerMillion ?? '',
      budgetOutput: route.budget?.cost?.outputPerMillion ?? '',
    });
  }

  /** Marked when the form or the core refused it. */
  protected invalid(control: string): boolean {
    const field = this.form.get(control);
    return (
      (field !== null && field.touched && field.invalid) ||
      this.refused().has(control)
    );
  }

  protected definition(): RouteDefinition {
    const value = this.form.getRawValue();
    const origins = value.origins
      .split('\n')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== '');
    const maxBodySize = value.maxBodySize.trim();
    return {
      method: value.method,
      path: value.path.trim(),
      upstream: value.upstream,
      upstreamPath: value.upstreamPath.trim(),
      ...(maxBodySize === '' ? {} : { maxBodySize }),
      ...(origins.length === 0 ? {} : { origins }),
      ...(value.limited
        ? {
            rateLimit: {
              requests: Number(value.requests),
              window: value.window.trim(),
              per: value.per,
            },
          }
        : {}),
      ...(value.quotaOn
        ? {
            quota: {
              requests: Number(value.quotaRequests),
              period: value.quotaPeriod,
            },
          }
        : {}),
      ...(value.budgetOn ? { budget: this.budget() } : {}),
    };
  }

  private budget(): Budget {
    const value = this.form.getRawValue();
    const tokens = value.budgetTokens.trim();
    const cost = {
      limit: value.budgetLimit.trim(),
      inputPerMillion: value.budgetInput.trim(),
      outputPerMillion: value.budgetOutput.trim(),
    };
    const hasCost = Object.values(cost).some((amount) => amount !== '');
    return {
      usage: value.budgetUsage,
      period: value.budgetPeriod,
      maxOutputTokens: Number(value.budgetMaxOutput.trim()),
      ...(tokens === '' ? {} : { tokens: Number(tokens) }),
      ...(hasCost ? { cost } : {}),
    };
  }

  protected async save(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const row = this.route();
    const saved = await this.edits.run(
      row === null
        ? {
            op: 'addRoute',
            route: this.form.controls.name.value.trim(),
            definition: this.definition(),
          }
        : { op: 'updateRoute', route: row.name, definition: this.definition() },
    );
    if (saved) this.closed.emit();
    else this.markRefused();
  }

  /**
   * A refused field gets an error of its own, so it reads as invalid everywhere (also to
   * hlmInput's own aria-invalid) until it is edited.
   */
  private markRefused(): void {
    for (const control of this.refused())
      this.form.get(control)?.setErrors({ refused: true });
  }
}
