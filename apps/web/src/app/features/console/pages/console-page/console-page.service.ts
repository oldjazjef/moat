import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { FormControl, FormGroup } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  DRY_RUN_REFUSALS,
  MAX_DRY_RUN_BODY,
  type DryRunResult,
} from '../../../../core/api/dry-run.types';
import { apiUrl } from '../../../../core/config/runtime-env';
import { ProjectResource } from '../../../../core/project/project-resource.service';

/** `console.notices.<notice>`: why no answer came. */
export const CONSOLE_NOTICES = [
  ...DRY_RUN_REFUSALS,
  'body_too_long',
  'failed',
] as const;
export type ConsoleNotice = (typeof CONSOLE_NOTICES)[number];
/** `console.counters.<key>`: windows in seconds, quotas per calendar period. */
export const CONSOLE_COUNTERS = [
  'perIp',
  'total',
  'route',
  'quotaPeriod',
  'routeQuotaPeriod',
] as const;
/** `console.periods.<period>`. */
export const CONSOLE_PERIODS = ['day', 'month'] as const;

/** The JSON body a route of this method gets as an example. */
const EXAMPLE_BODY = '{}';
const WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

/**
 * The test console (FR-42): a request as a website would send it to the gate, and what the gate
 * would do with it — worked out by the API from moat.yaml and the suggested policy, before
 * anything is signed. Nothing is sent to a gate or an upstream, and no secret is opened: the
 * answer shows where the gate would put it.
 */
@Injectable()
export class ConsolePageService {
  readonly resource = inject(ProjectResource);
  private readonly http = inject(HttpClient);

  readonly form = new FormGroup({
    gate: new FormControl('', { nonNullable: true }),
    method: new FormControl('POST', { nonNullable: true }),
    path: new FormControl('/', { nonNullable: true }),
    origin: new FormControl('', { nonNullable: true }),
    contentType: new FormControl('application/json', { nonNullable: true }),
    requestMethod: new FormControl('POST', { nonNullable: true }),
    body: new FormControl(EXAMPLE_BODY, { nonNullable: true }),
  });

  readonly busy = signal(false);
  readonly result = signal<DryRunResult | null>(null);
  readonly notice = signal<ConsoleNotice | null>(null);

  private readonly config = computed(() => {
    const config = this.resource.config();
    return config?.status === 'valid' ? config.config : null;
  });

  /** The config could not be compiled (or is missing): the overview says why. */
  readonly unusable = computed(
    () => this.resource.project() !== null && this.config() === null,
  );

  /** Routes to start from, sorted by name. */
  readonly routes = computed(() =>
    Object.entries(this.config()?.routes ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, route]) => ({ name, route })),
  );

  /** Gates whose lock and sealed secrets can count. */
  readonly gates = computed(() =>
    this.resource
      .gates()
      .filter((gate) => gate.status === 'valid')
      .map((gate) => gate.name),
  );

  /** Fills the request from a route: its method and path, a JSON body when it takes one. */
  useRoute(name: string): void {
    const entry = this.routes().find((row) => row.name === name);
    if (entry === undefined) return;
    const { route } = entry;
    this.form.patchValue({
      method: route.method,
      path: route.path,
      origin: route.origins[0] ?? '',
      contentType: WITH_BODY.has(route.method)
        ? (route.contentTypes[0] ?? 'application/json')
        : '',
      requestMethod: route.method,
      body: WITH_BODY.has(route.method) ? EXAMPLE_BODY : '',
    });
    this.result.set(null);
    this.notice.set(null);
  }

  async run(): Promise<void> {
    if (this.busy()) return;
    const value = this.form.getRawValue();
    this.result.set(null);
    this.notice.set(null);
    if (new TextEncoder().encode(value.body).length > MAX_DRY_RUN_BODY) {
      this.notice.set('body_too_long');
      return;
    }
    const optional = (text: string) =>
      text.trim() === '' ? null : text.trim();
    this.busy.set(true);
    try {
      this.result.set(
        await firstValueFrom(
          this.http.post<DryRunResult>(
            apiUrl(
              `/projects/${encodeURIComponent(this.resource.id())}/dry-run`,
            ),
            {
              gate: optional(value.gate),
              method: value.method,
              path: value.path.trim(),
              origin: optional(value.origin),
              contentType: optional(value.contentType),
              requestMethod:
                value.method === 'OPTIONS' ? value.requestMethod : null,
              body: value.body,
            },
          ),
        ),
      );
    } catch (error) {
      this.notice.set(noticeOf(error));
    } finally {
      this.busy.set(false);
    }
  }
}

function noticeOf(error: unknown): ConsoleNotice {
  if (!(error instanceof HttpErrorResponse)) return 'failed';
  // Escaped as JSON, a body can still exceed the API's request limit.
  if (error.status === 413) return 'body_too_long';
  const code = (error.error as { error?: unknown } | null)?.error;
  return DRY_RUN_REFUSALS.find((known) => known === code) ?? 'failed';
}
