import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateCompiledConfig } from '../config/compiled';
import { parseStrictJson } from '../json/strict-json';
import { parsePolicy } from '../policy/policy';
import { dryRun, SECRET_PLACEHOLDER, type DryRunContext } from './dry-run';
import { killSwitchOf, type KillSwitch } from './kill-switch';

const HTTP = path.join(__dirname, '../../../../conformance/http');
const PORT = '8443';

/**
 * Errors only a running gate gives: its counters (rate limits, quotas, budgets) or its address
 * check on the resolved IP. The dry run forwards these requests; the gate refuses before sending.
 */
const ONLY_THE_GATE = new Set([
  'rate_limited',
  'quota_exceeded',
  'budget_exhausted',
  'rate_limit_unavailable',
  'upstream_forbidden',
  // FR-16: the key's value, the JWT's signature and the Turnstile answer.
  'client_unauthorized',
]);
/** Headers the dry run answers itself (the rest come from the gate's response writer). */
const OWN_HEADERS = [
  'allow',
  'vary',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-max-age',
  'access-control-expose-headers',
];

interface HttpCase {
  name: string;
  killFile?: { content: string } | { raw: string } | null;
  publish?: { version?: number };
  pullDue?: boolean;
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  };
  expect: {
    status: number;
    error?: string;
    upstreamCalls: number;
    headers?: Record<string, string | null>;
    json?: {
      method?: string;
      path?: string;
      query?: string;
      headers?: Record<string, string | null>;
      body?: string;
    };
  };
}

function load(file: string): { context: DryRunContext; cases: HttpCase[] } {
  const text = readFileSync(path.join(HTTP, file), 'utf8').replaceAll(
    '{port}',
    PORT,
  );
  const doc = JSON.parse(text) as {
    config: unknown;
    policy: { testing?: unknown };
    secrets: Record<string, string>;
    cases: HttpCase[];
  };
  // The testing block (fixed IPs, a CA) only steers the connection, never what is sent.
  const { testing: _testing, ...policy } = doc.policy;
  return {
    context: {
      config: validateCompiledConfig(
        parseStrictJson(new TextEncoder().encode(JSON.stringify(doc.config))),
        Object.keys(doc.secrets),
      ),
      policy: parsePolicy(
        parseStrictJson(new TextEncoder().encode(JSON.stringify(policy))),
      ),
      secrets: Object.keys(doc.secrets),
    },
    cases: doc.cases,
  };
}

const lower = (headers: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );

describe('dryRun predicts the gate (conformance/http/, FR-42)', () => {
  const files = readdirSync(HTTP).filter((file) => file.endsWith('.json'));

  it('covers every case file', () => {
    expect(files.sort()).toEqual([
      'gate-auth.json',
      'gate-client.json',
      'gate-kill-switch.json',
      'gate-locked.json',
      'gate-log.json',
      'gate-pull.json',
      'gate.json',
    ]);
  });

  for (const file of files) {
    describe(file, () => {
      const { context, cases } = load(file);
      let killSwitch: KillSwitch = { gate: false, routes: [] };
      // gate-pull.json changes the bundle between cases: only the cases before the gate first
      // pulls a new version.
      let published = false;
      const changed = cases.findIndex((entry) => {
        published ||= entry.publish?.version !== undefined;
        return published && entry.pullDue === true;
      });
      const fixed = changed === -1 ? cases : cases.slice(0, changed);
      for (const entry of fixed) {
        it(entry.name, () => {
          if (entry.killFile !== undefined)
            killSwitch = killSwitchOf(
              entry.killFile === null
                ? { kind: 'absent' }
                : 'content' in entry.killFile
                  ? { kind: 'present', content: entry.killFile.content }
                  : // Written by hand, without the data-file marker.
                    { kind: 'damaged' },
            );
          const result = dryRun({ ...context, killSwitch }, entry.request);
          const { expect: wanted } = entry;
          if (result.kind === 'not_accepted')
            throw new Error(`bundle not accepted: ${result.code}`);
          if (result.kind === 'refused') {
            expect({ status: result.status, error: result.error }).toEqual({
              status: wanted.status,
              error: wanted.error,
            });
            expect(wanted.upstreamCalls).toBe(0);
          } else if (result.kind === 'preflight') {
            expect(wanted.status).toBe(204);
            expect(wanted.upstreamCalls).toBe(0);
          } else if (
            wanted.upstreamCalls === 0 ||
            wanted.error === 'client_unauthorized'
          ) {
            // Refused by the gate, at most after a Turnstile check.
            expect(ONLY_THE_GATE).toContain(wanted.error);
            expect(wanted.upstreamCalls).toBe(
              result.call.turnstileCall === undefined ? 0 : 1,
            );
          } else {
            // OAuth2 (FR-20): the token request too, unless the gate has a token cached.
            // FR-16: a Turnstile check is one more.
            const calls = result.call.turnstileCall === undefined ? 1 : 2;
            expect(
              result.call.tokenCall === undefined
                ? [calls]
                : [calls, calls + 1],
            ).toContain(wanted.upstreamCalls);
            const sent = wanted.json;
            if (sent?.method !== undefined && sent.path !== undefined) {
              const url = new URL(
                result.call.url.replace(SECRET_PLACEHOLDER, 'SECRET'),
              );
              expect(result.call.method).toBe(sent.method);
              expect(url.pathname).toBe(sent.path);
              if (sent.query !== undefined)
                expect(
                  url.search
                    .replace(/^\?/, '')
                    .replace('SECRET', SECRET_PLACEHOLDER),
                ).toBe(sent.query);
              if (sent.body !== undefined)
                expect(result.call.body).toBe(sent.body);
              const headers = lower(
                Object.fromEntries(
                  result.call.headers.map(([name, value]) => [
                    name,
                    // The fake upstream shows a Basic credential decoded (gate-auth.json).
                    value.startsWith('Basic ')
                      ? `Basic ${atob(value.slice(6))}`
                      : value,
                  ]),
                ),
              );
              for (const [name, value] of Object.entries(sent.headers ?? {}))
                expect(headers[name] ?? null, name).toBe(value);
            }
          }
          if (result.kind !== 'forwarded' || wanted.upstreamCalls >= 1) {
            const answered = lower(result.headers);
            for (const [name, value] of Object.entries(wanted.headers ?? {})) {
              if (!OWN_HEADERS.includes(name)) continue;
              if (value === '<any>') expect(answered).toHaveProperty(name);
              else expect(answered[name] ?? null, name).toBe(value);
            }
          }
        });
      }
    });
  }
});

describe('dryRun', () => {
  const { context } = load('gate.json');

  it('never has a secret: the call shows a placeholder', () => {
    const result = dryRun(context, {
      method: 'POST',
      path: '/newsletter',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"a@example.com"}',
    });
    expect(result.kind).toBe('forwarded');
    if (result.kind !== 'forwarded') return;
    expect(result.call.headers).toContainEqual([
      'Authorization',
      `Bearer ${SECRET_PLACEHOLDER}`,
    ]);
    expect(result.call.secret).toBe('api-token');
    expect(result.counters.map((counter) => counter.kind)).toContain('perIp');
  });

  it('SEC-46: a secret missing from the bundle is refused like the gate does', () => {
    const result = dryRun(
      { ...context, secrets: [] },
      {
        method: 'POST',
        path: '/newsletter',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(result).toMatchObject({
      kind: 'refused',
      error: 'secret_unavailable',
      status: 500,
    });
  });

  it('SEC-11: a config beyond the policy is not accepted at all', () => {
    const result = dryRun(
      {
        ...context,
        policy: { ...context.policy, maxTimeoutMs: 1 },
      },
      { method: 'GET', path: '/status', headers: {}, body: '' },
    );
    expect(result).toEqual({ kind: 'not_accepted', code: 'policy_violation' });
  });
});
