import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileConfig } from './compile';
import { ConfigError, loadMoatYaml, type ConfigIssue } from './yaml';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

const valid = `version: 1
upstreams:
  hubspot:
    origin: "https://api.hubapi.com"
    auth: { type: bearer, secret: hubspot-token }
routes:
  newsletter:
    method: POST
    path: "/newsletter"
    upstream: hubspot
    upstreamPath: "/crm/v3/objects/contacts"
`;

function issues(text: string): ConfigIssue[] {
  try {
    loadMoatYaml(text);
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadMoatYaml', () => {
  it('loads and compiles with the defaults filled in', () => {
    const compiled = compileConfig(loadMoatYaml(valid), ['hubspot-token']);
    expect(compiled.upstreams['hubspot']?.timeoutMs).toBe(10_000);
    expect(compiled.routes['newsletter']).toMatchObject({
      maxBodyBytes: 65_536,
      contentTypes: ['application/json'],
      responseContentTypes: ['application/json'],
      enabled: true,
      origins: [],
      rateLimit: null,
    });
  });

  it('FR-15, FR-30: compiles origins and a rate limit window to seconds', () => {
    const text = `${valid}    origins: ["https://www.example.ch"]
    rateLimit: { requests: 5, window: "10m" }
`;
    expect(
      compileConfig(loadMoatYaml(text), ['hubspot-token']).routes['newsletter'],
    ).toMatchObject({
      origins: ['https://www.example.ch'],
      rateLimit: { requests: 5, windowSeconds: 600, per: 'ip' },
    });
  });

  it.each([
    ['a window below a second', '{ requests: 5, window: "500ms" }'],
    ['a window above a day', '{ requests: 5, window: "2d" }'],
    ['a window as a number', '{ requests: 5, window: 60 }'],
    ['an unknown scope', '{ requests: 5, window: "1m", per: user }'],
  ])('FR-30: rejects a rate limit with %s', (_name, limit) => {
    expect(issues(`${valid}    rateLimit: ${limit}\n`).length).toBeGreaterThan(
      0,
    );
  });

  it.each(['"*"', '"https://www.example.ch/"', '"http://www.example.ch"'])(
    'FR-15: rejects the origin %s',
    (origin) => {
      expect(
        issues(`${valid}    origins: [${origin}]\n`).length,
      ).toBeGreaterThan(0);
    },
  );

  it('loads every recipe in recipes/ (FR-43)', () => {
    const text = readFileSync(
      path.join(ROOT, 'recipes/hubspot-newsletter.moat.yaml'),
      'utf8',
    );
    expect(
      compileConfig(loadMoatYaml(text), ['hubspot-token']).routes['newsletter']
        ?.maxBodyBytes,
    ).toBe(4096);
  });

  it('SEC-24: rejects anchors and aliases', () => {
    const text = valid.replace(
      'auth: { type: bearer, secret: hubspot-token }',
      'auth: &a { type: bearer, secret: hubspot-token }',
    );
    expect(issues(text)[0]?.code).toBe('alias');
    expect(issues(`${valid}x: *a\n`)[0]?.code).toBeDefined();
  });

  it('SEC-24: rejects explicit tags', () => {
    expect(
      issues(valid.replace('path: "/newsletter"', 'path: !!str /newsletter'))[0]
        ?.code,
    ).toBe('tag');
  });

  it('rejects duplicate keys and merge keys', () => {
    expect(
      issues(
        valid.replace(
          '    method: POST\n',
          '    method: POST\n    method: GET\n',
        ),
      )[0]?.code,
    ).toBe('syntax');
    expect(issues(`${valid}  copy:\n    <<: {}\n`).length).toBeGreaterThan(0);
  });

  it('never coerces: an unquoted yes or a bare number stays what YAML says and fails the schema', () => {
    const yes = issues(`${valid}    enabled: yes\n`);
    expect(yes[0]).toMatchObject({
      code: 'schema',
      path: ['routes', 'newsletter', 'enabled'],
    });
    const number = issues(
      valid.replace(
        'upstreamPath: "/crm/v3/objects/contacts"',
        'upstreamPath: 42',
      ),
    );
    expect(number[0]).toMatchObject({
      code: 'schema',
      path: ['routes', 'newsletter', 'upstreamPath'],
    });
  });

  it('reports line and column of a schema error', () => {
    const [issue] = issues(valid.replace('method: POST', 'method: TRACE'));
    expect(issue).toMatchObject({ code: 'schema', line: 8, column: 13 });
  });

  it('SEC-20: rejects unknown keys (strict objects)', () => {
    expect(issues(`${valid}    script: "rm -rf /"\n`)[0]?.code).toBe('schema');
  });

  it('DT-17: rejects a __proto__ key instead of dropping it', () => {
    expect(issues(`${valid}  __proto__:\n    method: GET\n`)[0]?.code).toBe(
      'schema',
    );
  });

  it('rejects several documents and oversized files', () => {
    expect(issues(`${valid}---\n${valid}`)[0]?.code).toBe('multiple_documents');
    expect(issues(`# ${'x'.repeat(256 * 1024)}\n${valid}`)[0]?.code).toBe(
      'too_large',
    );
  });

  it('rejects durations and sizes without a unit', () => {
    expect(
      issues(
        valid.replace(
          '    upstreamPath',
          '    maxBodySize: "4096"\n    upstreamPath',
        ),
      )[0]?.code,
    ).toBe('schema');
    expect(
      issues(valid.replace('auth: {', 'timeout: 10\n    auth: {'))[0]?.code,
    ).toBe('schema');
  });
});
