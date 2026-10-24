import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';

/**
 * What the Cloud server entry reads besides `validateEnv` (which owns the Cloud's own variables):
 * where to listen, where the dashboard's files are, and which production guarantees hold. Pure:
 * the entry passes `process.env`; the specs pass objects.
 */
export type EnvironmentMap = Readonly<Record<string, string | undefined>>;

export class ServerSettingsError extends Error {}

export interface ServerSettings {
  readonly host: string;
  readonly port: number;
  /** Absent only in development (`api:serve-cloud`; the Angular dev server serves the pages). */
  readonly webDir: string | undefined;
}

/** Names the variable, never its value (a path or an address could be sensitive, SEC-34). */
function refuse(name: string): never {
  throw new ServerSettingsError(`Invalid server environment: ${name}`);
}

/**
 * `HOST` must be an IP address (a container passes `0.0.0.0`; the default is the loopback
 * address, so a bare `node main.js` is not on the network), `PORT` 1..65535, `MOAT_WEB_DIR` an
 * absolute path (the image sets it to `/app/web`), required unless `MOAT_DEV=true`.
 */
export function serverSettings(env: EnvironmentMap): ServerSettings {
  const host = env['HOST'] ?? '127.0.0.1';
  if (isIP(host) === 0) refuse('HOST');
  const portText = env['PORT'] ?? '3000';
  if (!/^[0-9]{1,5}$/.test(portText)) refuse('PORT');
  const port = Number(portText);
  if (port < 1 || port > 65535) refuse('PORT');
  const given = env['MOAT_WEB_DIR'];
  if (given === undefined || given === '') {
    if (env['MOAT_DEV'] !== 'true') refuse('MOAT_WEB_DIR');
    return { host, port, webDir: undefined };
  }
  if (!isAbsolute(given)) refuse('MOAT_WEB_DIR');
  return { host, port, webDir: given };
}

/**
 * Outside `MOAT_DEV=true` the server runs only as `NODE_ENV=production`. `validateEnv` defaults
 * a missing `NODE_ENV` to development, which allows the development conveniences (a cookie
 * without Secure, the cheap Argon2id) — a forgotten variable must not be enough for that.
 * `MOAT_DEV=true` next to `NODE_ENV=production` is refused by `devEnvironment`.
 */
export function assertRunMode(env: EnvironmentMap): void {
  if (env['MOAT_DEV'] === 'true') return;
  if (env['NODE_ENV'] !== 'production') refuse('NODE_ENV');
}

/** Variables that may come from a file (Docker/Kubernetes secrets) instead of the environment. */
export const SECRET_FILE_VARIABLES = [
  'MOAT_ACCOUNT_KEY',
  'MOAT_DATABASE_URL',
  'MOAT_SIGNING_KEY',
  'MOAT_SMTP_PASSWORD',
  'MOAT_OIDC_PROVIDERS',
] as const;

/**
 * `NAME_FILE=/run/secrets/x` → the file's content as `NAME` (one trailing newline removed). Both
 * `NAME` and `NAME_FILE` set, a relative path or an unreadable file refuse to start — there is no
 * quiet choice between two sources. Errors name the variable only. `read` is injected (fs).
 */
export function resolveSecretFiles(
  env: EnvironmentMap,
  read: (path: string) => string,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of SECRET_FILE_VARIABLES) {
    const file = env[`${name}_FILE`];
    if (file === undefined || file === '') continue;
    if (env[name] !== undefined && env[name] !== '') refuse(name);
    if (!isAbsolute(file)) refuse(`${name}_FILE`);
    let text: string;
    try {
      text = read(file);
    } catch {
      refuse(`${name}_FILE`);
    }
    values[name] = text.replace(/\r?\n$/, '');
  }
  return values;
}
