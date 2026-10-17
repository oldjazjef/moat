/**
 * The conveniences of `api:serve-cloud` (local development only): with `MOAT_DEV=true` the Cloud
 * API fills in what a developer would otherwise have to set up — a temporary data folder (SQLite),
 * a random account key, the dashboard origin on localhost, a cookie without the Secure flag (plain
 * HTTP on localhost) and the cheap Argon2id. Nothing here weakens `validateEnv`; it only sets
 * variables that were not set, and it refuses to run at all in production.
 */

export interface DevEnvironment {
  /** Variables to set (only those not already set). */
  readonly values: Readonly<Record<string, string>>;
}

/** Thrown, never defaulted: the dev switch next to a production environment is a mistake. */
export class DevInProductionError extends Error {
  constructor() {
    super('MOAT_DEV=true is refused when NODE_ENV=production');
  }
}

export function devEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  makeDataDir: () => string,
  makeKey: () => string,
): DevEnvironment {
  if (env['MOAT_DEV'] !== 'true') return { values: {} };
  if (env['NODE_ENV'] === 'production') throw new DevInProductionError();
  const wanted: Record<string, () => string> = {
    AUTH_MODE: () => 'cloud',
    NODE_ENV: () => 'development',
    MOAT_DATA_DIR: makeDataDir,
    MOAT_PUBLIC_ORIGIN: () => 'http://localhost:4200',
    MOAT_ACCOUNT_KEY: makeKey,
    MOAT_SIGNING_KEY: makeKey,
    MOAT_DB_PROVIDER: () => 'sqlite',
    MOAT_COOKIE_SECURE: () => 'false',
    MOAT_PASSWORD_COST: () => 'fast',
  };
  const values: Record<string, string> = {};
  for (const [name, make] of Object.entries(wanted)) {
    if (env[name] === undefined || env[name] === '') values[name] = make();
  }
  return { values };
}
