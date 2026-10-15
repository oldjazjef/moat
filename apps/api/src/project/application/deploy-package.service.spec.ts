import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createKeyFile, fromBase64Url, toBase64Url } from '@moat/core';
import { describe, expect, it } from 'vitest';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../testing/in-memory-projects';
import { BundleSigningService } from './bundle-signing.service';
import { DeployPackageService } from './deploy-package.service';
import { historyService } from '../testing/in-memory-storage';

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const GATE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';

async function setup() {
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
        ct: toBase64Url(new Uint8Array(40).fill(3)),
      }),
    },
  });
  const { id } = registry.add('/sites/shop');
  const signer = { kid: keyFile.kid, publicKey: fromBase64Url(keyFile.pk) };
  const signing = new BundleSigningService(
    registry,
    files,
    historyService(registry),
  );
  const sign = async () => {
    const prepared = await signing.prepare(id, 'site', signer);
    if (prepared.status !== 'ready') throw new Error(prepared.status);
    await signing.sign(
      id,
      'site',
      prepared.preview.digest,
      JSON.stringify(keyFile),
      'correct horse',
      1_800_000_000,
    );
  };
  return {
    id,
    files,
    signer,
    sign,
    service: new DeployPackageService(registry, files),
  };
}

describe('DeployPackageService (DT-05)', () => {
  it('packages the latest signed bundle byte for byte, with its hash and policy', async () => {
    const { id, files, signer, sign, service } = await setup();
    expect(await service.prepare(id, 'site', signer)).toEqual({
      status: 'refused',
      code: 'bundle_missing',
    });
    await sign();
    await sign();
    const result = await service.prepare(id, 'site', signer);
    if (result.status !== 'ready') throw new Error(result.status);
    const bundle = files.folders['/sites/shop']?.['bundles/site/2.json'];
    expect(result.package).toMatchObject({
      project: 'shop',
      gate: 'site',
      gateId: GATE_ID,
      version: 2,
      locked: false,
      bundle,
      bundleSha256: createHash('sha256')
        .update(bundle ?? '')
        .digest('hex'),
    });
    const policy = JSON.parse(result.package.policy) as {
      upstreams: Record<string, { secrets: string[] }>;
    };
    expect(Object.values(policy.upstreams)[0]?.secrets).toEqual([
      'hubspot-token',
    ]);
  });

  it('refuses a bundle the key did not sign, an unknown gate or project', async () => {
    const { id, sign, service } = await setup();
    await sign();
    const other = {
      kid: 'AAAAAAAAAAAAAAAAAAAAAA',
      publicKey: new Uint8Array(32).fill(9),
    };
    expect(await service.prepare(id, 'site', other)).toEqual({
      status: 'refused',
      code: 'bundle_unverified',
    });
    expect(
      await service.prepare(id, 'shop', {
        kid: 'x',
        publicKey: new Uint8Array(32),
      }),
    ).toEqual({ status: 'refused', code: 'gate_unknown' });
    expect(
      await service.prepare('BBBBBBBBBBBBBBBBBBBBBB', 'site', other),
    ).toEqual({ status: 'not_found' });
  });
});
