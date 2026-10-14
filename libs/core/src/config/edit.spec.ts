import { describe, expect, it } from 'vitest';
import {
  addEnvironment,
  assignGate,
  ConfigEditError,
  removeRoute,
  removeUpstream,
  type RouteInput,
  setEnvironmentEnabled,
  setGateEnabled,
  setRoute,
  setRouteEnabled,
  setUpstream,
  type UpstreamInput,
} from './edit';
import { gateLockState } from './lock';
import { ConfigError, loadMoatYaml } from './yaml';

const base = `# yaml-language-server: $schema=../schema/moat.schema.json
version: 1 # the format

upstreams:
  hubspot:
    origin: "https://api.hubapi.com" # CRM
routes:
  newsletter:
    method: POST
    path: "/newsletter"
    upstream: hubspot
    upstreamPath: "/crm/v3/objects/contacts"
`;

describe('moat.yaml edits', () => {
  it('assigns a gate to a new environment and keeps comments and order', () => {
    const text = assignGate(base, 'website', 'staging');
    expect(text).toContain('# yaml-language-server');
    expect(text).toContain('version: 1 # the format');
    expect(text).toContain('# CRM');
    expect(text.indexOf('environments:')).toBeLessThan(
      text.indexOf('upstreams:'),
    );
    expect(text).toMatchInlineSnapshot(`
      "# yaml-language-server: $schema=../schema/moat.schema.json
      version: 1 # the format
      environments:
        staging: {}
      gates:
        website:
          environment: staging

      upstreams:
        hubspot:
          origin: "https://api.hubapi.com" # CRM
      routes:
        newsletter:
          method: POST
          path: "/newsletter"
          upstream: hubspot
          upstreamPath: "/crm/v3/objects/contacts"
      "
    `);
    expect(loadMoatYaml(text).gates).toEqual({
      website: { environment: 'staging' },
    });
  });

  it('leaves flow lists as written', () => {
    const text = `${base}    origins: ['https://www.example.ch', 'https://shop.example.ch']\n`;
    expect(setGateEnabled(text, 'website', false)).toContain(
      "    origins: ['https://www.example.ch', 'https://shop.example.ch']\n",
    );
  });

  it('locks and unlocks an environment, which locks its gates', () => {
    const assigned = assignGate(base, 'website', 'staging');
    const locked = setEnvironmentEnabled(assigned, 'staging', false);
    expect(locked).toMatchInlineSnapshot(`
      "# yaml-language-server: $schema=../schema/moat.schema.json
      version: 1 # the format
      environments:
        staging:
          enabled: false
      gates:
        website:
          environment: staging

      upstreams:
        hubspot:
          origin: "https://api.hubapi.com" # CRM
      routes:
        newsletter:
          method: POST
          path: "/newsletter"
          upstream: hubspot
          upstreamPath: "/crm/v3/objects/contacts"
      "
    `);
    expect(gateLockState(loadMoatYaml(locked), 'website')).toEqual({
      environment: 'staging',
      gateLocked: false,
      environmentLocked: true,
      enabled: false,
    });
    const unlocked = setEnvironmentEnabled(locked, 'staging', true);
    expect(unlocked).toBe(assigned);
    expect(gateLockState(loadMoatYaml(unlocked), 'website').enabled).toBe(true);
  });

  it('locks a gate without an environment, and unlocking leaves no trace of the lock', () => {
    const locked = setGateEnabled(base, 'website', false);
    expect(locked).toMatchInlineSnapshot(`
      "# yaml-language-server: $schema=../schema/moat.schema.json
      version: 1 # the format
      gates:
        website:
          enabled: false

      upstreams:
        hubspot:
          origin: "https://api.hubapi.com" # CRM
      routes:
        newsletter:
          method: POST
          path: "/newsletter"
          upstream: hubspot
          upstreamPath: "/crm/v3/objects/contacts"
      "
    `);
    expect(gateLockState(loadMoatYaml(locked), 'website')).toMatchObject({
      environment: null,
      gateLocked: true,
      enabled: false,
    });
    const unlocked = setGateEnabled(locked, 'website', true);
    expect(gateLockState(loadMoatYaml(unlocked), 'website').enabled).toBe(true);
    expect(unlocked).not.toContain('enabled');
  });

  it('unlocking a gate that was never named changes nothing', () => {
    expect(setGateEnabled(base, 'website', true)).toBe(base);
  });

  it('refuses an unknown environment, a bad name and moving a gate silently', () => {
    expect(() => setEnvironmentEnabled(base, 'prod', false)).toThrow(
      ConfigEditError,
    );
    expect(() => setGateEnabled(base, 'Website', false)).toThrow(
      ConfigEditError,
    );
    const staged = assignGate(base, 'website', 'staging');
    expect(() => assignGate(staged, 'website', 'production')).toThrow(
      /is in environment "staging"/,
    );
    expect(
      loadMoatYaml(assignGate(staged, 'website', 'production', true)).gates,
    ).toEqual({ website: { environment: 'production' } });
  });

  it('never edits a file the loader refuses (SEC-24)', () => {
    expect(() => addEnvironment(`${base}x: &a 1\n`, 'staging')).toThrow(
      ConfigError,
    );
  });

  it('the schema refuses a gate in an environment that does not exist', () => {
    expect(() =>
      loadMoatYaml(`${base}gates:\n  website: { environment: prod }\n`),
    ).toThrow(/no environment "prod"/);
  });
});

const site = `version: 1
upstreams:
  hubspot:
    origin: 'https://api.hubapi.com'
    auth:
      type: bearer
      secret: hubspot-token
routes:
  # Sign-ups from the footer form.
  newsletter:
    method: POST
    path: '/newsletter' # the form posts here
    upstream: hubspot
    upstreamPath: '/crm/v3/objects/contacts'
    maxBodySize: '4KiB'
    rateLimit:
      requests: 5
      window: '10m'
    origins: ['https://www.example.ch']
`;

const newsletter: RouteInput = {
  method: 'POST',
  path: '/newsletter',
  upstream: 'hubspot',
  upstreamPath: '/crm/v3/objects/contacts',
  maxBodySize: '4096B',
  rateLimit: { requests: 5, window: '600s' },
  origins: ['https://www.example.ch'],
};

describe('route edits', () => {
  it('changes nothing when every value is the same, even spelled differently', () => {
    expect(setRoute(site, 'newsletter', newsletter, 'update')).toBe(site);
  });

  it('writes only what changed, in the quote style already used, and keeps the comments', () => {
    const text = setRoute(
      site,
      'newsletter',
      {
        ...newsletter,
        path: '/signup',
        rateLimit: { requests: 10, window: '600s', per: 'route' },
        origins: ['https://www.example.ch', 'https://shop.example.ch'],
      },
      'update',
    );
    expect(text).toContain('# Sign-ups from the footer form.');
    expect(text).toContain("path: '/signup' # the form posts here");
    expect(text).toContain("window: '10m'");
    expect(text).toContain('requests: 10');
    expect(text).toContain('per: route');
    expect(text).toContain(
      "origins: ['https://www.example.ch', 'https://shop.example.ch']",
    );
    expect(loadMoatYaml(text).routes['newsletter']?.path).toBe('/signup');
  });

  it('FR-31: adds, changes and removes a quota', () => {
    const added = setRoute(
      site,
      'newsletter',
      { ...newsletter, quota: { requests: 1000, period: 'day' } },
      'update',
    );
    expect(loadMoatYaml(added).routes['newsletter']?.quota).toEqual({
      requests: 1000,
      period: 'day',
    });
    expect(added).toContain('# Sign-ups from the footer form.');
    const changed = setRoute(
      added,
      'newsletter',
      { ...newsletter, quota: { requests: 20000, period: 'month' } },
      'update',
    );
    expect(loadMoatYaml(changed).routes['newsletter']?.quota).toEqual({
      requests: 20000,
      period: 'month',
    });
    expect(setRoute(changed, 'newsletter', newsletter, 'update')).not.toContain(
      'quota',
    );
  });

  it('FR-13: writes body fields quoted, keeps them when the form leaves them out, removes them with null', () => {
    const body = {
      email: {
        type: 'string' as const,
        required: true,
        format: 'email' as const,
      },
      plan: { type: 'string' as const, enum: ['yes', '1.0'] },
    };
    const added = setRoute(
      site,
      'newsletter',
      { ...newsletter, body },
      'update',
    );
    expect(loadMoatYaml(added).routes['newsletter']?.body).toEqual(body);
    expect(added).toContain('# Sign-ups from the footer form.');
    expect(added).toMatch(/enum: \[["']yes["'], ["']1\.0["']\]/);
    // The route form does not send `body`: an update keeps it as written.
    const kept = setRoute(added, 'newsletter', newsletter, 'update');
    expect(kept).toBe(added);
    expect(
      setRoute(added, 'newsletter', { ...newsletter, body: null }, 'update'),
    ).not.toContain('body');
  });

  it('FR-13: refuses body fields on a GET route', () => {
    expect(() =>
      setRoute(
        site,
        'newsletter',
        {
          ...newsletter,
          method: 'GET',
          body: { email: { type: 'string' } },
        },
        'update',
      ),
    ).toThrow(ConfigEditError);
  });

  it('FR-31: adds, changes and removes a budget, keeping the written amounts', () => {
    const added = setRoute(
      site,
      'newsletter',
      {
        ...newsletter,
        budget: {
          usage: 'openai',
          period: 'day',
          maxOutputTokens: 8000,
          tokens: 200000,
          cost: {
            limit: '5.00',
            inputPerMillion: '2.50',
            outputPerMillion: '10.00',
          },
        },
      },
      'update',
    );
    expect(loadMoatYaml(added).routes['newsletter']?.budget).toEqual({
      usage: 'openai',
      period: 'day',
      maxOutputTokens: 8000,
      tokens: 200000,
      cost: {
        limit: '5.00',
        inputPerMillion: '2.50',
        outputPerMillion: '10.00',
      },
    });
    expect(added).toContain('# Sign-ups from the footer form.');
    // "5" is the same amount as "5.00": the author's spelling stays.
    const same = setRoute(
      added,
      'newsletter',
      {
        ...newsletter,
        budget: {
          usage: 'openai',
          period: 'day',
          maxOutputTokens: 8000,
          tokens: 200000,
          cost: { limit: '5', inputPerMillion: '2.5', outputPerMillion: '10' },
        },
      },
      'update',
    );
    expect(same).toBe(added);
    const tokensOnly = setRoute(
      added,
      'newsletter',
      {
        ...newsletter,
        budget: {
          usage: 'anthropic',
          period: 'month',
          maxOutputTokens: 8000,
          tokens: 1000000,
        },
      },
      'update',
    );
    expect(loadMoatYaml(tokensOnly).routes['newsletter']?.budget).toEqual({
      usage: 'anthropic',
      period: 'month',
      maxOutputTokens: 8000,
      tokens: 1000000,
    });
    expect(
      setRoute(tokensOnly, 'newsletter', newsletter, 'update'),
    ).not.toContain('budget');
  });

  it('removes optional keys that are left empty', () => {
    const text = setRoute(
      site,
      'newsletter',
      {
        method: 'POST',
        path: '/newsletter',
        upstream: 'hubspot',
        upstreamPath: '/crm/v3/objects/contacts',
        origins: [],
      },
      'update',
    );
    expect(text).not.toContain('maxBodySize');
    expect(text).not.toContain('rateLimit');
    expect(text).not.toContain('origins');
  });

  it('quotes a new route the way the file already does', () => {
    const text = setRoute(
      site,
      'contact',
      {
        method: 'POST',
        path: '/contact',
        upstream: 'hubspot',
        upstreamPath: '/notes',
        origins: ['https://www.example.ch'],
      },
      'create',
    );
    expect(text).toContain("    path: '/contact'\n");
    expect(text).toContain("    origins: ['https://www.example.ch']\n");
  });

  it('adds a new route with quoted paths and origins', () => {
    const text = setRoute(
      site.replaceAll("'", '"'),
      'contact',
      {
        method: 'POST',
        path: '/contact',
        upstream: 'hubspot',
        upstreamPath: '/crm/v3/objects/notes',
        origins: ['https://www.example.ch'],
      },
      'create',
    );
    expect(text).toContain(`  contact:
    method: POST
    path: "/contact"
    upstream: hubspot
    upstreamPath: "/crm/v3/objects/notes"
    origins: ["https://www.example.ch"]
`);
    expect(Object.keys(loadMoatYaml(text).routes)).toEqual([
      'newsletter',
      'contact',
    ]);
  });

  it('refuses an existing or unknown route, an unknown upstream and a second route on the same path', () => {
    const codes = (run: () => string) => {
      try {
        run();
      } catch (error) {
        return error instanceof ConfigEditError ? error.code : String(error);
      }
      return 'none';
    };
    expect(
      codes(() => setRoute(site, 'newsletter', newsletter, 'create')),
    ).toBe('route_exists');
    expect(codes(() => setRoute(site, 'contact', newsletter, 'update'))).toBe(
      'route_unknown',
    );
    expect(
      codes(() =>
        setRoute(
          site,
          'contact',
          { ...newsletter, upstream: 'stripe' },
          'create',
        ),
      ),
    ).toBe('upstream_unknown');
    expect(codes(() => setRoute(site, 'contact', newsletter, 'create'))).toBe(
      'route_conflict',
    );
    expect(codes(() => setRoute(site, 'Contact', newsletter, 'create'))).toBe(
      'name_invalid',
    );
    expect(codes(() => removeRoute(site, 'contact'))).toBe('route_unknown');
  });

  it('SEC-20/SEC-42: refuses values the gate would refuse, naming the fields', () => {
    const attempt = (input: Partial<RouteInput>) => {
      try {
        setRoute(site, 'newsletter', { ...newsletter, ...input }, 'update');
      } catch (error) {
        if (error instanceof ConfigEditError) return [error.code, error.fields];
      }
      return ['none'];
    };
    expect(attempt({ path: '/a/../admin' })).toEqual([
      'value_invalid',
      ['path'],
    ]);
    expect(attempt({ path: '/ok\nInjected: yes' })).toEqual([
      'value_invalid',
      ['path'],
    ]);
    expect(attempt({ upstreamPath: 'relative' })).toEqual([
      'value_invalid',
      ['upstreamPath'],
    ]);
    expect(attempt({ maxBodySize: '1GiB' })).toEqual([
      'value_invalid',
      ['maxBodySize'],
    ]);
    expect(
      attempt({
        origins: ['https://ok.example.ch', 'http://plain.example.ch'],
      }),
    ).toEqual(['value_invalid', ['origins.1']]);
    expect(attempt({ rateLimit: { requests: 0, window: '1m' } })).toEqual([
      'value_invalid',
      ['rateLimit.requests'],
    ]);
    expect(attempt({ quota: { requests: 0, period: 'day' } })).toEqual([
      'value_invalid',
      ['quota.requests'],
    ]);
    expect(
      attempt({
        budget: {
          usage: 'openai',
          period: 'day',
          maxOutputTokens: 8000,
          cost: { limit: '0', inputPerMillion: '1', outputPerMillion: '1' },
        },
      }),
    ).toEqual(['value_invalid', ['budget.cost.limit']]);
    expect(
      attempt({
        budget: { usage: 'openai', period: 'day', maxOutputTokens: 8000 },
      }),
    ).toEqual(['value_invalid', ['budget']]);
  });

  it('switches a route off and on, and removes it', () => {
    const off = setRouteEnabled(site, 'newsletter', false);
    expect(loadMoatYaml(off).routes['newsletter']?.enabled).toBe(false);
    expect(setRouteEnabled(off, 'newsletter', true)).toBe(site);
    const removed = removeRoute(site, 'newsletter');
    expect(loadMoatYaml(removed).routes).toEqual({});
    expect(removed).toContain('upstreams:');
  });
});

const hubspot: UpstreamInput = {
  origin: 'https://api.hubapi.com',
  auth: { type: 'bearer', secret: 'hubspot-token' },
};

describe('upstream edits', () => {
  it('changes nothing when every value is the same', () => {
    expect(setUpstream(site, 'hubspot', hubspot, 'update')).toBe(site);
  });

  it('adds an upstream after the others, quoted as the file does', () => {
    const text = setUpstream(
      site,
      'mailchimp',
      {
        origin: 'https://us21.api.mailchimp.com',
        auth: { type: 'header', name: 'X-Api-Key', secret: 'mailchimp-key' },
        timeout: '5s',
      },
      'create',
    );
    expect(text).toContain(`      secret: hubspot-token
  mailchimp:
    origin: 'https://us21.api.mailchimp.com'
    auth:
      type: header
      name: X-Api-Key
      secret: mailchimp-key
    timeout: '5s'
routes:
`);
    expect(Object.keys(loadMoatYaml(text).upstreams)).toEqual([
      'hubspot',
      'mailchimp',
    ]);
  });

  it('switches the auth type without leftover keys, and removes auth and timeout', () => {
    const query = setUpstream(
      site,
      'hubspot',
      { ...hubspot, auth: { type: 'query', param: 'hapikey', secret: 'key' } },
      'update',
    );
    expect(loadMoatYaml(query).upstreams['hubspot']?.auth).toEqual({
      type: 'query',
      param: 'hapikey',
      secret: 'key',
    });
    const bare = setUpstream(
      query,
      'hubspot',
      { origin: 'https://api.hubapi.com' },
      'update',
    );
    expect(bare).not.toContain('auth');
    expect(loadMoatYaml(bare).upstreams['hubspot']).toEqual({
      origin: 'https://api.hubapi.com',
    });
  });

  it('keeps the timeout as written when it means the same', () => {
    const text = setUpstream(
      site,
      'hubspot',
      { ...hubspot, timeout: '10s' },
      'update',
    );
    expect(
      setUpstream(
        text,
        'hubspot',
        { ...hubspot, timeout: '10000ms' },
        'update',
      ),
    ).toBe(text);
  });

  it('SEC-41/SEC-43: refuses a plain-HTTP origin, a path and a reserved auth header, naming the fields', () => {
    const attempt = (input: UpstreamInput) => {
      try {
        setUpstream(site, 'hubspot', input, 'update');
      } catch (error) {
        if (error instanceof ConfigEditError) return [error.code, error.fields];
      }
      return ['none'];
    };
    expect(attempt({ origin: 'http://api.hubapi.com' })).toEqual([
      'value_invalid',
      ['origin'],
    ]);
    expect(attempt({ origin: 'https://api.hubapi.com/crm' })).toEqual([
      'value_invalid',
      ['origin'],
    ]);
    expect(
      attempt({
        ...hubspot,
        auth: { type: 'header', name: 'Host', secret: 'hubspot-token' },
      }),
    ).toEqual(['value_invalid', ['auth.name']]);
    expect(attempt({ ...hubspot, timeout: '5m' })).toEqual([
      'value_invalid',
      ['timeout'],
    ]);
  });

  it('refuses an existing or unknown upstream, a bad secret name and removing one a route calls', () => {
    const fail = (run: () => string) => {
      try {
        run();
      } catch (error) {
        if (error instanceof ConfigEditError) return [error.code, error.fields];
      }
      return ['none'];
    };
    expect(fail(() => setUpstream(site, 'hubspot', hubspot, 'create'))).toEqual(
      ['upstream_exists', []],
    );
    expect(fail(() => setUpstream(site, 'stripe', hubspot, 'update'))).toEqual([
      'upstream_unknown',
      [],
    ]);
    expect(
      fail(() =>
        setUpstream(
          site,
          'hubspot',
          { ...hubspot, auth: { type: 'bearer', secret: 'sk_live_x' } },
          'update',
        ),
      ),
    ).toEqual(['name_invalid', []]);
    expect(fail(() => removeUpstream(site, 'hubspot'))).toEqual([
      'upstream_in_use',
      ['newsletter'],
    ]);
    const free = removeUpstream(removeRoute(site, 'newsletter'), 'hubspot');
    expect(loadMoatYaml(free).upstreams).toEqual({});
  });
});
