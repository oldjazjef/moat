/**
 * `POST /api/projects/:id/dry-run` (FR-42) — a mirror of libs/core (gate/dry-run.ts) and
 * apps/api/src/gate-test (application/dry-run.handler.ts). The web app imports neither; keep
 * them in step.
 */
export const DRY_RUN_ERRORS = [
  'not_found',
  'method_not_allowed',
  'path_invalid',
  'request_unbounded',
  'body_too_large',
  'unsupported_media_type',
  'origin_forbidden',
  'preflight_rejected',
  'route_disabled',
  'gate_disabled',
  'gate_not_configured',
  'secret_unavailable',
] as const;
export type DryRunError = (typeof DRY_RUN_ERRORS)[number];

/** The methods the console offers: the gate's routes' plus a CORS preflight. */
export const DRY_RUN_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

/** Stands for a secret's value wherever the gate would put it (core SECRET_PLACEHOLDER). */
export const SECRET_PLACEHOLDER = '<SECRET>';
/** The longest body the console sends (core MAX_DRY_RUN_BODY). */
export const MAX_DRY_RUN_BODY = 32 * 1024;

export interface DryRunBody {
  readonly gate: string | null;
  readonly method: string;
  readonly path: string;
  readonly origin: string | null;
  readonly contentType: string | null;
  readonly requestMethod: string | null;
  readonly body: string;
}

export interface DryRunCounter {
  readonly kind: 'perIp' | 'total' | 'route' | 'quota' | 'routeQuota';
  readonly requests: number;
  readonly per: number | 'day' | 'month';
}

export interface DryRunBudget {
  readonly scope: 'host' | 'route';
  readonly budget: {
    readonly usage: string;
    readonly period: 'day' | 'month';
    readonly maxOutputTokens: number;
    readonly tokens?: number;
  };
}

export type DryRunResult =
  | { readonly kind: 'not_accepted'; readonly code: string }
  | {
      readonly kind: 'refused';
      readonly status: number;
      readonly error: DryRunError;
      readonly route: string | null;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'preflight';
      readonly status: 204;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'forwarded';
      readonly route: string;
      readonly call: {
        readonly method: string;
        readonly url: string;
        readonly headers: readonly (readonly [string, string])[];
        readonly body: string;
        readonly timeoutMs: number;
        readonly secret: string | null;
      };
      readonly headers: Readonly<Record<string, string>>;
      readonly counters: readonly DryRunCounter[];
      readonly budgets: readonly DryRunBudget[];
      readonly estimate: {
        readonly input: number;
        readonly output: number;
      } | null;
    };

/** 422 of the endpoint. */
export const DRY_RUN_REFUSALS = [
  'config_missing',
  'config_invalid',
  'gate_unknown',
] as const;
export type DryRunRefusal = (typeof DRY_RUN_REFUSALS)[number];
