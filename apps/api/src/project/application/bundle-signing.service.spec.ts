import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createKeyFile,
  encodeEcdsaDer,
  fromBase64Url,
  keyId,
  toBase64Url,
  verifyBundle,
  WEBAUTHN_ALG,
} from '@moat/core';
import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../testing/in-memory-projects';
import {
  BundleSigningService,
  type PasskeyAssertion,
  type PasskeyPlanSigner,
} from './bundle-signing.service';
import { historyService } from '../testing/in-memory-storage';

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const GATE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const NOW = 1_800_000_000;
/** TEST ONLY: a planted value that must never show up in a preview or result. */
const PLANTED = 'PLANTED-CIPHERTEXT-TEST-ONLY';

async function setup() {
  // `fixed` allows the fast open-floor KDF in tests; real key files use the write floor.
  const keyFile = await createKeyFile('correct horse', {
    ops: 2,
    mem: 64 * 1024 * 1024,
    fixed: {
      seed: randomBytes(32),
      salt: randomBytes(16),
      nonce: randomBytes(24),
    },
  });
  const registry = new InMemoryProjectRegistry();
  const files = new InMemoryProjectFiles({
    '/sites/shop': {
      'moat.yaml': RECIPE,
      'gates/site.json': JSON.stringify({
        moat: 'gate',
        v: 1,
        gateId: GATE_ID,
        boxKey: toBase64Url(new Uint8Array(32).fill(7)),
      }),
      'secrets/site/hubspot-token.json': JSON.stringify({
        v: 1,
        alg: 'x25519-blake2b-xchacha20poly1305',
        secretVersion: 1,
        epk: toBase64Url(new Uint8Array(32).fill(1)),
        nonce: toBase64Url(new Uint8Array(24).fill(2)),
        ct: PLANTED,
      }),
    },
  });
  const { id } = registry.add('/sites/shop');
  const signer = { kid: keyFile.kid, publicKey: fromBase64Url(keyFile.pk) };
  return {
    id,
    files,
    registry,
    signer,
    keyFile: JSON.stringify(keyFile),
    keyFileValue: keyFile,
    service: new BundleSigningService(
      registry,
      files,
      historyService(registry),
    ),
  };
}

describe('BundleSigningService', () => {
  it('previews the next bundle by names only and signs exactly that bundle', async () => {
    const { id, files, keyFile, keyFileValue, service, signer } = await setup();
    const prepared = await service.prepare(id, 'site', signer);
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    expect(prepared.preview).toMatchObject({
      project: 'shop',
      gate: 'site',
      gateId: GATE_ID,
      version: 1,
      previousVersion: 0,
      locked: false,
    });
    expect(JSON.stringify(prepared)).not.toContain(PLANTED);

    const signed = await service.sign(
      id,
      'site',
      prepared.preview.digest,
      keyFile,
      'correct horse',
      NOW,
    );
    expect(signed).toEqual({
      status: 'signed',
      version: 1,
      kid: keyFileValue.kid,
    });
    const envelope = files.folders['/sites/shop']?.['bundles/site/1.json'];
    expect(envelope).toBeDefined();
    const verified = await verifyBundle(new TextEncoder().encode(envelope), {
      gateId: GATE_ID,
      signers: [
        {
          kid: keyFileValue.kid,
          alg: 'ed25519',
          publicKey: fromBase64Url(keyFileValue.pk),
        },
      ],
      threshold: 1,
      currentVersion: 0,
      now: NOW,
      expiryEnabled: false,
    });
    expect(verified.payload.version).toBe(1);
    expect(verified.payload.issuedAt).toBe(NOW);
    expect(await keyId('ed25519', fromBase64Url(keyFileValue.pk))).toBe(
      keyFileValue.kid,
    );

    // The next preview is version 2 with nothing changed.
    const next = await service.prepare(id, 'site', signer);
    expect(next).toMatchObject({
      status: 'ready',
      preview: {
        version: 2,
        previousVersion: 1,
        previous: 'verified',
        changes: [],
      },
    });

    // Previewed without the key (none chosen yet): everything shows as new, and that preview
    // does not sign as if it had been the verified one.
    const blind = await service.prepare(id, 'site', null);
    if (blind.status !== 'ready') throw new Error(blind.status);
    expect(blind.preview.previous).toBe('unverified');
    expect(blind.preview.changes.length).toBeGreaterThan(0);
    expect(
      await service.sign(
        id,
        'site',
        blind.preview.digest,
        keyFile,
        'correct horse',
        NOW,
      ),
    ).toEqual({ status: 'changed' });
  });

  it('refuses a wrong passphrase and a file that is not a key file, writing nothing (SEC-37)', async () => {
    const { id, files, keyFile, service, signer } = await setup();
    const prepared = await service.prepare(id, 'site', signer);
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    const digest = prepared.preview.digest;
    expect(
      await service.sign(id, 'site', digest, keyFile, 'wrong', NOW),
    ).toEqual({ status: 'key_refused', code: 'keyfile_locked' });
    expect(
      await service.sign(id, 'site', digest, '{"moat":"gate"}', 'x', NOW),
    ).toEqual({ status: 'key_refused', code: 'keyfile_invalid' });
    expect(
      await service.sign(id, 'site', digest, 'not json', 'x', NOW),
    ).toEqual({ status: 'key_refused', code: 'keyfile_invalid' });
    expect(Object.keys(files.folders['/sites/shop'] ?? {})).not.toContain(
      'bundles/site/1.json',
    );
  });

  it('signs nothing when the project changed after the dialog opened (DT-15)', async () => {
    const { id, files, keyFile, service, signer } = await setup();
    const prepared = await service.prepare(id, 'site', signer);
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    const shop = files.folders['/sites/shop'] ?? {};
    shop['moat.yaml'] = RECIPE.replace("'/newsletter'", "'/subscribe'");
    expect(
      await service.sign(
        id,
        'site',
        prepared.preview.digest,
        keyFile,
        'correct horse',
        NOW,
      ),
    ).toEqual({ status: 'changed' });
    expect(Object.keys(shop)).not.toContain('bundles/site/1.json');

    // Someone else built version 1 meanwhile: the old digest no longer matches either.
    const again = await service.prepare(id, 'site', signer);
    if (again.status !== 'ready') throw new Error(again.status);
    shop['bundles/site/1.json'] = '{}';
    expect(
      await service.sign(
        id,
        'site',
        again.preview.digest,
        keyFile,
        'correct horse',
        NOW,
      ),
    ).toEqual({ status: 'changed' });
  });

  it('reports what blocks a bundle, and an unknown project or gate as not found or refused', async () => {
    const { id, files, keyFile, service, signer } = await setup();
    const shop = files.folders['/sites/shop'] ?? {};
    delete shop['secrets/site/hubspot-token.json'];
    expect(await service.prepare(id, 'site', signer)).toEqual({
      status: 'refused',
      code: 'secrets_missing',
      secrets: ['hubspot-token'],
    });
    expect(await service.prepare(id, 'other', signer)).toMatchObject({
      status: 'refused',
      code: 'gate_unknown',
    });
    expect(await service.prepare(id, '../site', signer)).toMatchObject({
      status: 'refused',
      code: 'gate_unknown',
    });
    expect(await service.prepare('nope', 'site', signer)).toEqual({
      status: 'not_found',
    });
    expect(
      await service.sign('nope', 'site', 'x', keyFile, 'correct horse', NOW),
    ).toEqual({ status: 'not_found' });
  });

  it('reports a folder that cannot be written', async () => {
    const { id, files, keyFile, service, signer } = await setup();
    const prepared = await service.prepare(id, 'site', signer);
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    files.readOnly.add('/sites/shop');
    expect(
      await service.sign(
        id,
        'site',
        prepared.preview.digest,
        keyFile,
        'correct horse',
        NOW,
      ),
    ).toEqual({ status: 'not_writable' });
  });
});

/**
 * TEST ONLY. A software passkey: what a CTAP2 authenticator returns for `navigator.credentials.get`
 * (authenticatorData, clientDataJSON, a DER ES256 signature), made with Web Crypto.
 */
async function softPasskey(rpId = 'passkey.moat.invalid') {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const point = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey),
  );
  const kid = await keyId(WEBAUTHN_ALG, point);
  const origin = 'https://passkey.moat.invalid';
  const signer: PasskeyPlanSigner = {
    kid,
    publicKey: point,
    passkey: { rpId, origins: [origin] },
  };
  const hash = (data: Uint8Array) =>
    new Uint8Array(createHash('sha256').update(data).digest());
  async function assert(
    challenge: Uint8Array,
    options: {
      rpId?: string;
      origin?: string;
      type?: string;
      flags?: number;
      challengeOverride?: Uint8Array;
      tamperSignature?: boolean;
    } = {},
  ): Promise<PasskeyAssertion> {
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: options.type ?? 'webauthn.get',
        challenge: toBase64Url(options.challengeOverride ?? challenge),
        origin: options.origin ?? origin,
        crossOrigin: false,
      }),
    );
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(hash(new TextEncoder().encode(options.rpId ?? rpId)));
    authenticatorData[32] = options.flags ?? 0x05; // UP + UV
    const signed = new Uint8Array([
      ...authenticatorData,
      ...hash(clientDataJSON),
    ]);
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        signed,
      ),
    );
    if (options.tamperSignature) raw[10] = (raw[10] ?? 0) ^ 0x01;
    return {
      authenticatorData,
      clientDataJSON,
      signature: encodeEcdsaDer(raw),
    };
  }
  return { signer, assert, point };
}

describe('BundleSigningService with a passkey (trust mode 2)', () => {
  async function prepared() {
    const base = await setup();
    const passkey = await softPasskey();
    const result = await base.service.prepare(base.id, 'site', passkey.signer);
    if (result.status !== 'ready') throw new Error(result.status);
    return { ...base, passkey, digest: result.preview.digest };
  }
  const written = (files: Awaited<ReturnType<typeof setup>>['files']) =>
    Object.keys(files.folders['/sites/shop'] ?? {}).includes(
      'bundles/site/1.json',
    );

  it('signs the confirmed bundle with the passkey and the gate would accept it (SEC-06)', async () => {
    const { id, files, service, passkey, digest } = await prepared();
    const challenges: Uint8Array[] = [];
    const signed = await service.signWithPasskey(
      id,
      'site',
      digest,
      passkey.signer,
      async (challenge) => {
        challenges.push(challenge);
        return passkey.assert(challenge);
      },
      NOW,
    );
    expect(signed).toEqual({
      status: 'signed',
      version: 1,
      kid: passkey.signer.kid,
    });
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toHaveLength(32);
    const envelope =
      files.folders['/sites/shop']?.['bundles/site/1.json'] ?? '';
    const verified = await verifyBundle(new TextEncoder().encode(envelope), {
      gateId: GATE_ID,
      signers: [
        {
          kid: passkey.signer.kid,
          alg: WEBAUTHN_ALG,
          publicKey: passkey.point,
          rpId: 'passkey.moat.invalid',
          origins: ['https://passkey.moat.invalid'],
        },
      ],
      threshold: 1,
      currentVersion: 0,
      now: NOW,
      expiryEnabled: false,
    });
    expect(verified.payload.issuedAt).toBe(NOW);
    expect(JSON.parse(envelope).sigs[0].alg).toBe(WEBAUTHN_ALG);
  });

  it.each([
    [
      'a challenge of another bundle',
      { challengeOverride: new Uint8Array(32).fill(9) },
    ],
    ['another origin', { origin: 'https://evil.example' }],
    ['another rpId', { rpId: 'evil.example' }],
    ['webauthn.create instead of get', { type: 'webauthn.create' }],
    ['no user verification', { flags: 0x01 }],
    ['a signature that does not verify', { tamperSignature: true }],
  ])(
    'writes nothing for an assertion with %s (SEC-46)',
    async (_name, options) => {
      const { id, files, service, passkey, digest } = await prepared();
      const result = await service.signWithPasskey(
        id,
        'site',
        digest,
        passkey.signer,
        (challenge) => passkey.assert(challenge, options),
        NOW,
      );
      expect(result).toEqual({
        status: 'passkey_refused',
        code: 'assertion_invalid',
      });
      expect(written(files)).toBe(false);
    },
  );

  it('writes nothing for an assertion by another passkey', async () => {
    const { id, files, service, passkey, digest } = await prepared();
    const other = await softPasskey();
    const result = await service.signWithPasskey(
      id,
      'site',
      digest,
      passkey.signer,
      (challenge) => other.assert(challenge),
      NOW,
    );
    expect(result).toEqual({
      status: 'passkey_refused',
      code: 'assertion_invalid',
    });
    expect(written(files)).toBe(false);
  });

  it('writes nothing when the person cancels at the passkey', async () => {
    const { id, files, service, passkey, digest } = await prepared();
    expect(
      await service.signWithPasskey(
        id,
        'site',
        digest,
        passkey.signer,
        async () => null,
        NOW,
      ),
    ).toEqual({ status: 'passkey_refused', code: 'cancelled' });
    expect(written(files)).toBe(false);
  });

  it('signs nothing when the project changed before or while the passkey was asked (DT-15)', async () => {
    const { id, files, service, passkey, digest } = await prepared();
    const shop = files.folders['/sites/shop'] ?? {};
    const change = () => {
      shop['moat.yaml'] = RECIPE.replace("'/newsletter'", "'/subscribe'");
    };
    // while the passkey is asked
    expect(
      await service.signWithPasskey(
        id,
        'site',
        digest,
        passkey.signer,
        async (challenge) => {
          change();
          return passkey.assert(challenge);
        },
        NOW,
      ),
    ).toEqual({ status: 'changed' });
    expect(written(files)).toBe(false);
    // before: the old digest no longer matches, and the passkey is not even asked
    let asked = false;
    expect(
      await service.signWithPasskey(
        id,
        'site',
        digest,
        passkey.signer,
        async (challenge) => {
          asked = true;
          return passkey.assert(challenge);
        },
        NOW,
      ),
    ).toEqual({ status: 'changed' });
    expect(asked).toBe(false);
  });

  it('previews against the latest bundle only when the passkey signed it', async () => {
    const { id, service, passkey, digest } = await prepared();
    await service.signWithPasskey(
      id,
      'site',
      digest,
      passkey.signer,
      (challenge) => passkey.assert(challenge),
      NOW,
    );
    const next = await service.prepare(id, 'site', passkey.signer);
    expect(next).toMatchObject({
      status: 'ready',
      preview: { version: 2, previous: 'verified', changes: [] },
    });
    const stranger = await softPasskey();
    expect(await service.prepare(id, 'site', stranger.signer)).toMatchObject({
      status: 'ready',
      preview: { previous: 'unverified' },
    });
  });
});
