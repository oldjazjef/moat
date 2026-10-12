import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signBundle, type Ed25519Signer } from '../bundle/bundle';
import { keyId } from '../crypto/kid';
import { sodium } from '../crypto/sodium';
import { toBase64Url } from '../encoding/base64url';
import type { PlanSigner } from './bundle-plan';
import { BundlePlanError, planBundle } from './bundle-plan';
import type { StoragePort } from './storage-port';

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const GATE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const GATE = JSON.stringify({
  moat: 'gate',
  v: 1,
  gateId: GATE_ID,
  boxKey: toBase64Url(new Uint8Array(32).fill(7)),
});
const sealed = (secretVersion: number, ct = 'PLANTED-CIPHERTEXT') =>
  JSON.stringify({
    v: 1,
    alg: 'x25519-blake2b-xchacha20poly1305',
    secretVersion,
    epk: 'PLANTED-EPK',
    nonce: 'PLANTED-NONCE',
    ct,
  });

function folder(files: Record<string, string>): StoragePort {
  return {
    read: (path) => files[path] ?? null,
    list: (dir) =>
      Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1))
        .filter((name) => !name.includes('/')),
  };
}

async function keys(): Promise<{ signer: Ed25519Signer; plan: PlanSigner }> {
  const na = await sodium();
  const pair = na.crypto_sign_keypair();
  const signer: Ed25519Signer = {
    alg: 'ed25519',
    secretKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
  return {
    signer,
    plan: {
      kid: await keyId('ed25519', pair.publicKey),
      publicKey: pair.publicKey,
    },
  };
}

/** A bundle file as buildBundle writes it (JCS payload, signed by `signer`). */
function bundleFile(
  signer: Ed25519Signer,
  payload: {
    gateId: string;
    version: number;
    config: object;
    secrets?: object;
  },
): Promise<string> {
  return signBundle(
    {
      type: 'moat.bundle',
      v: 1,
      issuedAt: 1,
      expiresAt: null,
      secrets: {},
      ...payload,
    } as unknown as Parameters<typeof signBundle>[0],
    [signer],
  );
}

const BASE = {
  'moat.yaml': RECIPE,
  'gates/site.json': GATE,
  'secrets/site/hubspot-token.json': sealed(1),
};

const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    if (error instanceof BundlePlanError) return [error.code, error.secrets];
    throw error;
  }
  return ['none'];
};

describe('planBundle', () => {
  it('plans the first bundle with everything as new, and carries only the used secrets', async () => {
    const plan = await planBundle(
      folder({ ...BASE, 'secrets/site/unused.json': sealed(1) }),
      'site',
      null,
    );
    expect(plan).toMatchObject({
      gate: 'site',
      gateId: GATE_ID,
      version: 1,
      previousVersion: 0,
      locked: false,
      previous: 'none',
    });
    expect(Object.keys(plan.secrets)).toEqual(['hubspot-token']);
    expect(
      plan.changes.map(({ kind, name, change }) => [kind, name, change]),
    ).toEqual([
      ['route', 'newsletter', 'added'],
      ['upstream', 'hubspot', 'added'],
      ['secret', 'hubspot-token', 'added'],
    ]);
    expect(plan.changes[1]?.fields).toContainEqual({
      field: 'origin',
      before: null,
      after: 'https://api.hubapi.com',
    });
  });

  it('shows what changed against the latest bundle signed with this key, field by field', async () => {
    const { signer, plan: key } = await keys();
    const first = await planBundle(folder(BASE), 'site', key);
    const files = {
      ...BASE,
      'bundles/site/1.json': '{}',
      'bundles/site/4.json': await bundleFile(signer, {
        gateId: GATE_ID,
        version: 4,
        config: first.config,
        secrets: first.secrets,
      }),
    };
    expect(await planBundle(folder(files), 'site', key)).toMatchObject({
      version: 5,
      previousVersion: 4,
      previous: 'verified',
      changes: [],
    });
    const changed = await planBundle(
      folder({
        ...files,
        'moat.yaml': RECIPE.replace('requests: 5', 'requests: 9').concat(
          'gates:\n  site:\n    enabled: false\n',
        ),
        'secrets/site/hubspot-token.json': sealed(2, 'NEW-CIPHERTEXT'),
      }),
      'site',
      key,
    );
    expect(changed.locked).toBe(true);
    expect(changed.changes).toEqual([
      { kind: 'lock', name: 'site', change: 'added', fields: [] },
      {
        kind: 'route',
        name: 'newsletter',
        change: 'changed',
        fields: [{ field: 'rateLimit.requests', before: '5', after: '9' }],
      },
      {
        kind: 'secret',
        name: 'hubspot-token',
        change: 'changed',
        fields: [{ field: 'secretVersion', before: '1', after: '2' }],
      },
    ]);
    expect(JSON.stringify(changed.changes)).not.toContain('CIPHERTEXT');
  });

  it('never compares with a bundle this key did not sign: a planted file cannot hide a change (T-53)', async () => {
    const mine = await keys();
    const theirs = await keys();
    const evil = RECIPE.replace(
      "'https://api.hubapi.com'",
      "'https://evil.example'",
    );
    const planted = await planBundle(
      folder({ ...BASE, 'moat.yaml': evil }),
      'site',
      theirs.plan,
    );
    const files = {
      ...BASE,
      'moat.yaml': evil,
      'bundles/site/7.json': await bundleFile(theirs.signer, {
        gateId: GATE_ID,
        version: 7,
        config: planted.config,
        secrets: planted.secrets,
      }),
    };
    for (const signer of [mine.plan, null]) {
      const plan = await planBundle(folder(files), 'site', signer);
      expect(plan.previous).toBe('unverified');
      expect(plan.version).toBe(8);
      expect(plan.changes.find((c) => c.kind === 'upstream')).toMatchObject({
        change: 'added',
        fields: expect.arrayContaining([
          { field: 'origin', before: null, after: 'https://evil.example' },
        ]),
      });
    }
    // An unsigned file that only looks like a bundle counts as unverified too.
    const fake = await planBundle(
      folder({
        ...files,
        'bundles/site/7.json': JSON.stringify({
          moat: 'bundle',
          v: 1,
          payload: 'e30',
          sigs: [],
        }),
      }),
      'site',
      mine.plan,
    );
    expect(fake.previous).toBe('unverified');
  });

  it('treats a previous bundle of another gate as unverified', async () => {
    const { signer, plan: key } = await keys();
    const plan = await planBundle(
      folder({
        ...BASE,
        'bundles/site/1.json': await bundleFile(signer, {
          gateId: 'BBBBBBBBBBBBBBBBBBBBBB',
          version: 1,
          config: { version: 1, upstreams: {}, routes: {} },
        }),
      }),
      'site',
      key,
    );
    expect(plan.version).toBe(2);
    expect(plan.previous).toBe('unverified');
    expect(plan.changes).toHaveLength(3);
  });

  it('refuses an unknown gate, a missing or invalid config and missing secrets', async () => {
    expect(await code(() => planBundle(folder(BASE), 'shop', null))).toEqual([
      'gate_unknown',
      [],
    ]);
    expect(await code(() => planBundle(folder(BASE), '../site', null))).toEqual(
      ['gate_unknown', []],
    );
    expect(
      (
        await code(() =>
          planBundle(folder({ ...BASE, 'moat.yaml': '' }), 'site', null),
        )
      )[0],
    ).toBe('config_invalid');
    const { 'moat.yaml': _config, ...noConfig } = BASE;
    expect(
      (await code(() => planBundle(folder(noConfig), 'site', null)))[0],
    ).toBe('config_missing');
    expect(
      await code(() =>
        planBundle(
          folder({
            ...BASE,
            'secrets/site/hubspot-token.json': '{"v":1}',
          }),
          'site',
          null,
        ),
      ),
    ).toEqual(['secrets_missing', ['hubspot-token']]);
  });
});
