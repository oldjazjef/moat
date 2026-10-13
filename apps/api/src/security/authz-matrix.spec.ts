import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningApi } from '../bootstrap';
import {
  AUTHZ_MATRIX,
  IDENTITIES,
  type Identity,
  SEEDED_CONFIG,
  SEEDED_PROJECT,
  SEEDED_REMOVABLE,
} from './authz-matrix';

const TOKEN = 'a'.repeat(64);
const WRONG = 'b'.repeat(64);

let api: RunningApi;
let folder: string;

/** node:http, not fetch: fetch does not let a caller set the Host header. */
function call(
  method: string,
  path: string,
  identity: Identity,
  body?: unknown,
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
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) headers['content-type'] = 'application/json';
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
    req.end(payload);
  });
}

describe('authorization matrix (local mode)', () => {
  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'moat-authz-'));
    const data = join(folder, 'data');
    const site = join(folder, 'site');
    mkdirSync(data);
    mkdirSync(site);
    writeFileSync(join(site, 'moat.yaml'), SEEDED_CONFIG);
    writeFileSync(
      join(data, 'projects.json'),
      JSON.stringify({
        version: 1,
        projects: [
          { id: SEEDED_PROJECT, folder: site },
          { id: SEEDED_REMOVABLE, folder: site + '-copy' },
        ],
      }),
    );
    Object.assign(process.env, {
      AUTH_MODE: 'local',
      LOCAL_MODE: 'true',
      NODE_ENV: 'test',
      MOAT_DATA_DIR: data,
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
        const { status } = await call(
          entry.method,
          entry.request ?? entry.path,
          identity,
          entry.body,
        );
        expect(status).toBe(entry.expect[identity]);
      });
    }
  }

  it('refuses an unknown route before routing, and answers 404 only to the desktop', async () => {
    expect((await call('GET', '/api/nope', 'noToken')).status).toBe(403);
    expect((await call('GET', '/api/nope', 'desktop')).status).toBe(404);
  });

  it('answers an unknown or malformed project id with 404, and has no route to add one (DT-08)', async () => {
    for (const id of ['x'.repeat(22), '..%2F..%2Fetc', 'a']) {
      expect((await call('GET', `/api/projects/${id}`, 'desktop')).status).toBe(
        404,
      );
    }
    expect((await call('POST', '/api/projects', 'desktop')).status).toBe(404);
  });

  it('writes moat.yaml only through a complete, well-formed edit based on the current file', async () => {
    const url = `/api/projects/${SEEDED_PROJECT}/config/edits`;
    const current = JSON.parse(
      (await call('GET', `/api/projects/${SEEDED_PROJECT}`, 'desktop')).body,
    ) as { configHash: string };
    const base = current.configHash;
    for (const body of [
      undefined,
      { base, op: 'addEnvironment' },
      { base, op: 'addEnvironment', environment: 'Prod' },
      { base, op: 'addEnvironment', environment: 'x', gate: 'site' },
      { base, op: 'writeFile', environment: 'x' },
      { base, op: 'addEnvironment', environment: 'x', path: '../evil' },
      { base: 'nope', op: 'addEnvironment', environment: 'x' },
    ]) {
      expect((await call('POST', url, 'desktop', body)).status).toBe(400);
    }
    const stale = { base: '0'.repeat(64), op: 'lockGate', gate: 'site' };
    const conflict = await call('POST', url, 'desktop', stale);
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body)).toMatchObject({
      error: 'config_changed',
    });
    const unknown = { base, op: 'lockEnvironment', environment: 'nowhere' };
    const refused = await call('POST', url, 'desktop', unknown);
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body)).toMatchObject({
      error: 'environment_unknown',
    });
    const route = {
      method: 'POST',
      path: '/contact',
      upstream: 'hubspot',
      upstreamPath: '/contacts',
    };
    for (const body of [
      { base, op: 'addRoute', route: 'contact' },
      {
        base,
        op: 'addRoute',
        route: 'contact',
        definition: { ...route, eval: '1' },
      },
      {
        base,
        op: 'addRoute',
        route: 'contact',
        definition: {
          ...route,
          rateLimit: { requests: 1, window: '1m', code: 'x' },
        },
      },
      { base, op: 'removeRoute', route: 'contact', definition: route },
      {
        base,
        op: 'addRoute',
        route: 'contact',
        definition: { ...route, method: 'TRACE' },
      },
      // SEC-20: where usage is read is a closed list, never a path the client sends.
      {
        base,
        op: 'addRoute',
        route: 'contact',
        definition: {
          ...route,
          budget: {
            usage: 'openai',
            period: 'day',
            reserve: 1,
            tokens: 1,
            path: '$.x',
          },
        },
      },
      {
        base,
        op: 'addRoute',
        route: 'contact',
        definition: {
          ...route,
          budget: { usage: 'custom', period: 'day', reserve: 1, tokens: 1 },
        },
      },
    ]) {
      expect((await call('POST', url, 'desktop', body)).status).toBe(400);
    }
    const traversal = {
      base,
      op: 'addRoute',
      route: 'contact',
      definition: { ...route, upstreamPath: '/a/../../admin' },
    };
    const invalid = await call('POST', url, 'desktop', traversal);
    expect(invalid.status).toBe(422);
    expect(JSON.parse(invalid.body)).toEqual({
      error: 'value_invalid',
      fields: ['upstreamPath'],
    });
    // SEC-31: an upstream carries a secret's name only; a field for its value is refused.
    const upstream = {
      origin: 'https://api.example.ch',
      auth: { type: 'bearer', secret: 'example-token' },
    };
    for (const body of [
      { base, op: 'addUpstream', upstream: 'example' },
      {
        base,
        op: 'addUpstream',
        upstream: 'example',
        upstreamDefinition: {
          ...upstream,
          auth: { ...upstream.auth, value: 'sk-live-1' },
        },
      },
      {
        base,
        op: 'addUpstream',
        upstream: 'example',
        upstreamDefinition: {
          ...upstream,
          auth: { ...upstream.auth, name: 'X-Key' },
        },
      },
      {
        base,
        op: 'addUpstream',
        upstream: 'example',
        upstreamDefinition: {
          ...upstream,
          auth: { type: 'header', secret: 'a' },
        },
      },
      {
        base,
        op: 'addUpstream',
        upstream: 'example',
        upstreamDefinition: {
          ...upstream,
          auth: { type: 'basic', secret: 'a' },
        },
      },
      {
        base,
        op: 'removeUpstream',
        upstream: 'hubspot',
        upstreamDefinition: upstream,
      },
      {
        base,
        op: 'addUpstream',
        route: 'contact',
        upstreamDefinition: upstream,
      },
    ]) {
      expect((await call('POST', url, 'desktop', body)).status).toBe(400);
    }
    // SEC-41: HTTPS only.
    const plain = await call('POST', url, 'desktop', {
      base,
      op: 'addUpstream',
      upstream: 'example',
      upstreamDefinition: { origin: 'http://api.example.ch' },
    });
    expect(plain.status).toBe(422);
    expect(JSON.parse(plain.body)).toEqual({
      error: 'value_invalid',
      fields: ['origin'],
    });
    const inUse = await call('POST', url, 'desktop', {
      base,
      op: 'removeUpstream',
      upstream: 'hubspot',
    });
    expect(inUse.status).toBe(422);
    expect(JSON.parse(inUse.body)).toMatchObject({ error: 'upstream_in_use' });
    const other = `/api/projects/${'x'.repeat(22)}/config/edits`;
    const edit = { base, op: 'lockGate', gate: 'site' };
    expect((await call('POST', other, 'desktop', edit)).status).toBe(404);
  });

  it('gives every refusal the same body (no hint which check failed)', async () => {
    const bodies = await Promise.all(
      (['noToken', 'wrongToken', 'foreignHost'] as const).map(
        async (identity) => (await call('GET', '/api/projects', identity)).body,
      ),
    );
    expect(new Set(bodies).size).toBe(1);
  });

  it('listens on loopback only', () => {
    expect(api.host).toBe('127.0.0.1');
  });
});
