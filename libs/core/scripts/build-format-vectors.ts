/**
 * Format vectors next to the crypto ones: request paths (SEC-42), content types (FR-18), the
 * compiled config (step 9 of docs/CRYPTO.md §4.3, SEC-20) and the local policy (SEC-10, SEC-11,
 * SEC-14), plus key files (docs/CRYPTO.md §6). Pure, like build-vectors.ts.
 */
import { createKeyFile, openKeyFile } from '../src/crypto/keyfile';
import { sodium } from '../src/crypto/sodium';
import { MoatRejection } from '../src/errors';
import { validateCompiledConfig } from '../src/config/compiled';
import { normalisePath } from '../src/http/path';
import { checkPolicy, parsePolicy } from '../src/policy/policy';
import { isAllowedContentType } from '../src/http/content-type';
import { checkOrigin, preflight } from '../src/http/cors';
import {
  clientKey,
  hitLimits,
  type Limit,
  type Window,
} from '../src/http/rate-limit';
import { toBase64Url } from '../src/encoding/base64url';
import { utf8 } from '../src/encoding/utf8';
import type { JsonValue } from '../src/json/strict-json';

type Json = JsonValue;

/** Runs the core on a case input so every expectation in the files is what the core does. */
function outcome(run: () => unknown): Json {
  try {
    const value = run();
    return value === undefined
      ? { ok: true }
      : { ok: true, ...(value as Record<string, Json>) };
  } catch (error) {
    if (error instanceof MoatRejection) return { ok: false, error: error.code };
    throw error;
  }
}

function pathVectors(): Json {
  const inputs: [string, string][] = [
    ['root', '/'],
    ['plain', '/newsletter'],
    ['two segments', '/api/contact'],
    [
      'trailing slash is kept (and matches no route without it)',
      '/newsletter/',
    ],
    ['unreserved escape is decoded', '/%41bc'],
    ['lower-case hex escape', '/%7euser'],
    ['all unreserved characters', '/a-b_c.d~e'],
    ['sub-delims and colon/at', "/a:b@c;d=e!f$g&h'i(j)k*l+m,n"],
    ['empty', ''],
    ['relative', 'newsletter'],
    ['double slash', '//'],
    ['empty segment', '/a//b'],
    ['dot segment', '/./a'],
    ['dot-dot at the end', '/a/..'],
    ['dot-dot in the middle', '/a/../b'],
    ['encoded dot-dot', '/%2e%2e/a'],
    ['encoded slash', '/a%2Fb'],
    ['encoded slash, lower case', '/a%2fb'],
    ['encoded backslash', '/a%5Cb'],
    ['backslash', '/a\\b'],
    ['encoded null byte', '/a%00'],
    ['null byte', '/a\u0000'],
    ['encoded percent (double encoding)', '/a%252e'],
    ['space', '/a b'],
    ['encoded space', '/a%20b'],
    ['non-ascii', '/ä'],
    ['encoded utf-8', '/%C3%A4'],
    ['query character', '/a?b'],
    ['fragment character', '/a#b'],
    ['broken escape', '/a%zz'],
    ['truncated escape', '/a%4'],
    ['CRLF', '/a\r\nX-Injected: 1'],
    ['2048 bytes', `/${'a'.repeat(2047)}`],
    ['2049 bytes', `/${'a'.repeat(2048)}`],
  ];
  return {
    description:
      'SEC-42: the raw request path (as sent, before any decoding, without the query) → the normalised path routes are matched against exactly, or `path_invalid`. Only escapes of unreserved characters are decoded; no empty, "." or ".." segments.',
    cases: inputs.map(([name, input]) => ({
      name,
      input,
      expect: outcome(() => ({ path: normalisePath(input) })),
    })),
  };
}

function contentTypeVectors(): Json {
  const json = ['application/json'];
  const inputs: [string, string, string[]][] = [
    ['exact', 'application/json', json],
    ['parameters are ignored', 'application/json; charset=utf-8', json],
    ['no space before parameter', 'application/json;charset=utf-8', json],
    ['case-insensitive', 'Application/JSON', json],
    ['spaces and tabs around', ' \tapplication/json\t ', json],
    ['other media type', 'text/plain', json],
    ['suffix type is a different type', 'application/merge-patch+json', json],
    [
      'allowed when listed',
      'application/merge-patch+json',
      ['application/json', 'application/merge-patch+json'],
    ],
    ['empty', '', json],
    ['wildcard', 'application/*', json],
    ['list', 'application/json, text/plain', json],
    ['no subtype', 'application', json],
    ['kelvin sign is not k', 'application/jsonK', ['application/jsonk']],
    ['vertical tab is not whitespace', '\u000bapplication/json', json],
  ];
  return {
    description:
      'FR-18: is the Content-Type header value allowed by the route? Media type = the part before ";", without spaces and tabs around it, ASCII lower-cased; exact match against the list.',
    cases: inputs.map(([name, header, allowed]) => ({
      name,
      header,
      allowed,
      expect: { ok: isAllowedContentType(header, allowed) },
    })),
  };
}

const baseConfig = (): Record<string, Json> => ({
  version: 1,
  upstreams: {
    hubspot: {
      origin: 'https://api.hubapi.com',
      auth: { type: 'bearer', secret: 'hubspot-token' },
      timeoutMs: 10000,
    },
  },
  routes: {
    newsletter: {
      method: 'POST',
      path: '/newsletter',
      upstream: 'hubspot',
      upstreamPath: '/crm/v3/objects/contacts',
      maxBodyBytes: 16384,
      contentTypes: ['application/json'],
      responseContentTypes: ['application/json'],
      enabled: true,
      origins: [],
      rateLimit: null,
    },
  },
});

type Mutation = (config: Record<string, Json>) => void;
const upstream = (config: Record<string, Json>) =>
  (config['upstreams'] as Record<string, Record<string, Json>>)[
    'hubspot'
  ] as Record<string, Json>;
const route = (config: Record<string, Json>) =>
  (config['routes'] as Record<string, Record<string, Json>>)[
    'newsletter'
  ] as Record<string, Json>;

function configVectors(): Json {
  const cases: [string, Mutation, string[]?][] = [
    ['valid', () => undefined],
    ['upstream without auth', (c) => (upstream(c)['auth'] = null), []],
    [
      'header auth',
      (c) =>
        (upstream(c)['auth'] = {
          type: 'header',
          name: 'X-Api-Key',
          secret: 'hubspot-token',
        }),
    ],
    [
      'query auth',
      (c) =>
        (upstream(c)['auth'] = {
          type: 'query',
          param: 'hapikey',
          secret: 'hubspot-token',
        }),
    ],
    [
      'origin with a port',
      (c) => (upstream(c)['origin'] = 'https://upstream.test:8443'),
    ],
    ['GET route', (c) => (route(c)['method'] = 'GET')],
    ['route at the root', (c) => (route(c)['path'] = '/')],
    ['unknown top-level key', (c) => (c['extra'] = true)],
    ['unknown route key', (c) => (route(c)['script'] = 'x')],
    ['unknown upstream key', (c) => (upstream(c)['insecure'] = true)],
    ['config version 2', (c) => (c['version'] = 2)],
    [
      'route name with capital letters',
      (c) => {
        const routes = c['routes'] as Record<string, Json>;
        routes['Newsletter'] = routes['newsletter'] ?? null;
        delete routes['newsletter'];
      },
    ],
    [
      'route named __proto__',
      (c) => {
        const routes = c['routes'] as Record<string, Json>;
        Object.defineProperty(routes, '__proto__', {
          value: routes['newsletter'],
          enumerable: true,
        });
        delete routes['newsletter'];
      },
    ],
    [
      'plain http origin',
      (c) => (upstream(c)['origin'] = 'http://api.hubapi.com'),
    ],
    [
      'origin with a path',
      (c) => (upstream(c)['origin'] = 'https://api.hubapi.com/crm'),
    ],
    [
      'origin with the default port',
      (c) => (upstream(c)['origin'] = 'https://api.hubapi.com:443'),
    ],
    [
      'origin with port 0',
      (c) => (upstream(c)['origin'] = 'https://api.hubapi.com:0'),
    ],
    [
      'origin with port 65536',
      (c) => (upstream(c)['origin'] = 'https://api.hubapi.com:65536'),
    ],
    [
      'origin with an IPv4 literal',
      (c) => (upstream(c)['origin'] = 'https://10.0.0.1'),
    ],
    [
      'origin with an IPv6 literal',
      (c) => (upstream(c)['origin'] = 'https://[::1]'),
    ],
    [
      'origin with upper-case host',
      (c) => (upstream(c)['origin'] = 'https://API.hubapi.com'),
    ],
    [
      'origin with user info',
      (c) => (upstream(c)['origin'] = 'https://user@api.hubapi.com'),
    ],
    [
      'origin with a trailing dot',
      (c) => (upstream(c)['origin'] = 'https://api.hubapi.com.'),
    ],
    [
      'origin label starting with a hyphen',
      (c) => (upstream(c)['origin'] = 'https://-api.hubapi.com'),
    ],
    [
      'route path not normalised',
      (c) => (route(c)['path'] = '/a/../newsletter'),
    ],
    [
      'route path with a trailing slash',
      (c) => (route(c)['path'] = '/newsletter/'),
    ],
    [
      'upstream path with an escape',
      (c) => (route(c)['upstreamPath'] = '/crm/%41'),
    ],
    [
      'upstream path with a query',
      (c) => (route(c)['upstreamPath'] = '/crm?x=1'),
    ],
    ['method TRACE', (c) => (route(c)['method'] = 'TRACE')],
    ['lower-case method', (c) => (route(c)['method'] = 'post')],
    [
      'body limit above 10 MiB',
      (c) => (route(c)['maxBodyBytes'] = 10 * 1024 * 1024 + 1),
    ],
    ['body limit as string', (c) => (route(c)['maxBodyBytes'] = '16KiB')],
    ['no content types', (c) => (route(c)['contentTypes'] = [])],
    [
      'content type with a parameter',
      (c) => (route(c)['contentTypes'] = ['application/json; charset=utf-8']),
    ],
    [
      'upper-case content type',
      (c) => (route(c)['responseContentTypes'] = ['Application/JSON']),
    ],
    ['enabled as string', (c) => (route(c)['enabled'] = 'yes')],
    ['route to an unknown upstream', (c) => (route(c)['upstream'] = 'stripe')],
    ['secret missing from the bundle', () => undefined, []],
    [
      'two routes with the same method and path',
      (c) => {
        (c['routes'] as Record<string, Json>)['newsletter-copy'] = {
          ...route(c),
        };
      },
    ],
    [
      'same path, other method',
      (c) => {
        (c['routes'] as Record<string, Json>)['newsletter-get'] = {
          ...route(c),
          method: 'GET',
        };
      },
    ],
    [
      'auth header Host',
      (c) =>
        (upstream(c)['auth'] = {
          type: 'header',
          name: 'Host',
          secret: 'hubspot-token',
        }),
    ],
    [
      'auth header Content-Length',
      (c) =>
        (upstream(c)['auth'] = {
          type: 'header',
          name: 'content-length',
          secret: 'hubspot-token',
        }),
    ],
    [
      'auth header with a space',
      (c) =>
        (upstream(c)['auth'] = {
          type: 'header',
          name: 'X Api',
          secret: 'hubspot-token',
        }),
    ],
    [
      'auth query param with "="',
      (c) =>
        (upstream(c)['auth'] = {
          type: 'query',
          param: 'a=b',
          secret: 'hubspot-token',
        }),
    ],
    [
      'unknown auth type',
      (c) => (upstream(c)['auth'] = { type: 'basic', secret: 'hubspot-token' }),
    ],
    [
      'bearer auth with an extra key',
      (c) =>
        (upstream(c)['auth'] = {
          type: 'bearer',
          secret: 'hubspot-token',
          value: 'x',
        }),
    ],
    ['timeout 0', (c) => (upstream(c)['timeoutMs'] = 0)],
    ['timeout above 60 s', (c) => (upstream(c)['timeoutMs'] = 60001)],
    [
      'route with origins (FR-15)',
      (c) =>
        (route(c)['origins'] = [
          'https://www.example.ch',
          'https://shop.example.ch:8443',
          'http://localhost:4200',
          'http://127.0.0.1',
        ]),
    ],
    ['route without origins key', (c) => delete route(c)['origins']],
    ['origin wildcard', (c) => (route(c)['origins'] = ['*'])],
    ['origin "null"', (c) => (route(c)['origins'] = ['null'])],
    [
      'origin with a trailing slash',
      (c) => (route(c)['origins'] = ['https://www.example.ch/']),
    ],
    [
      'origin with a path',
      (c) => (route(c)['origins'] = ['https://www.example.ch/shop']),
    ],
    [
      'plain http origin other than localhost',
      (c) => (route(c)['origins'] = ['http://www.example.ch']),
    ],
    [
      'http localhost with port 80',
      (c) => (route(c)['origins'] = ['http://localhost:80']),
    ],
    [
      'origin with upper-case host',
      (c) => (route(c)['origins'] = ['https://WWW.example.ch']),
    ],
    [
      '17 origins',
      (c) =>
        (route(c)['origins'] = Array.from(
          { length: 17 },
          (_, i) => `https://site${i}.example.ch`,
        )),
    ],
    [
      'rate limit per ip (FR-30)',
      (c) =>
        (route(c)['rateLimit'] = {
          requests: 5,
          windowSeconds: 60,
          per: 'ip',
        }),
    ],
    [
      'rate limit per route',
      (c) =>
        (route(c)['rateLimit'] = {
          requests: 1000000,
          windowSeconds: 86400,
          per: 'route',
        }),
    ],
    ['route without rateLimit key', (c) => delete route(c)['rateLimit']],
    [
      'rate limit of 0 requests',
      (c) =>
        (route(c)['rateLimit'] = { requests: 0, windowSeconds: 60, per: 'ip' }),
    ],
    [
      'rate limit window above a day',
      (c) =>
        (route(c)['rateLimit'] = {
          requests: 5,
          windowSeconds: 86401,
          per: 'ip',
        }),
    ],
    [
      'rate limit window as a string',
      (c) =>
        (route(c)['rateLimit'] = {
          requests: 5,
          windowSeconds: '60',
          per: 'ip',
        }),
    ],
    [
      'rate limit with an unknown scope',
      (c) =>
        (route(c)['rateLimit'] = {
          requests: 5,
          windowSeconds: 60,
          per: 'user',
        }),
    ],
    [
      'rate limit without a scope',
      (c) => (route(c)['rateLimit'] = { requests: 5, windowSeconds: 60 }),
    ],
    [
      'rate limit with an extra key',
      (c) =>
        (route(c)['rateLimit'] = {
          requests: 5,
          windowSeconds: 60,
          per: 'ip',
          burst: 10,
        }),
    ],
  ];
  return {
    description:
      "Step 9 of docs/CRYPTO.md §4.3: the compiled config of an authentic bundle, with the names of the bundle's secrets → `{ok: true}` or `config_invalid`. Strict keys, closed value sets, no dangling reference, no duplicate method + path (SEC-20, SEC-46).",
    cases: cases.map(([name, mutate, secrets = ['hubspot-token']]) => {
      const config = baseConfig();
      mutate(config);
      return {
        name,
        config,
        secrets,
        expect: outcome(() => {
          validateCompiledConfig(
            JSON.parse(JSON.stringify(config)) as Json,
            secrets,
          );
        }),
      };
    }),
  };
}

const basePolicy = (): Record<string, Json> => ({
  v: 1,
  upstreams: {
    'api.hubapi.com': {
      pathPrefixes: ['/crm/v3/objects'],
      methods: ['POST'],
      secrets: ['hubspot-token'],
    },
  },
  maxBodyBytes: 65536,
  maxResponseBytes: 1048576,
  maxTimeoutMs: 15000,
  limits: {
    perIp: { requests: 30, windowSeconds: 60 },
    total: { requests: 600, windowSeconds: 60 },
    maxClients: 10000,
  },
});

function corsVectors(): Json {
  const site = 'https://www.example.ch';
  type Route = { method: string; origins: string[] };
  const open: Route[] = [{ method: 'POST', origins: [site] }];
  const origin: [string, Route, string | null, (string | null)?][] = [
    [
      'route without origins, no Origin header',
      { method: 'POST', origins: [] },
      null,
    ],
    [
      'route without origins ignores any Origin',
      { method: 'POST', origins: [] },
      'https://evil.example',
    ],
    ['listed origin', open[0] as Route, site],
    [
      'no Origin header (not a browser, or same-origin GET)',
      open[0] as Route,
      null,
    ],
    ['other origin', open[0] as Route, 'https://evil.example'],
    ['origin differs only in case', open[0] as Route, 'https://WWW.example.ch'],
    ['origin with a trailing slash', open[0] as Route, `${site}/`],
    ['origin "null" (sandboxed frame, file://)', open[0] as Route, 'null'],
    ['origin with another port', open[0] as Route, `${site}:8443`],
    ['plain http variant', open[0] as Route, 'http://www.example.ch'],
    ['suffix attack', open[0] as Route, 'https://www.example.ch.evil.example'],
    [
      'no Origin, but the browser says another site sent it (<img src>)',
      open[0] as Route,
      null,
      'cross-site',
    ],
    [
      'no Origin, sent from another subdomain of the site',
      open[0] as Route,
      null,
      'same-site',
    ],
    ['no Origin, same origin', open[0] as Route, null, 'same-origin'],
    ['no Origin, typed into the address bar', open[0] as Route, null, 'none'],
    [
      'route without origins ignores Sec-Fetch-Site',
      { method: 'POST', origins: [] },
      null,
      'cross-site',
    ],
  ];
  const both: Route[] = [
    { method: 'GET', origins: [site] },
    { method: 'POST', origins: [site] },
    { method: 'DELETE', origins: ['https://admin.example.ch'] },
  ];
  const flights: [string, Route[], string, string, string | null][] = [
    ['allowed method, no headers', both, site, 'POST', null],
    ['allowed method with Content-Type', both, site, 'POST', 'content-type'],
    ['header names are case-insensitive', both, site, 'POST', 'Content-Type'],
    [
      'empty header list items are skipped',
      both,
      site,
      'GET',
      ' , content-type ,',
    ],
    [
      'method of a route that does not list the origin',
      both,
      site,
      'DELETE',
      null,
    ],
    ['method of no route', both, site, 'PUT', null],
    ['method in lower case', both, site, 'post', null],
    ['origin of no route', both, 'https://evil.example', 'GET', null],
    ['an extra request header', both, site, 'POST', 'content-type, x-api-key'],
    ['Authorization is not allowed', both, site, 'GET', 'authorization'],
    ['Cookie is not allowed', both, site, 'GET', 'cookie'],
    ['a header name with a space', both, site, 'POST', 'content type'],
    [
      'route without origins',
      [{ method: 'POST', origins: [] }],
      site,
      'POST',
      null,
    ],
  ];
  return {
    description:
      "FR-15: origin binding and CORS. `origin` cases: a matched route, the request's Origin and Sec-Fetch-Site headers (null = absent) → `{ok: true, allowOrigin}` (null = no CORS header) or `origin_forbidden`; without Origin, a route with origins refuses `cross-site` and `same-site`. `preflight` cases: OPTIONS with Origin and Access-Control-Request-Method (and -Headers, null = absent) on a path with these routes → the answer or `preflight_rejected`. Origins compare exactly; only Content-Type may be requested; credentials are never allowed.",
    origin: origin.map(([name, route, header, fetchSite = null]) => ({
      name,
      route,
      origin: header,
      fetchSite,
      expect: outcome(() => ({
        allowOrigin: checkOrigin(route, header, fetchSite),
      })),
    })),
    preflight: flights.map(([name, routes, from, method, headers]) => ({
      name,
      routes,
      origin: from,
      requestMethod: method,
      requestHeaders: headers,
      expect: outcome(
        () =>
          preflight(
            routes as { method: 'GET'; origins: string[] }[],
            from,
            method,
            headers,
          ) as unknown as Record<string, Json>,
      ),
    })),
  };
}

function rateLimitVectors(): Json {
  const minute: Limit = { requests: 2, windowSeconds: 60 };
  const sequences: [string, Limit[], number[]][] = [
    ['two per minute', [minute], [1000, 1001, 1002, 1059, 1060, 1061, 1062]],
    ['refused requests do not count', [minute], [0, 0, 0, 0, 59, 60]],
    ['one per second', [{ requests: 1, windowSeconds: 1 }], [5, 5, 6, 6, 8]],
    [
      'several limits: every one must have room, all count together',
      [minute, { requests: 3, windowSeconds: 3600 }],
      [0, 1, 2, 60, 61, 120, 3600],
    ],
  ];
  const addresses: [string, string][] = [
    ['IPv4', '203.0.113.7'],
    ['IPv4 with a leading zero', '203.0.113.07'],
    ['IPv4 out of range', '203.0.113.256'],
    ['IPv6 counts per /64', '2001:db8:1:2:3:4:5:6'],
    ['IPv6 compressed', '2001:db8::1'],
    ['IPv6 upper case', '2001:DB8:A::1'],
    ['IPv6 loopback', '::1'],
    ['IPv4-mapped IPv6 counts as IPv4', '::ffff:203.0.113.7'],
    ['IPv4-mapped in hex', '::ffff:cb00:7107'],
    ['IPv6 with a zone id', 'fe80::1%eth0'],
    ['two "::"', '2001::db8::1'],
    ['nine groups', '1:2:3:4:5:6:7:8:9'],
    ['"::" standing for no group', '1:2:3:4::5:6:7:8'],
    ['dotted IPv4 not at the end', '::1.2.3.4:1'],
    ['empty', ''],
    ['a host name', 'localhost'],
  ];
  return {
    description:
      'FR-30, SEC-26, SEC-45. `sequences`: requests at these unix times against these limits, starting with no counters → per request `{allowed, retryAfter}` (retryAfter 0 when allowed). A window opens with the first request and lasts windowSeconds; a refused request does not count; with several limits a request passes only if each has room, and then each counts it. `clients`: REMOTE_ADDR → the key a per-IP limit counts (IPv4 as is, IPv6 by /64 as `xxxx:xxxx:xxxx:xxxx::/64`, IPv4-mapped as IPv4), or null = not an address (the gate refuses the request).',
    sequences: sequences.map(([name, limits, times]) => {
      let windows: (Window | null)[] = limits.map(() => null);
      return {
        name,
        limits: limits as unknown as Json,
        times,
        expect: times.map((now) => {
          const result = hitLimits(windows, limits, now);
          if (result.allowed) {
            windows = result.windows;
            return { allowed: true, retryAfter: 0 };
          }
          return { allowed: false, retryAfter: result.retryAfter };
        }),
      };
    }),
    clients: addresses.map(([name, address]) => ({
      name,
      address,
      expect: clientKey(address),
    })),
  };
}

function policyVectors(): Json {
  type PolicyMutation = (
    config: Record<string, Json>,
    policy: Record<string, Json>,
  ) => void;
  const allowed = (policy: Record<string, Json>) =>
    (policy['upstreams'] as Record<string, Record<string, Json>>)[
      'api.hubapi.com'
    ] as Record<string, Json>;
  const cases: [string, PolicyMutation][] = [
    ['within the policy', () => undefined],
    [
      'exact path prefix',
      (_c, p) => (allowed(p)['pathPrefixes'] = ['/crm/v3/objects/contacts']),
    ],
    [
      'root prefix allows every path',
      (_c, p) => (allowed(p)['pathPrefixes'] = ['/']),
    ],
    [
      'prefix with a trailing slash',
      (_c, p) => (allowed(p)['pathPrefixes'] = ['/crm/v3/']),
    ],
    [
      'upstream host not allowed (SEC-11)',
      (_c, p) => {
        p['upstreams'] = {
          'api.other.com': {
            pathPrefixes: ['/'],
            methods: ['POST'],
            secrets: ['hubspot-token'],
          },
        };
      },
    ],
    [
      'same host, other port',
      (c) => (upstream(c)['origin'] = 'https://api.hubapi.com:8443'),
    ],
    ['method not allowed (SEC-14)', (c) => (route(c)['method'] = 'PUT')],
    [
      'path outside every prefix (SEC-14)',
      (c) => (route(c)['upstreamPath'] = '/crm/v3/owners'),
    ],
    [
      'prefix matches only at a segment boundary',
      (_c, p) => (allowed(p)['pathPrefixes'] = ['/crm/v3/obj']),
    ],
    ['body limit above the policy', (c) => (route(c)['maxBodyBytes'] = 65537)],
    ['timeout above the policy', (c) => (upstream(c)['timeoutMs'] = 15001)],
    ['policy with an unknown key', (_c, p) => (p['allowAll'] = true)],
    ['policy version 2', (_c, p) => (p['v'] = 2)],
    [
      'policy host with a scheme',
      (_c, p) => {
        p['upstreams'] = {
          'https://api.hubapi.com': {
            pathPrefixes: ['/'],
            methods: ['POST'],
            secrets: [],
          },
        };
      },
    ],
    [
      'policy prefix not normalised',
      (_c, p) => (allowed(p)['pathPrefixes'] = ['/crm/../']),
    ],
    ['policy without methods', (_c, p) => (allowed(p)['methods'] = [])],
    [
      'secret not bound to the upstream host (SEC-35)',
      (_c, p) => (allowed(p)['secrets'] = []),
    ],
    [
      'secret bound only to another host (SEC-35)',
      (_c, p) => {
        allowed(p)['secrets'] = [];
        (p['upstreams'] as Record<string, Json>)['api.other.com'] = {
          pathPrefixes: ['/'],
          methods: ['POST'],
          secrets: ['hubspot-token'],
        };
      },
    ],
    [
      'an upstream without routes may not carry a secret to an unlisted host (SEC-35)',
      (c) => {
        (c['upstreams'] as Record<string, Json>)['other'] = {
          origin: 'https://api.other.com',
          auth: { type: 'bearer', secret: 'hubspot-token' },
          timeoutMs: 1000,
        };
      },
    ],
    [
      'an upstream without auth needs no secret binding',
      (c, p) => {
        upstream(c)['auth'] = null;
        allowed(p)['secrets'] = [];
      },
    ],
    ['policy without a secrets list', (_c, p) => delete allowed(p)['secrets']],
    [
      'policy secret name not a name',
      (_c, p) => (allowed(p)['secrets'] = ['Hubspot Token']),
    ],
    ['policy without limits (SEC-14)', (_c, p) => delete p['limits']],
    [
      'policy limits without total',
      (_c, p) => delete (p['limits'] as Record<string, Json>)['total'],
    ],
    [
      'policy per-ip limit of 0 requests',
      (_c, p) =>
        ((p['limits'] as Record<string, Json>)['perIp'] = {
          requests: 0,
          windowSeconds: 60,
        }),
    ],
    [
      'policy limit with an extra key',
      (_c, p) =>
        ((p['limits'] as Record<string, Json>)['perIp'] = {
          requests: 30,
          windowSeconds: 60,
          per: 'ip',
        }),
    ],
    [
      'policy store below 100 clients',
      (_c, p) => ((p['limits'] as Record<string, Json>)['maxClients'] = 99),
    ],
    [
      'policy store above 20 000 clients (SEC-27)',
      (_c, p) => ((p['limits'] as Record<string, Json>)['maxClients'] = 20001),
    ],
    [
      'the counter store fits the worst case (SEC-27)',
      (c, p) => {
        route(c)['rateLimit'] = { requests: 5, windowSeconds: 600, per: 'ip' };
        (p['limits'] as Record<string, Json>)['maxClients'] = 7801;
      },
    ],
    [
      'a per-IP window too long for the counter store (SEC-27)',
      (c, p) => {
        route(c)['rateLimit'] = { requests: 5, windowSeconds: 600, per: 'ip' };
        (p['limits'] as Record<string, Json>)['maxClients'] = 7800;
      },
    ],
    [
      'a whole-route limit needs one counter',
      (c, p) => {
        route(c)['rateLimit'] = {
          requests: 5,
          windowSeconds: 86400,
          per: 'route',
        };
        (p['limits'] as Record<string, Json>)['maxClients'] = 1202;
      },
    ],
    [
      'the policy alone may not overflow the store (SEC-27)',
      (_c, p) => ((p['limits'] as Record<string, Json>)['maxClients'] = 1200),
    ],
    [
      'a looser route limit is allowed: the policy limits still apply (T-21)',
      (c) =>
        (route(c)['rateLimit'] = {
          requests: 1000000,
          windowSeconds: 1,
          per: 'route',
        }),
    ],
    [
      'testing block with loopback',
      (_c, p) => {
        p['testing'] = {
          resolve: { 'api.hubapi.com': '127.0.0.1' },
          caFile: '/tmp/ca.pem',
        };
      },
    ],
    [
      'testing block may not resolve to a private address',
      (_c, p) => {
        p['testing'] = {
          resolve: { 'api.hubapi.com': '10.0.0.5' },
          caFile: null,
        };
      },
    ],
  ];
  return {
    description:
      'The local policy (SEC-10 to SEC-14) against a valid compiled config: `{ok: true}`, `policy_violation` (the config goes beyond the policy — the bundle is rejected, SEC-11) or `policy_invalid` (the policy file itself is malformed; the gate serves nothing). Hosts are keyed as `host[:port]`; a path prefix matches the same path or a path continuing at a "/" boundary.',
    cases: cases.map(([name, mutate]) => {
      const config = baseConfig();
      const policy = basePolicy();
      mutate(config, policy);
      return {
        name,
        config,
        policy,
        expect: outcome(() => {
          const parsedPolicy = parsePolicy(
            JSON.parse(JSON.stringify(policy)) as Json,
          );
          checkPolicy(
            validateCompiledConfig(JSON.parse(JSON.stringify(config)) as Json, [
              'hubspot-token',
            ]),
            parsedPolicy,
          );
        }),
      };
    }),
  };
}

async function keyFileVectors(): Promise<Json> {
  const na = await sodium();
  const seed = na.crypto_generichash(
    32,
    utf8('moat:test-only:keyfile-seed'),
    null,
  );
  const salt = na.crypto_generichash(
    16,
    utf8('moat:test-only:keyfile-salt'),
    null,
  );
  const nonce = na.crypto_generichash(
    24,
    utf8('moat:test-only:keyfile-nonce'),
    null,
  );
  const passphrase = 'correct horse battery staple (TEST ONLY)';
  // The open floor, so the vectors run fast; real files use KEYFILE_WRITE_MIN.
  const file = await createKeyFile(passphrase, {
    ops: 2,
    mem: 64 * 1024 * 1024,
    fixed: { seed, salt, nonce },
  });
  const other = na.crypto_sign_seed_keypair(
    na.crypto_generichash(32, utf8('moat:test-only:other'), null),
  );
  const edit = (change: (copy: Record<string, Json>) => void): Json => {
    const copy = JSON.parse(JSON.stringify(file)) as Record<string, Json>;
    change(copy);
    return copy;
  };
  const kdf = (copy: Record<string, Json>) =>
    copy['kdf'] as Record<string, Json>;
  const flip = (text: string) =>
    (text.startsWith('A') ? 'B' : 'A') + text.slice(1);
  const cases: [string, Json, string][] = [
    ['opens', file as unknown as Json, passphrase],
    ['wrong passphrase', file as unknown as Json, 'wrong'],
    [
      'tampered ciphertext',
      edit((c) => (c['ct'] = flip(String(c['ct'])))),
      passphrase,
    ],
    [
      'kid of another key',
      edit((c) => (c['pk'] = toBase64Url(other.publicKey))),
      passphrase,
    ],
    ['ops below the floor', edit((c) => (kdf(c)['ops'] = 1)), passphrase],
    [
      'memory below the floor',
      edit((c) => (kdf(c)['mem'] = 32 * 1024 * 1024)),
      passphrase,
    ],
    [
      'absurd memory',
      edit((c) => (kdf(c)['mem'] = 4 * 1024 * 1024 * 1024)),
      passphrase,
    ],
    ['other KDF', edit((c) => (kdf(c)['alg'] = 'scrypt')), passphrase],
    ['extra field', edit((c) => (c['note'] = 'x')), passphrase],
  ];
  const results = [];
  for (const [name, input, pass] of cases) {
    let expect: Json;
    try {
      const signer = await openKeyFile(input, pass);
      expect = { ok: true, kid: signer.kid, pk: toBase64Url(signer.publicKey) };
    } catch (error) {
      if (!(error instanceof MoatRejection)) throw error;
      expect = { ok: false, error: error.code };
    }
    results.push({ name, file: input, passphrase: pass, expect });
  }
  return {
    description:
      'Key files (docs/CRYPTO.md §6), opened by Desktop and CLI — gates never see one. `keyfile_invalid`: malformed, KDF below the open floor (ops 2, 64 MiB) or above 1 GiB, or seed/pk/kid disagree. `keyfile_locked`: wrong passphrase or tampered ciphertext.',
    notice:
      'TEST ONLY — the seed, salt and nonce are derived from public labels.',
    cases: results as unknown as Json,
  };
}

export async function buildFormatVectors(): Promise<Record<string, Json>> {
  return {
    'http/path.json': pathVectors(),
    'http/content-type.json': contentTypeVectors(),
    'http/cors.json': corsVectors(),
    'http/rate-limit.json': rateLimitVectors(),
    'config/config.json': configVectors(),
    'config/policy.json': policyVectors(),
    'crypto/keyfile.json': await keyFileVectors(),
  };
}
