/**
 * `GET /api/projects…` — a mirror of `ProjectSummary` / `ProjectView`
 * (apps/api/src/project/project.types.ts) and
 * `ProjectState` (libs/core/src/storage/project.ts). The web app does not import the core; keep
 * these in step. Never carries a secret or ciphertext.
 */
export type TrustMode = 'convenient' | 'signed' | 'passkey';

export interface ConfigIssue {
  readonly code: string;
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export interface RateLimit {
  readonly requests: number;
  readonly windowSeconds: number;
  readonly per: 'ip' | 'route';
}

export const QUOTA_PERIODS = ['day', 'month'] as const;

export interface Quota {
  readonly requests: number;
  readonly period: (typeof QUOTA_PERIODS)[number];
}

/** FR-31: where an AI API reports the tokens an answer used (USAGE_FORMATS in libs/core). */
export const USAGE_FORMATS = ['openai', 'anthropic', 'gemini'] as const;

/** FR-31: tokens and/or cost per calendar day or month (UTC); amounts as decimal text. */
export interface Budget {
  readonly usage: (typeof USAGE_FORMATS)[number];
  readonly period: (typeof QUOTA_PERIODS)[number];
  /** The highest output cap (`max_tokens` & co.) a request may ask for; others are refused. */
  readonly maxOutputTokens: number;
  readonly tokens?: number;
  readonly cost?: {
    readonly limit: string;
    readonly inputPerMillion: string;
    readonly outputPerMillion: string;
  };
}

export interface CompiledRoute {
  readonly method: string;
  readonly path: string;
  readonly upstream: string;
  readonly upstreamPath: string;
  readonly maxBodyBytes: number;
  readonly contentTypes: readonly string[];
  readonly responseContentTypes: readonly string[];
  readonly enabled: boolean;
  readonly origins: readonly string[];
  readonly rateLimit: RateLimit | null;
  /** FR-31: requests per calendar day or month (UTC) for the whole route; absent = none. */
  readonly quota?: Quota;
  /** FR-31: a budget for an AI API; absent = none. */
  readonly budget?: Budget;
  /** FR-13: the fields of the JSON body the gate forwards; absent = the body as received. */
  readonly body?: BodyFields;
  /** FR-16: who may call the route (libs/core/src/http/client.ts). */
  readonly client?: ClientProtection;
}

/** FR-16, compiled: every header and the verify URL filled in. */
export interface ClientProtection {
  readonly apiKey?: { readonly header: string; readonly secret: string };
  readonly jwt?: {
    readonly issuer: string;
    readonly audience: string;
    readonly keys: readonly { readonly kid: string; readonly alg: string }[];
  };
  readonly turnstile?: {
    readonly header: string;
    readonly secret: string;
    readonly verifyUrl: string;
  };
  readonly honeypot?: { readonly field: string };
}

/** FR-13: a body field (libs/core/src/http/body.ts). */
export interface BodyField {
  readonly type: 'string' | 'integer' | 'boolean' | 'object' | 'array';
  readonly required?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly enum?: readonly string[];
  readonly format?: 'email';
  readonly minimum?: number;
  readonly maximum?: number;
  readonly fields?: BodyFields;
  readonly items?: BodyField;
  readonly minItems?: number;
  readonly maxItems?: number;
}
export type BodyFields = Readonly<Record<string, BodyField>>;

export interface CompiledUpstream {
  readonly origin: string;
  readonly auth:
    | { readonly type: 'bearer'; readonly secret: string }
    | {
        readonly type: 'header';
        readonly name: string;
        readonly secret: string;
      }
    | {
        readonly type: 'basic';
        readonly username: string;
        readonly secret: string;
      }
    | {
        readonly type: 'oauth2';
        readonly tokenUrl: string;
        readonly clientId: string;
        readonly scope?: string;
        readonly secret: string;
      }
    | {
        readonly type: 'query';
        readonly param: string;
        readonly secret: string;
      }
    | null;
  readonly timeoutMs: number;
}

export type ConfigState =
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly issues: readonly ConfigIssue[] }
  | {
      readonly status: 'valid';
      readonly config: {
        readonly version: 1;
        readonly enabled?: boolean;
        readonly upstreams: Readonly<Record<string, CompiledUpstream>>;
        readonly routes: Readonly<Record<string, CompiledRoute>>;
      };
      readonly secretNames: readonly string[];
      readonly environments: readonly EnvironmentState[];
    };

export interface EnvironmentState {
  readonly name: string;
  /** False: every gate in it is locked. */
  readonly enabled: boolean;
  readonly gates: readonly string[];
}

export interface GateLockState {
  readonly environment: string | null;
  readonly gateLocked: boolean;
  readonly environmentLocked: boolean;
  /** False when either lock applies. */
  readonly enabled: boolean;
}

export type GateState =
  | { readonly name: string; readonly status: 'invalid' }
  | {
      readonly name: string;
      readonly status: 'valid';
      readonly gateId: string;
      readonly trustMode: TrustMode;
      readonly boxKeyId: string;
      readonly boxKeyFingerprint: string;
      readonly secrets: readonly {
        readonly name: string;
        readonly secretVersion: number;
      }[];
      readonly missingSecrets: readonly string[];
      readonly latestBundle: number;
      /** null while moat.yaml is not valid. */
      readonly lock: GateLockState | null;
      /** Whether the latest bundle carries the lock; null without a readable bundle. */
      readonly latestBundleLocked: boolean | null;
      /** Key ids in the latest bundle's signatures (SEC-08); null without a readable bundle. */
      readonly latestBundleSigners: readonly string[] | null;
    };

export interface ProjectState {
  readonly config: ConfigState;
  readonly gates: readonly GateState[];
}

/** One card of `GET /api/projects`. */
export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  /** null: the folder can no longer be read. */
  readonly config: ConfigState['status'] | null;
  readonly routes: number;
  readonly gates: number;
  readonly gatesMissingSecrets: readonly string[];
  /** Gates moat.yaml locks, on their own or with their environment. */
  readonly gatesLocked: readonly string[];
}

/** `GET /api/projects/:id`; `project` is null when the folder can no longer be read. */
export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly project: ProjectState | null;
  /** SHA-256 of moat.yaml as read; the `base` of the next edit. Null when there is none. */
  readonly configHash: string | null;
}

/** `POST /api/projects/:id/config/edits` (ConfigEdit in apps/api/src/project/project.types.ts). */
export type ConfigEdit =
  | {
      readonly op: 'addEnvironment' | 'lockEnvironment' | 'unlockEnvironment';
      readonly environment: string;
    }
  | { readonly op: 'lockGate' | 'unlockGate'; readonly gate: string }
  | {
      readonly op: 'assignGate';
      readonly gate: string;
      readonly environment: string;
    }
  | {
      readonly op: 'addRoute' | 'updateRoute';
      readonly route: string;
      readonly definition: RouteDefinition;
    }
  | {
      readonly op: 'removeRoute' | 'enableRoute' | 'disableRoute';
      readonly route: string;
    }
  | {
      readonly op: 'addUpstream' | 'updateUpstream';
      readonly upstream: string;
      readonly upstreamDefinition: UpstreamDefinition;
    }
  | { readonly op: 'removeUpstream'; readonly upstream: string };

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** A route as moat.yaml writes it (RouteInput in libs/core/src/config/edit.ts). */
export interface RouteDefinition {
  readonly method: (typeof METHODS)[number];
  readonly path: string;
  readonly upstream: string;
  readonly upstreamPath: string;
  readonly maxBodySize?: string;
  readonly origins?: readonly string[];
  readonly rateLimit?: {
    readonly requests: number;
    readonly window: string;
    readonly per?: 'ip' | 'route';
  };
  readonly quota?: Quota;
  readonly budget?: Budget;
  /** FR-13: not edited by the route form; absent = left as written. */
  readonly body?: BodyFields | null;
  /** FR-16: API key, Turnstile, honeypot; a `jwt` stays as written. Absent = left as written. */
  readonly client?: {
    readonly apiKey?: { readonly secret: string; readonly header?: string };
    readonly turnstile?: { readonly secret: string; readonly header?: string };
    readonly honeypot?: { readonly field: string };
  };
}

/** An upstream as moat.yaml writes it (UpstreamInput in libs/core/src/config/edit.ts). */
export interface UpstreamDefinition {
  readonly origin: string;
  /** `secret` is the name of a sealed secret, never its value. */
  readonly auth?: NonNullable<CompiledUpstream['auth']>;
  readonly timeout?: string;
}

/**
 * Why an edit failed, each `edit.errors.<code>`: the API's 409/422 codes (ConfigEditRefusal),
 * and `failed` for anything else.
 */
export const EDIT_ERROR_CODES = [
  'config_changed',
  'config_missing',
  'config_invalid',
  'name_invalid',
  'environment_unknown',
  'gate_in_other_environment',
  'route_exists',
  'route_unknown',
  'upstream_unknown',
  'route_conflict',
  'upstream_exists',
  'upstream_in_use',
  'value_invalid',
  'not_writable',
  'failed',
] as const;
export type EditErrorCode = (typeof EDIT_ERROR_CODES)[number];

/** Environment, gate, route, upstream and secret names (as the core's name pattern). */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/** The codes of `ConfigIssue` (libs/core/src/config/yaml.ts), each `config.errors.<code>`. */
export const CONFIG_ISSUE_CODES = [
  'too_large',
  'syntax',
  'multiple_documents',
  'alias',
  'tag',
  'too_deep',
  'schema',
] as const;

/** What the moat.yaml editor can be told besides those: refused by the core's later checks. */
export const CONFIG_TEXT_ISSUE_CODES = [
  ...CONFIG_ISSUE_CODES,
  'rejected',
] as const;

/** `CompiledUpstream.auth.type`, each `routes.auth.<type>`. */
export const AUTH_TYPES = [
  'bearer',
  'header',
  'query',
  'basic',
  'oauth2',
] as const;

/** `GET|PUT /api/projects/:id/config` (ConfigText in apps/api/src/project/application/config-text.ts). */
export interface ConfigText {
  readonly text: string | null;
  readonly hash: string | null;
}

/** Where a refused moat.yaml is wrong; the text of `config.errors.<code>`. */
export interface ConfigTextIssue {
  readonly code: (typeof CONFIG_TEXT_ISSUE_CODES)[number];
  readonly path: readonly (string | number)[];
  readonly line: number | null;
  readonly column: number | null;
}
