import { isIP } from 'node:net';
import type { ClientConfig } from 'pg';

/**
 * A PostgreSQL connection string as Moat accepts it for an external database (DT-03):
 *
 *   postgresql://user:password@host:5432/database?sslmode=verify-full
 *
 * TLS with a verified certificate and host name is required for every host but this machine
 * (`localhost`, 127.0.0.0/8, ::1), whatever `sslmode` says; `sslmode=disable` towards another
 * host is refused, not downgraded. No other option is accepted: libpq options like `sslrootcert`
 * or `host=/path` would let a typed string read local files or reach a socket.
 */
export type DatabaseUrl =
  | {
      readonly status: 'ok';
      readonly config: ClientConfig;
      readonly label: string;
    }
  | {
      readonly status: 'refused';
      readonly code: 'url_invalid' | 'tls_required';
    };

const SSL_MODES = new Set([
  'disable',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
]);
const HOST = /^[A-Za-z0-9.-]{1,253}$/;
const NAME = /^[^\0]{1,128}$/;
export const MAX_URL_LENGTH = 2048;

export function parseDatabaseUrl(text: string): DatabaseUrl {
  const invalid = { status: 'refused', code: 'url_invalid' } as const;
  if (text.length > MAX_URL_LENGTH || /[\s\0]/.test(text)) return invalid;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return invalid;
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:')
    return invalid;
  const bracketed = /^\[(.+)\]$/.exec(url.hostname)?.[1];
  const host = bracketed ?? url.hostname;
  if (host === '' || (!HOST.test(host) && isIP(host) !== 6)) return invalid;
  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return invalid;
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(url.username);
  if (!NAME.test(database) || database.includes('/') || !NAME.test(user))
    return invalid;
  let sslmode: string | null = null;
  for (const [key, value] of url.searchParams) {
    if (key !== 'sslmode' || sslmode !== null || !SSL_MODES.has(value))
      return invalid;
    sslmode = value;
  }
  if (url.hash !== '') return invalid;
  const local = isLocal(host);
  if (!local && sslmode === 'disable')
    return { status: 'refused', code: 'tls_required' };
  const tls = !local || (sslmode !== null && sslmode !== 'disable');
  return {
    status: 'ok',
    config: {
      host,
      port,
      database,
      user,
      password: decodeURIComponent(url.password),
      // Verified always: rejectUnauthorized + the host name (pg checks it via servername).
      ssl: tls
        ? {
            rejectUnauthorized: true,
            servername: isIP(host) === 0 ? host : undefined,
          }
        : false,
      connectionTimeoutMillis: 10_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
      application_name: 'moat-desktop',
    },
    // What the window may show: never the password.
    label: `postgresql://${user}@${bracketed === undefined ? host : `[${host}]`}:${port}/${database}`,
  };
}

export function isLocal(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    (isIP(host) === 4 && host.startsWith('127.'))
  );
}
