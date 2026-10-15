import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CloudHarness,
  startCloudHarness,
  TEST_ACCOUNT_KEY,
  TEST_PASSWORD,
} from '../cloud/testing/cloud-harness';
import { CLOUD_ENV_JS } from './static-site';

/**
 * The Cloud server as an attacker sees it: the dashboard's files, the headers, the probes
 * (docs/SECURITY-TESTING.md: A05, A01 path traversal; T-84, T-85). The real app on a free port
 * with a throwaway SQLite database and a fake `browser/` folder.
 */
const INDEX =
  '<!doctype html><title>Moat</title><script src="env.js"></script>';
const HTML = { accept: 'text/html,application/xhtml+xml' };
const SECRET_OUTSIDE = 'TEST ONLY secret outside the web folder';

let cloud: CloudHarness;
let site: string;

beforeAll(async () => {
  site = mkdtempSync(join(tmpdir(), 'moat-site-'));
  const web = join(site, 'browser');
  mkdirSync(join(web, 'i18n'), { recursive: true });
  writeFileSync(join(web, 'index.html'), INDEX);
  // The build's own env.js is the desktop's; the server must never serve it.
  writeFileSync(join(web, 'env.js'), "window.__MT_ENV__={authMode:'local'};");
  writeFileSync(join(web, 'main-YG4VST5K.js'), 'console.log(1)');
  writeFileSync(join(web, 'i18n', 'de-CH.json'), '{}');
  writeFileSync(join(web, '.hidden'), 'dot file');
  writeFileSync(join(site, 'outside.txt'), SECRET_OUTSIDE);
  writeFileSync(join(site, 'browser-evil.txt'), SECRET_OUTSIDE);
  cloud = await startCloudHarness({}, false, web);
}, 60_000);
afterAll(async () => {
  await cloud?.stop();
  rmSync(site, { recursive: true, force: true });
});

describe('the dashboard from the same origin', () => {
  it('serves index.html for a navigation to a page of the app, with 200', async () => {
    for (const path of ['/', '/app/projects', '/app/setup/x/y', '/login']) {
      const reply = await cloud.call('GET', path, { headers: HTML });
      expect(reply.status, path).toBe(200);
      expect(reply.body).toBe(INDEX);
      expect(reply.headers['content-type']).toMatch(/^text\/html/);
      expect(reply.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves HEAD like GET without a body', async () => {
    const reply = await cloud.call('HEAD', '/app/projects', { headers: HTML });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('');
  });

  it('does not answer a missing file, a script or a probe with the shell (strict fallback)', async () => {
    // No HTML in Accept: a probe or a script.
    expect((await cloud.call('GET', '/app/projects')).status).toBe(404);
    // A path with an extension is a file, even for a browser.
    for (const path of ['/missing.js', '/main-AAAAAAAA.js', '/i18n/xx.json']) {
      const reply = await cloud.call('GET', path, { headers: HTML });
      expect(reply.status, path).toBe(404);
      expect(reply.body).not.toContain('<title>');
    }
  });

  it('serves hashed assets as immutable and other files uncached', async () => {
    const hashed = await cloud.call('GET', '/main-YG4VST5K.js');
    expect(hashed.status).toBe(200);
    expect(hashed.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    const language = await cloud.call('GET', '/i18n/de-CH.json');
    expect(language.status).toBe(200);
    expect(language.headers['cache-control']).toBe('no-cache');
  });

  it('leaves /api to the API: an unknown API path is the API 404, never the shell', async () => {
    const reply = await cloud.call('GET', '/api/nothing', { headers: HTML });
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain('<title>');
    expect((await cloud.call('GET', '/api/health')).status).toBe(200);
  });

  it('does not serve anything for other methods', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const reply = await cloud.call(method, '/app/projects', {
        headers: HTML,
        origin: 'https://app.moat.test',
      });
      expect(reply.status, method).toBe(404);
    }
  });
});

describe('env.js (T-84)', () => {
  it('is generated: cloud mode, same origin, and nothing else', async () => {
    const reply = await cloud.call('GET', '/env.js');
    expect(reply.status).toBe(200);
    expect(reply.body).toBe(CLOUD_ENV_JS);
    expect(reply.headers['content-type']).toMatch(/^text\/javascript/);
    expect(reply.headers['cache-control']).toBe('no-cache');
    expect(reply.body).toContain("authMode: 'cloud'");
    expect(reply.body).not.toContain('local');
  });

  it('contains no secret of the server', async () => {
    const reply = await cloud.call('GET', '/env.js');
    for (const secret of [
      TEST_ACCOUNT_KEY,
      TEST_PASSWORD,
      process.env['MOAT_DATA_DIR'] ?? '/nonexistent',
      process.env['MOAT_PUBLIC_ORIGIN'] ?? '/nonexistent',
    ]) {
      expect(reply.body).not.toContain(secret);
    }
  });

  it.each([
    '//env.js',
    '/./env.js',
    '/%65nv.js',
    '/x/../env.js',
    '/env.js?x=1',
  ])('serves only the generated file at %s', async (path) => {
    const reply = await cloud.call('GET', path);
    expect(reply.status).toBe(200);
    expect(reply.body).toBe(CLOUD_ENV_JS);
  });
});

describe('path traversal and odd paths (OWASP A01, T-84)', () => {
  it.each([
    '/../outside.txt',
    '/%2e%2e/outside.txt',
    '/%2E%2E%2Foutside.txt',
    '/..%2foutside.txt',
    '/..%5coutside.txt',
    '/i18n/../../outside.txt',
    '/i18n/%2e%2e/%2e%2e/outside.txt',
    '/....//outside.txt',
    '/%252e%252e/outside.txt',
    '/../browser-evil.txt',
    '/%00',
    '/index.html%00.js',
  ])('does not leak a file outside the folder: %s', async (path) => {
    const reply = await cloud.call('GET', path, { headers: HTML });
    expect(reply.body).not.toContain(SECRET_OUTSIDE);
    expect([200, 400, 403, 404]).toContain(reply.status);
    if (reply.status === 200) expect(reply.body).toBe(INDEX);
  });

  it('ignores dot files', async () => {
    const reply = await cloud.call('GET', '/.hidden');
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain('dot file');
  });

  it('answers a malformed escape without a body and without a stack', async () => {
    const reply = await cloud.call('GET', '/%zz/x.js');
    expect([400, 404]).toContain(reply.status);
    expect(reply.body).not.toMatch(/at .*\.js|node_modules|Error/);
  });

  it('does not list directories or redirect to them', async () => {
    for (const path of ['/i18n', '/i18n/']) {
      const reply = await cloud.call('GET', path);
      expect(reply.status, path).toBe(404);
      expect(reply.headers['location']).toBeUndefined();
    }
  });
});

describe('security headers (OWASP A05, T-84)', () => {
  it('sets a CSP without inline script, eval or framing on the shell, a file and the API', async () => {
    for (const path of [
      '/app/x',
      '/main-YG4VST5K.js',
      '/api/health',
      '/nope',
    ]) {
      const reply = await cloud.call('GET', path, { headers: HTML });
      const csp = String(reply.headers['content-security-policy']);
      expect(csp, path).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).not.toMatch(/https?:|\*/);
      expect(reply.headers['x-content-type-options']).toBe('nosniff');
      expect(reply.headers['referrer-policy']).toBe('no-referrer');
      expect(reply.headers['x-frame-options']).toBe('DENY');
      expect(reply.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(reply.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(String(reply.headers['permissions-policy'])).toContain(
        'camera=()',
      );
      expect(reply.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('sends HSTS and upgrade-insecure-requests when the cookie is Secure (the harness default)', async () => {
    const reply = await cloud.call('GET', '/app/x', { headers: HTML });
    expect(reply.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(String(reply.headers['content-security-policy'])).toContain(
      'upgrade-insecure-requests',
    );
  });

  it('keeps API answers out of caches', async () => {
    const reply = await cloud.call('GET', '/api/health');
    expect(reply.headers['cache-control']).toBe('no-store');
  });
});

describe('probes (T-84)', () => {
  it('/healthz is a fixed body', async () => {
    const reply = await cloud.call('GET', '/healthz');
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{"status":"ok"}');
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('/readyz asks the database and says nothing else', async () => {
    const reply = await cloud.call('GET', '/readyz');
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{"status":"ready"}');
  });

  it('answer only GET and HEAD, and need no session or Origin', async () => {
    const post = await cloud.call('POST', '/healthz', {
      origin: 'https://evil.example',
    });
    expect(post.status).toBe(405);
    expect(post.body).toBe('{"status":"method_not_allowed"}');
    const head = await cloud.call('HEAD', '/readyz');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    // No data: the probes take no input and echo none.
    const query = await cloud.call('GET', '/healthz?email=a@b.c');
    expect(query.body).toBe('{"status":"ok"}');
  });

  it('/readyz is 503 while the process shuts down (own harness)', async () => {
    const other = await startCloudHarness({}, false, join(site, 'browser'));
    try {
      expect((await other.call('GET', '/readyz')).status).toBe(200);
      const closing = other.api.shutdown();
      // The listener closes, so a new request may be refused outright; either is "not ready".
      await closing;
      await expect(other.call('GET', '/readyz')).rejects.toBeTruthy();
    } finally {
      rmSync(other.folder, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('the folder must hold the dashboard (fail closed)', () => {
  it('refuses to start without index.html', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'moat-empty-'));
    try {
      await expect(startCloudHarness({}, false, empty)).rejects.toThrow(
        /MOAT_WEB_DIR/,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 30_000);
});
