import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openSecret, toBase64Url } from '@moat/core';
import sodium from 'libsodium-wrappers-sumo';
import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../testing/in-memory-projects';
import { SecretSealingService } from './secret-sealing.service';

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const GATE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
/** TEST ONLY: a planted value that must appear nowhere but inside the ciphertext. */
const PLANTED = 'pat-PLANTED-TEST-ONLY-4711';
const bytes = (text: string) => new TextEncoder().encode(text);

async function setup() {
  await sodium.ready;
  const box = sodium.crypto_box_keypair();
  const registry = new InMemoryProjectRegistry();
  const files = new InMemoryProjectFiles({
    '/sites/shop': {
      'moat.yaml': RECIPE,
      'gates/site.json': JSON.stringify({
        moat: 'gate',
        v: 1,
        gateId: GATE_ID,
        boxKey: toBase64Url(box.publicKey),
      }),
    },
  });
  const { id } = registry.add('/sites/shop');
  return {
    id,
    files,
    box,
    shop: () => files.folders['/sites/shop'] ?? {},
    service: new SecretSealingService(registry, files),
  };
}

describe('SecretSealingService', () => {
  it('seals a value only the gate opens, writes ciphertext only and zeroes the plaintext (SEC-31, SEC-33)', async () => {
    const { id, box, shop, service } = await setup();
    const prepared = await service.prepare(id, 'site', 'hubspot-token');
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    expect(prepared.preview).toMatchObject({
      project: 'shop',
      gate: 'site',
      gateId: GATE_ID,
      name: 'hubspot-token',
      currentVersion: null,
      nextVersion: 1,
      usedBy: [{ upstream: 'hubspot', origin: 'https://api.hubapi.com' }],
      comparedBy: [],
    });

    const plaintext = bytes(PLANTED);
    expect(
      await service.seal(
        id,
        'site',
        'hubspot-token',
        prepared.preview.digest,
        plaintext,
      ),
    ).toEqual({ status: 'sealed', secretVersion: 1 });
    expect(plaintext.every((byte) => byte === 0)).toBe(true);

    const file = shop()['secrets/site/hubspot-token.json'] ?? '';
    expect(file).not.toContain(PLANTED);
    expect(JSON.stringify(shop())).not.toContain(PLANTED);
    const opened = await openSecret(
      JSON.parse(file),
      box.privateKey,
      GATE_ID,
      'hubspot-token',
    );
    expect(new TextDecoder().decode(opened)).toBe(PLANTED);
    // Bound to its name: the same ciphertext does not open as another secret.
    await expect(
      openSecret(JSON.parse(file), box.privateKey, GATE_ID, 'openai-key'),
    ).rejects.toThrow();

    // Sealing again is a new version.
    const again = await service.prepare(id, 'site', 'hubspot-token');
    expect(again).toMatchObject({
      status: 'ready',
      preview: { currentVersion: 1, nextVersion: 2 },
    });
  });

  it('writes nothing when the gate key or the version changed after the dialog opened', async () => {
    const { id, shop, service } = await setup();
    const prepared = await service.prepare(id, 'site', 'hubspot-token');
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    shop()['gates/site.json'] = JSON.stringify({
      moat: 'gate',
      v: 1,
      gateId: GATE_ID,
      boxKey: toBase64Url(randomBytes(32)),
    });
    const plaintext = bytes(PLANTED);
    expect(
      await service.seal(
        id,
        'site',
        'hubspot-token',
        prepared.preview.digest,
        plaintext,
      ),
    ).toEqual({ status: 'changed' });
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    expect(shop()['secrets/site/hubspot-token.json']).toBeUndefined();
  });

  it('asks again when an upstream that sends the secret points elsewhere since the preview (§1.5)', async () => {
    const { id, shop, service } = await setup();
    const prepared = await service.prepare(id, 'site', 'hubspot-token');
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    shop()['moat.yaml'] = RECIPE.replace(
      'https://api.hubapi.com',
      'https://collector.example.com',
    );
    const plaintext = bytes(PLANTED);
    expect(
      await service.seal(
        id,
        'site',
        'hubspot-token',
        prepared.preview.digest,
        plaintext,
      ),
    ).toEqual({ status: 'changed' });
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    expect(shop()['secrets/site/hubspot-token.json']).toBeUndefined();
  });

  it('refuses a value the gate could not send, and unknown gates or secrets', async () => {
    const { id, shop, service } = await setup();
    const prepared = await service.prepare(id, 'site', 'hubspot-token');
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    for (const value of ['', 'a\nb', 'a\0b']) {
      expect(
        await service.seal(
          id,
          'site',
          'hubspot-token',
          prepared.preview.digest,
          bytes(value),
        ),
      ).toEqual({ status: 'value_invalid' });
    }
    expect(await service.prepare(id, 'site', 'nope')).toEqual({
      status: 'refused',
      code: 'secret_unknown',
    });
    expect(await service.prepare(id, 'other', 'hubspot-token')).toEqual({
      status: 'refused',
      code: 'gate_unknown',
    });
    expect(await service.prepare('nope', 'site', 'hubspot-token')).toEqual({
      status: 'not_found',
    });
    expect(
      Object.keys(shop()).some((path) => path.startsWith('secrets/')),
    ).toBe(false);
  });

  it('reports a folder that cannot be written', async () => {
    const { id, files, service } = await setup();
    const prepared = await service.prepare(id, 'site', 'hubspot-token');
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    files.readOnly.add('/sites/shop');
    expect(
      await service.seal(
        id,
        'site',
        'hubspot-token',
        prepared.preview.digest,
        bytes(PLANTED),
      ),
    ).toEqual({ status: 'not_writable' });
  });
});
