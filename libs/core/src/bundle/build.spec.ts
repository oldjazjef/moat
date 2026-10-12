import { describe, expect, it } from 'vitest';
import { loadMoatYaml } from '../config/yaml';
import { compileConfig } from '../config/compile';
import { createKeyFile, openKeyFile } from '../crypto/keyfile';
import { sodium } from '../crypto/sodium';
import { utf8 } from '../encoding/utf8';
import { checkPolicy, suggestPolicy } from '../policy/policy';
import { sealSecret } from '../secrets/seal';
import { verifyBundle } from './bundle';
import { buildBundle } from './build';

const yaml = `version: 1
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

async function fixture() {
  const na = await sodium();
  const fixed = {
    seed: na.randombytes_buf(32),
    salt: na.randombytes_buf(16),
    nonce: na.randombytes_buf(24),
  };
  // `fixed` lets the test use the fast open-floor KDF; real files use the write floor.
  const file = await createKeyFile('passphrase', {
    ops: 2,
    mem: 64 * 1024 * 1024,
    fixed,
  });
  const signer = await openKeyFile(
    JSON.parse(JSON.stringify(file)),
    'passphrase',
  );
  const gate = na.crypto_box_keypair();
  const config = loadMoatYaml(yaml);
  const sealed = await sealSecret(utf8('pat-TEST-ONLY'), gate.publicKey, {
    gateId: 'gate-1',
    secretName: 'hubspot-token',
    secretVersion: 1,
  });
  return { signer, config, sealed, file };
}

describe('buildBundle', () => {
  it('builds a bundle the gate side accepts, with only the referenced secrets', async () => {
    const { signer, config, sealed } = await fixture();
    const envelope = await buildBundle(
      {
        config,
        gate: 'website',
        gateId: 'gate-1',
        secrets: { 'hubspot-token': sealed, unrelated: sealed },
        version: 1,
        issuedAt: 1000,
      },
      [signer],
    );
    const verified = await verifyBundle(utf8(envelope), {
      gateId: 'gate-1',
      signers: [
        { kid: signer.kid, alg: 'ed25519', publicKey: signer.publicKey },
      ],
      threshold: 1,
      currentVersion: 0,
      now: 1000,
      expiryEnabled: false,
    });
    expect(Object.keys(verified.payload.secrets)).toEqual(['hubspot-token']);
    // An unlocked gate's config has no `enabled` key: bundles from before locks are unchanged.
    expect(Object.keys(verified.payload.config).sort()).toEqual([
      'routes',
      'upstreams',
      'version',
    ]);
  });

  it.each([
    ['the gate itself', { gates: { website: { enabled: false } } }],
    [
      'its environment',
      {
        environments: { staging: { enabled: false } },
        gates: { website: { environment: 'staging' } },
      },
    ],
  ])('signs enabled: false when %s is locked', async (_what, locks) => {
    const { signer, config, sealed } = await fixture();
    const envelope = await buildBundle(
      {
        config: { ...config, ...locks },
        gate: 'website',
        gateId: 'gate-1',
        secrets: { 'hubspot-token': sealed },
        version: 2,
        issuedAt: 1000,
      },
      [signer],
    );
    const verified = await verifyBundle(utf8(envelope), {
      gateId: 'gate-1',
      signers: [
        { kid: signer.kid, alg: 'ed25519', publicKey: signer.publicKey },
      ],
      threshold: 1,
      currentVersion: 0,
      now: 1000,
      expiryEnabled: false,
    });
    expect(verified.payload.config).toMatchObject({ enabled: false });
  });

  it('a lock on another gate or environment does not lock this one', async () => {
    const { config } = await fixture();
    const compiled = compileConfig(
      {
        ...config,
        environments: { staging: { enabled: false }, production: {} },
        gates: {
          'website-staging': { environment: 'staging' },
          other: { enabled: false },
          website: { environment: 'production' },
        },
      },
      ['hubspot-token'],
      'website',
    );
    expect(compiled).not.toHaveProperty('enabled');
  });

  it('fails before signing when a referenced secret is not sealed (SEC-46)', async () => {
    const { signer, config } = await fixture();
    await expect(
      buildBundle(
        {
          config,
          gate: 'website',
          gateId: 'gate-1',
          secrets: {},
          version: 1,
          issuedAt: 0,
        },
        [signer],
      ),
    ).rejects.toThrow('config_invalid');
  });

  it('SEC-11: fails before signing when the config leaves the gate policy', async () => {
    const { signer, config, sealed } = await fixture();
    const policy = suggestPolicy(compileConfig(config, ['hubspot-token']));
    const route = config.routes['newsletter'];
    if (route === undefined) throw new Error('fixture without route');
    const widened = {
      ...config,
      routes: {
        newsletter: {
          ...route,
          upstreamPath: '/crm/v3/owners',
        },
      },
    };
    await expect(
      buildBundle(
        {
          config: widened,
          gate: 'website',
          gateId: 'gate-1',
          secrets: { 'hubspot-token': sealed },
          version: 1,
          issuedAt: 0,
          policy,
        },
        [signer],
      ),
    ).rejects.toThrow('policy_violation');
  });
});

describe('suggestPolicy (SEC-14)', () => {
  it('admits exactly the config it was made from', async () => {
    const { config } = await fixture();
    const compiled = compileConfig(config, ['hubspot-token']);
    const policy = suggestPolicy(compiled);
    expect(policy.upstreams).toEqual({
      'api.hubapi.com': {
        pathPrefixes: ['/crm/v3/objects/contacts'],
        methods: ['POST'],
        secrets: ['hubspot-token'],
      },
    });
    expect(() => checkPolicy(compiled, policy)).not.toThrow();
  });
});

describe('createKeyFile', () => {
  it('refuses KDF parameters below the write floor', async () => {
    await expect(
      createKeyFile('x', { ops: 2, mem: 64 * 1024 * 1024 }),
    ).rejects.toThrow(RangeError);
  });

  it('SEC-34: the passphrase and the seed appear nowhere in the file', async () => {
    const { file } = await fixture();
    expect(JSON.stringify(file)).not.toContain('passphrase');
  });
});
