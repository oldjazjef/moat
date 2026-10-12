/**
 * `GET /api/project` — a mirror of `ProjectView` (apps/api/src/project/project.types.ts) and
 * `ProjectState` (libs/core/src/storage/project.ts). The web app does not import the core; keep
 * these in step. Never carries a secret or ciphertext.
 */
export type TrustMode = 'signed';

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
}

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
        readonly upstreams: Readonly<Record<string, CompiledUpstream>>;
        readonly routes: Readonly<Record<string, CompiledRoute>>;
      };
      readonly secretNames: readonly string[];
    };

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
    };

export interface ProjectView {
  readonly folder: string | null;
  readonly project: {
    readonly config: ConfigState;
    readonly gates: readonly GateState[];
  } | null;
}

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

/** `CompiledUpstream.auth.type`, each `routes.auth.<type>`. */
export const AUTH_TYPES = ['bearer', 'header', 'query'] as const;
