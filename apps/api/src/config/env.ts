import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  validateSync,
  ValidateIf,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * How a request is authenticated. `local`: Moat Desktop runs this API in its own process, for one
 * person, with no sign-in (DT-01). `cloud`: Moat Cloud's own accounts, sessions and organisations
 * (CLAUDE.md, Auth; src/cloud/). Any other value refuses to boot.
 */
export const AUTH_MODES = ['local', 'cloud'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** The loopback address the API binds to in `AUTH_MODE=local`. */
export const LOCAL_HOST = '127.0.0.1';

/**
 * Every environment variable the API reads, in one place (as lazy-koins). Validation runs once at
 * boot and throws — the process must not start half-configured. Read it through
 * `ConfigService<Env, true>` with `{ infer: true }`, never `process.env`.
 */
export class Env {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsIn(AUTH_MODES)
  AUTH_MODE!: AuthMode;

  /**
   * Must be `true` with `AUTH_MODE=local`: says out loud that this API trusts its one caller.
   * With `AUTH_MODE=cloud` it must not be `true` (a half-local Cloud would trust everybody).
   */
  @ValidateIf((env: Env) => env.AUTH_MODE === 'local')
  @IsIn(['true'])
  LOCAL_MODE!: 'true';

  /**
   * Where the API keeps its own data, an absolute path: the list of projects
   * (`projects.json`). The desktop passes its user-data folder. The projects themselves stay in
   * their own folders (DT-03, DT-14).
   */
  @IsString()
  // POSIX `/…` or Windows `C:\…`: a relative path would depend on the working directory.
  @Matches(/^(\/|[A-Za-z]:[\\/])/)
  MOAT_DATA_DIR!: string;

  /**
   * `true` lets «Testen» (FR-73) reach a gate on this computer over plain HTTP (`php -S`). Moat
   * Desktop sets it only when it runs unpackaged (development); never in a shipped build (T-59).
   */
  @IsIn(['true', 'false'])
  MOAT_GATE_TEST_LOOPBACK: 'true' | 'false' = 'false';

  // ── AUTH_MODE=cloud only ──────────────────────────────────────────────────────────────────

  /**
   * The one origin the dashboard is served from, no path: `https://app.example.ch`, or
   * `http://localhost:4200` for development. Unsafe requests from any other `Origin` are
   * refused (CSRF, T-78).
   */
  @ValidateIf((env: Env) => env.AUTH_MODE === 'cloud')
  @Matches(
    /^(https:\/\/[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?|http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?)$/,
  )
  MOAT_PUBLIC_ORIGIN!: string;

  /**
   * 32 random bytes, base64url without padding. Seals the TOTP secrets in the database (they must
   * be readable by the server to verify a code, unlike a customer's gate secrets, SEC-31). Keep it
   * outside the database and its backups.
   */
  @ValidateIf((env: Env) => env.AUTH_MODE === 'cloud')
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  MOAT_ACCOUNT_KEY!: string;

  /** The Cloud's database: SQLite (`<MOAT_DATA_DIR>/cloud.db`) or PostgreSQL (clustered). */
  @ValidateIf((env: Env) => env.AUTH_MODE === 'cloud')
  @IsIn(['sqlite', 'postgresql'])
  MOAT_DB_PROVIDER: 'sqlite' | 'postgresql' = 'sqlite';

  /** `postgresql://…` (TLS required but for this machine, see database-url.ts). */
  @ValidateIf(
    (env: Env) =>
      env.AUTH_MODE === 'cloud' && env.MOAT_DB_PROVIDER === 'postgresql',
  )
  @IsString()
  @Matches(/^postgres(ql)?:\/\/[^\s]{1,2040}$/)
  MOAT_DATABASE_URL?: string;

  /** `false` drops the cookie's Secure flag, for http://localhost development only. */
  @ValidateIf((env: Env) => env.AUTH_MODE === 'cloud')
  @IsIn(['true', 'false'])
  MOAT_COOKIE_SECURE: 'true' | 'false' = 'true';

  /** `fast` is for tests only (a cheap Argon2id); refused in production. */
  @ValidateIf((env: Env) => env.AUTH_MODE === 'cloud')
  @IsIn(['standard', 'fast'])
  MOAT_PASSWORD_COST: 'standard' | 'fast' = 'standard';

  /**
   * 32 random bytes (an Ed25519 seed), base64url without padding: the key Moat Cloud signs the
   * bundles of **managed** gates with (trust mode 0, ANFORDERUNGEN.md §2.1). Optional: without it
   * the installation has no managed gates and still stores and serves what customers sign
   * themselves. A gate pins the matching public key at enrolment; a replaced key needs a local
   * confirmation at every gate (SEC-06).
   */
  @ValidateIf((env: Env) => env.AUTH_MODE === 'cloud')
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  MOAT_SIGNING_KEY?: string;

  /** How many reverse proxies sit in front (X-Forwarded-For hops); 0 = none, the socket address. */
  @ValidateIf((env: Env) => env.AUTH_MODE === 'cloud')
  @IsOptional()
  @Matches(/^[0-8]$/)
  MOAT_TRUST_PROXY = '0';
}

/** Throws on the first misconfiguration; never echoes values (one of them could be a path). */
export function validateEnv(config: Record<string, unknown>): Env {
  const env = plainToInstance(Env, config, {
    exposeDefaultValues: true,
    excludeExtraneousValues: false,
  });
  const errors = validateSync(env, { skipMissingProperties: false });
  const names = errors.map((error) => error.property);
  if (env.AUTH_MODE === 'cloud') {
    if (config['LOCAL_MODE'] === 'true') names.push('LOCAL_MODE');
    if (env.NODE_ENV === NodeEnv.Production) {
      // Development conveniences must not reach production.
      if (env.MOAT_COOKIE_SECURE !== 'true') names.push('MOAT_COOKIE_SECURE');
      if (env.MOAT_PASSWORD_COST !== 'standard')
        names.push('MOAT_PASSWORD_COST');
    }
  }
  if (names.length > 0)
    throw new Error(`Invalid API environment: ${names.join(', ')}`);
  return env;
}
