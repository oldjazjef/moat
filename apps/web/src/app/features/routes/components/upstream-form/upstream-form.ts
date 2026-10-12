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
  AUTH_TYPES,
  NAME_PATTERN,
  type UpstreamDefinition,
} from '../../../../core/api/project.types';
import { ProjectEdits } from '../../../../core/project/project-edits.service';
import { RichText } from '../../../../shared/components/rich-text';
import type { UpstreamRow } from '../../pages/routes-page/routes-page.service';

type AuthChoice = 'none' | (typeof AUTH_TYPES)[number];

/** The timeout an upstream gets without `timeout` (DEFAULT_TIMEOUT_MS in the core). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** moat.yaml's spelling of a compiled timeout: whole seconds when it is, else milliseconds. */
export function timeoutText(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/** The control that shows the core's field: `auth.name` → `header`, `auth.param` → `param`. */
function controlOf(field: string): string {
  const [first, second] = field.split('.');
  if (first !== 'auth') return first === 'timeout' ? 'timeout' : 'origin';
  if (second === 'name') return 'header';
  return second === 'param' || second === 'secret' ? second : 'auth';
}

/**
 * «Neuer Upstream» / «Upstream bearbeiten»: the API the gate calls and how it signs in. The
 * secret is named only; its value is sealed with the CLI (SEC-31, SEC-37), so this form has no
 * field that could take it.
 */
@Component({
  selector: 'mt-upstream-form',
  imports: [
    ReactiveFormsModule,
    TranslatePipe,
    RichText,
    ...HlmButtonImports,
    ...HlmCardImports,
    ...HlmInputImports,
    ...HlmLabelImports,
  ],
  templateUrl: './upstream-form.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpstreamForm implements OnInit {
  protected readonly edits = inject(ProjectEdits);

  /** The upstream to change; null for a new one. */
  readonly upstream = input<UpstreamRow | null>(null);
  readonly closed = output();

  protected readonly authTypes: readonly AuthChoice[] = ['none', ...AUTH_TYPES];
  protected readonly form = new FormGroup({
    name: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(NAME_PATTERN)],
    }),
    origin: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.pattern(/^\s*https:\/\//)],
    }),
    auth: new FormControl<AuthChoice>('bearer', { nonNullable: true }),
    header: new FormControl('', { nonNullable: true }),
    param: new FormControl('', { nonNullable: true }),
    secret: new FormControl('', {
      nonNullable: true,
      validators: [Validators.pattern(NAME_PATTERN)],
    }),
    timeout: new FormControl('', { nonNullable: true }),
  });

  /** Fields the core refused in the last save, as form control names. */
  protected readonly refused = computed(() => {
    const outcome = this.edits.outcome();
    if (outcome?.kind !== 'error' || outcome.code !== 'value_invalid')
      return new Set<string>();
    return new Set(outcome.fields.map(controlOf));
  });

  ngOnInit(): void {
    const row = this.upstream();
    if (row === null) return;
    const { upstream } = row;
    const auth = upstream.auth;
    this.form.controls.name.disable();
    this.form.patchValue({
      name: row.name,
      origin: upstream.origin,
      auth: auth?.type ?? 'none',
      header: auth?.type === 'header' ? auth.name : '',
      param: auth?.type === 'query' ? auth.param : '',
      secret: auth?.secret ?? '',
      timeout:
        upstream.timeoutMs === DEFAULT_TIMEOUT_MS
          ? ''
          : timeoutText(upstream.timeoutMs),
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

  /** The secret, header and parameter are required only for the auth type that uses them. */
  private missing(): boolean {
    const { auth, secret, header, param } = this.form.getRawValue();
    const empty = (control: 'secret' | 'header' | 'param', value: string) => {
      const blank = value.trim() === '';
      this.form.controls[control].setErrors(
        blank ? { required: true } : this.form.controls[control].errors,
      );
      return blank;
    };
    if (auth === 'none') return false;
    const noSecret = empty('secret', secret);
    if (auth === 'header') return empty('header', header) || noSecret;
    if (auth === 'query') return empty('param', param) || noSecret;
    return noSecret;
  }

  protected definition(): UpstreamDefinition {
    const value = this.form.getRawValue();
    const secret = value.secret.trim();
    const timeout = value.timeout.trim();
    const auth: UpstreamDefinition['auth'] =
      value.auth === 'bearer'
        ? { type: 'bearer', secret }
        : value.auth === 'header'
          ? { type: 'header', name: value.header.trim(), secret }
          : value.auth === 'query'
            ? { type: 'query', param: value.param.trim(), secret }
            : undefined;
    return {
      origin: value.origin.trim(),
      ...(auth === undefined ? {} : { auth }),
      ...(timeout === '' ? {} : { timeout }),
    };
  }

  protected async save(): Promise<void> {
    this.form.markAllAsTouched();
    if (this.missing() || this.form.invalid) return;
    const row = this.upstream();
    const saved = await this.edits.run(
      row === null
        ? {
            op: 'addUpstream',
            upstream: this.form.controls.name.value.trim(),
            upstreamDefinition: this.definition(),
          }
        : {
            op: 'updateUpstream',
            upstream: row.name,
            upstreamDefinition: this.definition(),
          },
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
