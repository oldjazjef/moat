import { join, resolve } from 'node:path';
import {
  boundPort,
  CONTENT_SECURITY_POLICY,
  contentTypeOf,
  DESKTOP_ENV_JS,
  forwardHeaders,
  isAppUrl,
  routeRequest,
} from './web-protocol';

const root = resolve('/srv/web');
const files = new Set([
  join(root, 'main-ABC.js'),
  join(root, 'i18n', 'de-CH.json'),
]);
const exists = (file: string) => files.has(file);

describe('routeRequest (app:// protocol)', () => {
  it('sends /api to the API, untouched', () => {
    expect(routeRequest('/api/projects?x=1', root, exists)).toEqual({
      kind: 'api',
      path: '/api/projects?x=1',
    });
    expect(routeRequest('/apix', root, exists).kind).not.toBe('api');
  });

  it('serves the generated env.js and the index for / and deep links', () => {
    expect(routeRequest('/env.js', root, exists)).toEqual({ kind: 'env' });
    expect(routeRequest('/', root, exists)).toEqual({ kind: 'index' });
    expect(routeRequest('/app/projects/123', root, exists)).toEqual({
      kind: 'index',
    });
  });

  it('serves existing build files and 404s missing assets', () => {
    expect(routeRequest('/main-ABC.js', root, exists)).toEqual({
      kind: 'file',
      file: join(root, 'main-ABC.js'),
    });
    expect(routeRequest('/i18n/de-CH.json', root, exists).kind).toBe('file');
    expect(routeRequest('/missing.js', root, exists).kind).toBe('forbidden');
  });

  it('never leaves the web root', () => {
    for (const path of [
      '/../secret.txt',
      '/%2e%2e/%2e%2e/secret.txt',
      '/..%2f..%2fsecret.txt',
      '/%00',
      '/%E0%A4%A',
    ]) {
      const route = routeRequest(path, root, () => true);
      // `..` above the URL root collapses to the root (like a browser does), or is refused.
      if (route.kind === 'file') {
        expect(route.file.startsWith(root)).toBe(true);
      } else {
        expect(route.kind).toBe('forbidden');
      }
    }
    expect(routeRequest('/%00', root, () => true).kind).toBe('forbidden');
    expect(routeRequest('/%E0%A4%A', root, () => true).kind).toBe('forbidden');
  });
});

describe('protocol helpers', () => {
  it('names content types', () => {
    expect(contentTypeOf('a/index.html')).toContain('text/html');
    expect(contentTypeOf('x.WOFF2')).toBe('font/woff2');
    expect(contentTypeOf('x.unknown')).toBe('application/octet-stream');
  });

  it('forwards headers without hop-by-hop ones and adds the access token', () => {
    const headers = forwardHeaders(
      [
        ['Content-Type', 'application/json'],
        ['Host', 'moat'],
        ['Origin', 'app://moat'],
        ['x-moat-desktop', 'forged'],
      ],
      'x-moat-desktop',
      'real',
    );
    expect(headers).toEqual({
      'content-type': 'application/json',
      'x-moat-desktop': 'real',
    });
  });

  it('reads the bound port', () => {
    expect(
      boundPort({ address: '127.0.0.1', family: 'IPv4', port: 51234 }),
    ).toBe(51234);
    expect(() => boundPort('pipe')).toThrow();
    expect(() => boundPort(null)).toThrow();
  });

  it('keeps the CSP strict and the env in local mode', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:/);
    expect(DESKTOP_ENV_JS).toContain("authMode: 'local'");
  });
});

describe('isAppUrl (DT-08)', () => {
  it('accepts only the app:// origin', () => {
    expect(isAppUrl('app://moat/app/overview')).toBe(true);
    expect(isAppUrl('app://moat')).toBe(true);
    expect(isAppUrl('app://moat.evil/x')).toBe(false);
    expect(isAppUrl('https://moat/app')).toBe(false);
    expect(isAppUrl('http://127.0.0.1:3000/')).toBe(false);
    expect(isAppUrl('not a url')).toBe(false);
    expect(isAppUrl(undefined)).toBe(false);
  });
});
