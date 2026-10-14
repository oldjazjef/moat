/**
 * `GET /api/recipes`, `POST /api/projects/:id/test-request` — a mirror of libs/core
 * (recipes/recipes.ts) and apps/api/src/gate-test (ports/gate-client.port.ts). The web app
 * imports neither; keep them in step.
 */
/** Recipe ids as libs/core RECIPE_IDS: each has texts under `setup.recipe.recipes.<id>`. */
export const RECIPE_IDS = ['hubspot-newsletter', 'openai-chat'] as const;

export interface Recipe {
  readonly id: (typeof RECIPE_IDS)[number];
  readonly upstream: {
    readonly name: string;
    readonly input: { readonly origin: string };
  };
  readonly route: {
    readonly name: string;
    readonly input: {
      readonly method: string;
      readonly path: string;
      readonly upstreamPath: string;
    };
  };
  readonly secret: string;
  readonly testBody: string;
}

export const GATE_FAILURES = [
  'address_forbidden',
  'not_found',
  'unreachable',
  'timeout',
  'tls',
] as const;
export type GateFailure = (typeof GATE_FAILURES)[number];

export type GateAnswer =
  | {
      readonly status: 'answered';
      readonly httpStatus: number;
      readonly contentType: string | null;
      readonly excerpt: string;
      readonly truncated: boolean;
    }
  | { readonly status: 'failed'; readonly reason: GateFailure };

/** 422 of `POST /api/projects/:id/test-request`: nothing was sent. */
export const GATE_TEST_REFUSALS = [
  'config_missing',
  'config_invalid',
  'route_unknown',
  'url_invalid',
  'body_invalid',
] as const;
