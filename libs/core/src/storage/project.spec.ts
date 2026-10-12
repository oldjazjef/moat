import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../encoding/base64url';
import { readProject } from './project';
import type { StoragePort } from './storage-port';

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const BOX_KEY = toBase64Url(new Uint8Array(32).fill(7));
const GATE = JSON.stringify({
  moat: 'gate',
  v: 1,
  gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
  boxKey: BOX_KEY,
});
const SEALED = JSON.stringify({
  v: 1,
  alg: 'x25519-blake2b-xchacha20poly1305',
  secretVersion: 3,
  epk: 'PLANTED-EPK',
  nonce: 'PLANTED-NONCE',
  ct: 'PLANTED-CIPHERTEXT',
});

/** An in-memory project folder. */
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

describe('readProject', () => {
  it('reports an empty folder as a project without config and gates', async () => {
    expect(await readProject(folder({}))).toEqual({
      config: { status: 'missing' },
      gates: [],
    });
  });

  it('compiles the config and lists the gates with fingerprint, secrets and bundles', async () => {
    const project = await readProject(
      folder({
        'moat.yaml': RECIPE,
        'gates/site.json': GATE,
        'secrets/site/hubspot-token.json': SEALED,
        'bundles/site/1.json': '{}',
        'bundles/site/12.json': '{}',
        'bundles/site/notes.txt': '',
      }),
    );
    expect(project.config.status).toBe('valid');
    if (project.config.status !== 'valid') return;
    expect(Object.keys(project.config.config.routes)).toEqual(['newsletter']);
    expect(project.config.secretNames).toEqual(['hubspot-token']);
    const [gate] = project.gates;
    expect(gate).toMatchObject({
      name: 'site',
      status: 'valid',
      gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
      trustMode: 'signed',
      secrets: [{ name: 'hubspot-token', secretVersion: 3 }],
      missingSecrets: [],
      latestBundle: 12,
      lock: {
        environment: null,
        gateLocked: false,
        environmentLocked: false,
        enabled: true,
      },
      // '{}' is no bundle: nothing to say about its lock.
      latestBundleLocked: null,
    });
    expect(gate?.status === 'valid' && gate.boxKeyFingerprint).toMatch(
      /^MOAT(-[A-Z2-7]{1,4})+$/,
    );
  });

  it('never returns ciphertext of a sealed secret (SEC-31)', async () => {
    const project = await readProject(
      folder({
        'moat.yaml': RECIPE,
        'gates/site.json': GATE,
        'secrets/site/hubspot-token.json': SEALED,
      }),
    );
    expect(JSON.stringify(project)).not.toMatch(/PLANTED/);
  });

  it('names the secrets the config uses that are not sealed for a gate', async () => {
    const project = await readProject(
      folder({ 'moat.yaml': RECIPE, 'gates/site.json': GATE }),
    );
    expect(project.gates[0]).toMatchObject({
      missingSecrets: ['hubspot-token'],
      latestBundle: 0,
    });
  });

  it('reports YAML errors with line and column instead of throwing', async () => {
    const project = await readProject(
      folder({ 'moat.yaml': 'version: 1\nversion: 2\n' }),
    );
    expect(project.config.status).toBe('invalid');
    if (project.config.status !== 'invalid') return;
    expect(project.config.issues[0]).toMatchObject({ code: 'syntax', line: 2 });
  });

  it('marks a damaged gate file instead of failing the whole project', async () => {
    for (const content of [
      '{',
      '[]',
      JSON.stringify({ moat: 'gate', v: 1, gateId: 'short', boxKey: BOX_KEY }),
      JSON.stringify({
        moat: 'gate',
        v: 1,
        gateId: 'A'.repeat(22),
        boxKey: 'AA',
      }),
      JSON.stringify({
        moat: 'gate',
        v: 1,
        gateId: 'A'.repeat(22),
        boxKey: '*',
      }),
    ]) {
      const project = await readProject(folder({ 'gates/site.json': content }));
      expect(project.gates).toEqual([{ name: 'site', status: 'invalid' }]);
    }
  });

  it('ignores files whose names are not valid gate or secret names', async () => {
    const project = await readProject(
      folder({
        'gates/Site.json': GATE,
        'gates/../x.json': GATE,
        'gates/__proto__.json': GATE,
      }),
    );
    expect(project.gates).toEqual([]);
  });

  it("reports environments, each gate's locks and whether its latest bundle carries the lock", async () => {
    const bundle = (gateId: string, version: number, enabled?: boolean) =>
      JSON.stringify({
        moat: 'bundle',
        v: 1,
        payload: toBase64Url(
          new TextEncoder().encode(
            JSON.stringify({
              gateId,
              version,
              config: enabled === undefined ? {} : { enabled },
            }),
          ),
        ),
        sigs: [],
      });
    const yaml = RECIPE.replace(
      /^version: 1$/m,
      `version: 1
environments:
  staging: { enabled: false }
  production: {}
gates:
  site: { environment: staging }
  shop: { environment: production, enabled: false }
  other: { environment: production }`,
    );
    const project = await readProject(
      folder({
        'moat.yaml': yaml,
        'gates/site.json': GATE,
        'gates/shop.json': GATE,
        'gates/loose.json': GATE,
        'gates/forged.json': GATE,
        'bundles/site/1.json': bundle('AAAAAAAAAAAAAAAAAAAAAA', 1, false),
        'bundles/shop/2.json': bundle('AAAAAAAAAAAAAAAAAAAAAA', 2),
        'bundles/forged/1.json': bundle('BBBBBBBBBBBBBBBBBBBBBB', 1, false),
      }),
    );
    expect(
      project.config.status === 'valid' && project.config.environments,
    ).toEqual([
      { name: 'production', enabled: true, gates: ['other', 'shop'] },
      { name: 'staging', enabled: false, gates: ['site'] },
    ]);
    const byName = Object.fromEntries(
      project.gates.map((gate) => [gate.name, gate]),
    );
    expect(byName['site']).toMatchObject({
      lock: { environment: 'staging', environmentLocked: true, enabled: false },
      latestBundleLocked: true,
    });
    expect(byName['shop']).toMatchObject({
      lock: { environment: 'production', gateLocked: true, enabled: false },
      latestBundleLocked: false,
    });
    expect(byName['loose']).toMatchObject({
      lock: { environment: null, enabled: true },
      latestBundleLocked: null,
    });
    // A bundle for another gate id says nothing about this gate.
    expect(byName['forged']).toMatchObject({ latestBundleLocked: null });
  });
});
