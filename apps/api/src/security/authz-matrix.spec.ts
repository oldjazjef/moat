import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningApi } from '../bootstrap';
import { AUTHZ_MATRIX, IDENTITIES, type Identity } from './authz-matrix';

const TOKEN = 'a'.repeat(64);
const WRONG = 'b'.repeat(64);

let api: RunningApi;
let folder: string;

/** node:http, not fetch: fetch does not let a caller set the Host header. */
function call(
  method: string,
  path: string,
  identity: Identity,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    host:
      identity === 'foreignHost'
        ? `rebind.example:${api.port}`
        : `127.0.0.1:${api.port}`,
  };
  if (identity !== 'noToken') {
    headers['x-moat-desktop'] = identity === 'wrongToken' ? WRONG : TOKEN;
  }
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: api.port, method, path, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('authorization matrix (local mode)', () => {
  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'moat-authz-'));
    Object.assign(process.env, {
      AUTH_MODE: 'local',
      LOCAL_MODE: 'true',
      NODE_ENV: 'test',
      MOAT_PROJECT_DIR: folder,
    });
    // Loaded only now: ConfigModule validates process.env when app.module is imported.
    const { bootstrap } = await import('../bootstrap');
    api = await bootstrap({ port: 0, accessToken: TOKEN, logger: false });
  });

  afterAll(async () => {
    await api?.app.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it('has an entry for every route the API serves, and none for a route it does not', () => {
    const express = api.app.getHttpAdapter().getInstance() as {
      router: {
        stack: { route?: { path: string; methods: Record<string, boolean> } }[];
      };
    };
    const served = express.router.stack
      .flatMap((layer) =>
        layer.route
          ? Object.keys(layer.route.methods).map(
              (method) => `${method.toUpperCase()} ${layer.route?.path}`,
            )
          : [],
      )
      .sort();
    const listed = AUTHZ_MATRIX.map(
      (entry) => `${entry.method} ${entry.path}`,
    ).sort();
    expect(served).toEqual(listed);
  });

  for (const entry of AUTHZ_MATRIX) {
    for (const identity of IDENTITIES) {
      it(`${entry.method} ${entry.path} as ${identity} → ${entry.expect[identity]}`, async () => {
        const { status } = await call(entry.method, entry.path, identity);
        expect(status).toBe(entry.expect[identity]);
      });
    }
  }

  it('refuses an unknown route before routing, and answers 404 only to the desktop', async () => {
    expect((await call('GET', '/api/nope', 'noToken')).status).toBe(403);
    expect((await call('GET', '/api/nope', 'desktop')).status).toBe(404);
  });

  it('gives every refusal the same body (no hint which check failed)', async () => {
    const bodies = await Promise.all(
      (['noToken', 'wrongToken', 'foreignHost'] as const).map(
        async (identity) => (await call('GET', '/api/project', identity)).body,
      ),
    );
    expect(new Set(bodies).size).toBe(1);
  });

  it('listens on loopback only', () => {
    expect(api.host).toBe('127.0.0.1');
  });
});
