import { describe, expect, it } from 'vitest';
import {
  addEnvironment,
  assignGate,
  ConfigEditError,
  setEnvironmentEnabled,
  setGateEnabled,
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
