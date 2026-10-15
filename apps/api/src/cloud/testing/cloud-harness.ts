import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoggerService, Type } from '@nestjs/common';
import type { RunningCloud } from '../../bootstrap-cloud';
import { sessionCookieName } from '../auth/domain/session';

/** TEST ONLY values for a Cloud booted in a spec. */
export const TEST_ORIGIN = 'https://app.moat.test';
export const TEST_PASSWORD = 'a perfectly long test password';
export const TEST_ACCOUNT_KEY = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU';

export interface CallOptions {
  /** The session cookie token to send. */
  readonly token?: string;
  /** The value of `x-moat-csrf`. */
  readonly csrf?: string;
  readonly origin?: string;
  readonly body?: unknown;
  /** A raw Cookie header (overrides `token`). */
  readonly cookieHeader?: string;
  readonly headers?: Record<string, string>;
}

export interface Reply {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly setCookies: string[];
  json<T = Record<string, unknown>>(): T;
}

export interface CloudHarness {
  readonly api: RunningCloud;
  readonly folder: string;
  call(method: string, path: string, options?: CallOptions): Promise<Reply>;
  get<T>(token: Type<T> | (abstract new (...args: never[]) => T)): T;
  stop(): Promise<void>;
}

/**
 * Boots the real Cloud app on a free port with a temporary SQLite database. The environment is
 * set before the app module is imported (ConfigModule validates `process.env` on import).
 */
export async function startCloudHarness(
  env: Record<string, string> = {},
  logger: LoggerService | false = false,
): Promise<CloudHarness> {
  const folder = mkdtempSync(join(tmpdir(), 'moat-cloud-'));
  Object.assign(process.env, {
    AUTH_MODE: 'cloud',
    NODE_ENV: 'test',
    MOAT_DATA_DIR: folder,
    MOAT_PUBLIC_ORIGIN: TEST_ORIGIN,
    MOAT_ACCOUNT_KEY: TEST_ACCOUNT_KEY,
    MOAT_PASSWORD_COST: 'fast',
    MOAT_DB_PROVIDER: 'sqlite',
    ...env,
  });
  const { bootstrapCloud } = await import('../../bootstrap-cloud');
  const api = await bootstrapCloud({ port: 0, logger });
  const cookieName = sessionCookieName(
    (process.env['MOAT_COOKIE_SECURE'] ?? 'true') === 'true',
  );
  return {
    api,
    folder,
    get: <T>(token: Type<T> | (abstract new (...args: never[]) => T)) =>
      api.app.get<T>(token as Type<T>),
    call(method, path, options = {}) {
      const headers: Record<string, string> = {
        host: `127.0.0.1:${api.port}`,
        ...options.headers,
      };
      if (options.cookieHeader !== undefined)
        headers['cookie'] = options.cookieHeader;
      else if (options.token !== undefined)
        headers['cookie'] = `${cookieName}=${options.token}`;
      if (options.csrf !== undefined) headers['x-moat-csrf'] = options.csrf;
      if (options.origin !== undefined) headers['origin'] = options.origin;
      const payload =
        options.body === undefined ? undefined : JSON.stringify(options.body);
      if (payload !== undefined) headers['content-type'] = 'application/json';
      return new Promise<Reply>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: api.port, method, path, headers },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (body += chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body,
                headers: res.headers,
                setCookies: res.headers['set-cookie'] ?? [],
                json: <T>() => JSON.parse(body) as T,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(payload);
      });
    },
    async stop() {
      await api.app.close();
      rmSync(folder, { recursive: true, force: true });
    },
  };
}
