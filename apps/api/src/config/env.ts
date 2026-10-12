import { plainToInstance } from 'class-transformer';
import { IsEnum, IsIn, IsString, Matches, validateSync } from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * How a request is authenticated. Only `local` exists so far: Moat Desktop runs this API in its
 * own process, for one person, with no sign-in (DT-01). The Cloud's own accounts (passkeys, TOTP,
 * OIDC — CLAUDE.md, Auth) join as further modes; until then any other value refuses to boot.
 */
export const AUTH_MODES = ['local'] as const;
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

  /** Must be `true` with `AUTH_MODE=local`: says out loud that this API trusts its one caller. */
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
}

/** Throws on the first misconfiguration; never echoes values (one of them could be a path). */
export function validateEnv(config: Record<string, unknown>): Env {
  const env = plainToInstance(Env, config, {
    exposeDefaultValues: true,
    excludeExtraneousValues: false,
  });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const names = errors.map((error) => error.property).join(', ');
    throw new Error(`Invalid API environment: ${names}`);
  }
  return env;
}
