import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createKeyFile,
  fromBase64Url,
  keyId,
  toBase64Url,
  verifyBundle,
} from '@moat/core';
import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../testing/in-memory-projects';
import { BundleSigningService } from './bundle-signing.service';
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
