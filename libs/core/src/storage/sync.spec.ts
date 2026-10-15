import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  publicPoint,
  scalarFrom,
  signDeterministic,
} from '../../scripts/p256-test-signer';
import { buildBundle } from '../bundle/build';
import {
  assembleEnvelope,
  bundlePayloadBytes,
  webauthnChallenge,
  type Ed25519Signer,
} from '../bundle/bundle';
import { encodeEcdsaDer, webauthnSignature } from '../crypto/webauthn';
import { concatBytes, utf8 } from '../encoding/utf8';
import { keyId } from '../crypto/kid';
import { sodium } from '../crypto/sodium';
import { toBase64Url } from '../encoding/base64url';
import { planBundle, type PlanSigner } from './bundle-plan';
import type { StoragePort } from './storage-port';
import {
  gateIdOf,
  planPull,
  planPush,
  readLocalProject,
  sealedVersionOf,
  sha256Hex,
  verifyPulledBundle,
  type RemoteProject,
} from './sync';

/** A value the test has just built: its absence is the failure. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing value');
  return value;
}

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const GATE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const GATE = `${JSON.stringify(
  {
    moat: 'gate',
    v: 1,
    gateId: GATE_ID,
    boxKey: toBase64Url(new Uint8Array(32).fill(7)),
  },
  null,
  2,
)}\n`;
const sealed = (secretVersion: number, fill = 3) =>
  JSON.stringify({
    v: 1,
    alg: 'x25519-blake2b-xchacha20poly1305',
    secretVersion,
    epk: toBase64Url(new Uint8Array(32).fill(1)),
    nonce: toBase64Url(new Uint8Array(24).fill(2)),
    ct: toBase64Url(new Uint8Array(40).fill(fill)),
  });
/** What must never travel: a plaintext value lying where a sealed secret belongs. */
const PLANTED = 'sk-PLANTED-0123456789abcdef';

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
  return {
    signer: {
      alg: 'ed25519',
      secretKey: pair.privateKey,
      publicKey: pair.publicKey,
    },
    plan: {
      kid: await keyId('ed25519', pair.publicKey),
      publicKey: pair.publicKey,
    },
  };
}

async function project(
  signer: Ed25519Signer,
  count: number,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {
    'moat.yaml': RECIPE,
    'gates/site.json': GATE,
    'secrets/site/hubspot-token.json': sealed(1),
  };
  for (let version = 1; version <= count; version++) {
    const plan = await planBundle(folder(files), 'site', null);
    files[`bundles/site/${version}.json`] = await buildBundle(
      {
        config: plan.source,
        gate: 'site',
        gateId: GATE_ID,
        secrets: plan.secrets,
        version,
        issuedAt: version,
      },
      [signer],
    );
  }
  return files;
}

const EMPTY: RemoteProject = {
  config: null,
  gates: [],
  secrets: [],
  bundles: [],
};

describe('sync with a shared backend (DT-03, DT-13)', () => {
  it('reads only well-formed gates, sealed secrets and own bundles — never a plaintext', async () => {
    const { signer, plan } = await keys();
    const other = await keys();
    const files = await project(signer, 2);
    files['secrets/site/planted.json'] = PLANTED;
    files['secrets/site/planted-json.json'] = JSON.stringify({
      v: 1,
      alg: 'x25519-blake2b-xchacha20poly1305',
      secretVersion: 1,
      value: PLANTED,
    });
    files['bundles/site/3.json'] = must(
      (await project(other.signer, 3))['bundles/site/3.json'],
    );
    files['gates/broken.json'] = '{"moat":"gate"}';
    const local = await readLocalProject(folder(files), plan);
    expect(local.gates.map((gate) => gate.name)).toEqual(['site']);
    expect(local.secrets.map((secret) => secret.name)).toEqual([
      'hubspot-token',
    ]);
    expect(local.bundles.map((bundle) => bundle.version)).toEqual([1, 2]);
    expect(local.issues).toEqual([
      { code: 'bundle_unverified', gate: 'site', name: null, version: 3 },
    ]);
    const push = planPush(local, EMPTY, null);
    expect(JSON.stringify(push)).not.toContain(PLANTED);
    expect(push.config?.expectedRevision).toBeNull();
    expect(push.bundles).toHaveLength(2);
  });

  it('a trust mode 2 gate: a passkey-signed bundle is read, pushed and verified on pull', async () => {
    const na = await sodium();
    const scalar = scalarFrom(utf8('a fixed test-only seed of 32 byte'));
    const publicKey = publicPoint(scalar);
    const plan: PlanSigner = {
      kid: await keyId('webauthn-es256', publicKey),
      publicKey,
      passkey: { rpId: 'moat.example.org', origins: ['app://moat'] },
    };
    const payloadBytes = bundlePayloadBytes({
      type: 'moat.bundle',
      v: 1,
      gateId: GATE_ID,
      version: 1,
      issuedAt: 1,
      expiresAt: null,
      config: { version: 1 },
      secrets: {},
    });
    const clientDataJSON = utf8(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: toBase64Url(await webauthnChallenge(payloadBytes)),
        origin: 'app://moat',
        crossOrigin: false,
      }),
    );
    const authenticatorData = concatBytes(
      na.crypto_hash_sha256(utf8('moat.example.org')),
      new Uint8Array([0x05, 0, 0, 0, 1]),
    );
    const signature = encodeEcdsaDer(
      signDeterministic(
        na,
        scalar,
        concatBytes(authenticatorData, na.crypto_hash_sha256(clientDataJSON)),
      ),
    );
    const text = assembleEnvelope(payloadBytes, [
      webauthnSignature({
        kid: plan.kid,
        authenticatorData,
        clientDataJSON,
        signature,
      }),
    ]);
    const files = {
      'moat.yaml': RECIPE,
      'gates/site.json': GATE,
      'bundles/site/1.json': text,
    };
    const local = await readLocalProject(folder(files), plan);
    expect(local.issues).toEqual([]);
    expect(local.bundles.map((bundle) => bundle.version)).toEqual([1]);
    const ref = { gate: 'site', version: 1, digest: await sha256Hex(text) };
    expect(await verifyPulledBundle(text, ref, GATE_ID, plan)).toBe(true);
    // The ed25519 view of the same person's key does not accept it.
    const { plan: ed } = await keys();
    expect(await verifyPulledBundle(text, ref, GATE_ID, ed)).toBe(false);
  });

  it('checks the shapes it lets through', () => {
    expect(gateIdOf(GATE)).toBe(GATE_ID);
    expect(gateIdOf(GATE.replace('"v": 1', '"v": 1, "x": 1'))).toBeNull();
    expect(sealedVersionOf(sealed(4))).toBe(4);
    expect(sealedVersionOf(PLANTED)).toBeNull();
    expect(sealedVersionOf(sealed(1).replace('"ct":"', '"ct":"!'))).toBeNull();
  });

  it('push: moat.yaml only over the version both sides agreed on, else a conflict', async () => {
    const { signer, plan } = await keys();
    const local = await readLocalProject(
      folder(await project(signer, 0)),
      plan,
    );
    const theirs = `${RECIPE}# changed elsewhere\n`;
    const remote: RemoteProject = {
      ...EMPTY,
      config: { text: theirs, hash: await sha256Hex(theirs), revision: 4 },
    };
    expect(
      planPush(local, remote, must(remote.config).hash).config
        ?.expectedRevision,
    ).toBe(4);
    const conflicted = planPush(local, remote, 'f'.repeat(64));
    expect(conflicted.config).toBeNull();
    expect(conflicted.issues).toContainEqual({
      code: 'config_conflict',
      gate: null,
      name: null,
      version: null,
    });
  });

  it('push: a bundle version signed differently elsewhere is a conflict, a higher one is reported', async () => {
    const { signer, plan } = await keys();
    const local = await readLocalProject(
      folder(await project(signer, 2)),
      plan,
    );
    const remote: RemoteProject = {
      ...EMPTY,
      gates: [{ name: 'site', text: GATE }],
      bundles: [
        { gate: 'site', version: 1, digest: must(local.bundles[0]).digest },
        { gate: 'site', version: 2, digest: 'e'.repeat(64) },
        { gate: 'site', version: 3, digest: 'd'.repeat(64) },
      ],
    };
    const push = planPush(local, remote, null);
    expect(push.bundles).toEqual([]);
    expect(push.gates).toEqual([]);
    expect(push.issues.map((issue) => issue.code).sort()).toEqual([
      'bundle_conflict',
      'bundle_newer_elsewhere',
    ]);
  });

  it('push: the higher secret version wins, the same version with other bytes conflicts', async () => {
    const { signer, plan } = await keys();
    const files = await project(signer, 0);
    files['secrets/site/hubspot-token.json'] = sealed(2);
    const local = await readLocalProject(folder(files), plan);
    const remote = (version: number, fill = 3): RemoteProject => ({
      ...EMPTY,
      gates: [{ name: 'site', text: GATE }],
      secrets: [
        {
          gate: 'site',
          name: 'hubspot-token',
          secretVersion: version,
          text: sealed(version, fill),
        },
      ],
    });
    expect(planPush(local, remote(1), null).secrets[0]?.expectedVersion).toBe(
      1,
    );
    expect(planPush(local, remote(3), null).issues[0]?.code).toBe(
      'secret_newer_elsewhere',
    );
    expect(planPush(local, remote(2, 9), null).issues[0]?.code).toBe(
      'secret_conflict',
    );
    expect(planPush(local, remote(2), null).secrets).toEqual([]);
  });

  it('pull: never pins a gate from the database, never replaces a bundle', async () => {
    const { signer, plan } = await keys();
    const theirs = await project(signer, 3);
    const mine = await project(signer, 1);
    const remoteLocal = await readLocalProject(folder(theirs), plan);
    const remote: RemoteProject = {
      config: { ...must(remoteLocal.config), revision: 1 },
      gates: [
        { name: 'site', text: GATE },
        { name: 'evil', text: GATE.replace(GATE_ID, 'B'.repeat(22)) },
      ],
      secrets: [
        ...remoteLocal.secrets,
        {
          gate: 'evil',
          name: 'x',
          secretVersion: 1,
          text: sealed(1),
        },
      ],
      bundles: remoteLocal.bundles.map(({ gate, version, digest }) => ({
        gate,
        version,
        digest,
      })),
    };
    const pull = planPull(
      await readLocalProject(folder(mine), plan),
      remote,
      null,
    );
    expect(pull.bundles.map((bundle) => bundle.version)).toEqual([2, 3]);
    expect(pull.secrets).toEqual([]);
    expect(pull.issues).toContainEqual({
      code: 'gate_not_pinned',
      gate: 'evil',
      name: null,
      version: null,
    });
    const text = must(theirs['bundles/site/2.json']);
    expect(
      await verifyPulledBundle(text, must(pull.bundles[0]), GATE_ID, plan),
    ).toBe(true);
  });

  it('pull: never overwrites an existing sealed secret, a new one is written and listed (T-76)', async () => {
    const { signer, plan } = await keys();
    const mine = await readLocalProject(folder(await project(signer, 0)), plan);
    const remote: RemoteProject = {
      ...EMPTY,
      gates: [{ name: 'site', text: GATE }],
      secrets: [
        {
          gate: 'site',
          name: 'hubspot-token',
          secretVersion: 2,
          text: sealed(2, 9),
        },
        { gate: 'site', name: 'fresh', secretVersion: 1, text: sealed(1, 8) },
      ],
    };
    const pull = planPull(mine, remote, null);
    expect(pull.secrets.map((secret) => secret.name)).toEqual(['fresh']);
    expect(pull.issues).toContainEqual({
      code: 'secret_unverified',
      gate: 'site',
      name: 'hubspot-token',
      version: 2,
    });
    expect(pull.issues).toContainEqual({
      code: 'secret_from_database',
      gate: 'site',
      name: 'fresh',
      version: 1,
    });
    expect(JSON.stringify(pull.issues)).not.toContain(sealed(2, 9));
  });

  it('pull: refuses a tampered bundle, another signer, another gate or version', async () => {
    const { signer, plan } = await keys();
    const other = await keys();
    const files = await project(signer, 2);
    const text = must(files['bundles/site/2.json']);
    const ref = { gate: 'site', version: 2, digest: await sha256Hex(text) };
    const tampered = text.replace('"payload":"', '"payload":"A');
    expect(
      await verifyPulledBundle(
        tampered,
        { ...ref, digest: await sha256Hex(tampered) },
        GATE_ID,
        plan,
      ),
    ).toBe(false);
    expect(await verifyPulledBundle(tampered, ref, GATE_ID, plan)).toBe(false);
    expect(await verifyPulledBundle(text, ref, GATE_ID, other.plan)).toBe(
      false,
    );
    expect(await verifyPulledBundle(text, ref, 'B'.repeat(22), plan)).toBe(
      false,
    );
    expect(
      await verifyPulledBundle(text, { ...ref, version: 3 }, GATE_ID, plan),
    ).toBe(false);
  });

  it('pull: a changed moat.yaml here is never overwritten; an invalid one is never written', async () => {
    const { signer, plan } = await keys();
    const files = await project(signer, 0);
    files['moat.yaml'] = `${RECIPE}# mine\n`;
    const local = await readLocalProject(folder(files), plan);
    const remote: RemoteProject = {
      ...EMPTY,
      config: { text: RECIPE, hash: await sha256Hex(RECIPE), revision: 2 },
    };
    expect(planPull(local, remote, 'c'.repeat(64)).issues[0]?.code).toBe(
      'config_conflict',
    );
    expect(planPull(local, remote, must(local.config).hash).config?.text).toBe(
      RECIPE,
    );
    const invalid = 'version: 2\n';
    expect(
      planPull(
        local,
        {
          ...EMPTY,
          config: {
            text: invalid,
            hash: await sha256Hex(invalid),
            revision: 3,
          },
        },
        must(local.config).hash,
      ).issues[0]?.code,
    ).toBe('config_invalid');
  });
});
