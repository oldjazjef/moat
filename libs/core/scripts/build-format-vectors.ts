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
});

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
    'config/config.json': configVectors(),
    'config/policy.json': policyVectors(),
    'crypto/keyfile.json': await keyFileVectors(),
  };
}
