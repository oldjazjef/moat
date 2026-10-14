import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildBundle } from '../bundle/build';
import type { Ed25519Signer } from '../bundle/bundle';
import { keyId } from '../crypto/kid';
import { sodium } from '../crypto/sodium';
import { toBase64Url } from '../encoding/base64url';
import { planBundle, type PlanSigner } from './bundle-plan';
import { DeployPlanError, planDeploy } from './deploy-plan';
import type { StoragePort } from './storage-port';

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const GATE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const gateFile = (gateId: string) =>
  JSON.stringify({
    moat: 'gate',
    v: 1,
    gateId,
    boxKey: toBase64Url(new Uint8Array(32).fill(7)),
  });
const SEALED = JSON.stringify({
  v: 1,
  alg: 'x25519-blake2b-xchacha20poly1305',
  secretVersion: 1,
  epk: toBase64Url(new Uint8Array(32).fill(1)),
  nonce: toBase64Url(new Uint8Array(24).fill(2)),
  ct: toBase64Url(new Uint8Array(40).fill(3)),
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

const BASE = {
  'moat.yaml': RECIPE,
  'gates/site.json': gateFile(GATE_ID),
  'secrets/site/hubspot-token.json': SEALED,
};

/** The project with `count` bundles of gate `site`, each signed by `signer`. */
async function project(
  signer: Ed25519Signer,
  count: number,
): Promise<Record<string, string>> {
  const files: Record<string, string> = { ...BASE };
  for (let version = 1; version <= count; version++) {
    const plan = await planBundle(folder(files), 'site', null);
    files[`bundles/site/${version}.json`] = await buildBundle(
      {
        config: plan.source,
        gate: 'site',
        gateId: GATE_ID,
        secrets: plan.secrets,
        version,
        issuedAt: 1,
      },
      [signer],
    );
  }
  return files;
}

const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    if (error instanceof DeployPlanError) return error.code;
    throw error;
  }
  return 'planned';
};

describe('planDeploy (DT-05)', () => {
  it('takes the latest bundle unchanged and the policy for exactly its config', async () => {
    const { signer, plan } = await keys();
    const files = await project(signer, 2);
    const deploy = await planDeploy(folder(files), 'site', plan);
    expect(deploy.version).toBe(2);
    expect(deploy.gateId).toBe(GATE_ID);
    expect(deploy.locked).toBe(false);
    expect(deploy.bundle).toBe(files['bundles/site/2.json']);
    const host = Object.values(deploy.policy.upstreams)[0];
    expect(host?.secrets).toEqual(['hubspot-token']);
  });

  it('refuses without a bundle or a pinned gate', async () => {
    const { plan } = await keys();
    expect(await code(() => planDeploy(folder(BASE), 'site', plan))).toBe(
      'bundle_missing',
    );
    expect(await code(() => planDeploy(folder(BASE), 'shop', plan))).toBe(
      'gate_unknown',
    );
    expect(await code(() => planDeploy(folder(BASE), '../site', plan))).toBe(
      'gate_unknown',
    );
  });

  it('T-66: a bundle another key signed shapes no policy', async () => {
    const mine = await keys();
    const planted = await keys();
    const files = await project(planted.signer, 1);
    expect(await code(() => planDeploy(folder(files), 'site', mine.plan))).toBe(
      'bundle_unverified',
    );
  });

  it('T-66: a bundle for another gate, a renamed version or a broken file is refused', async () => {
    const { signer, plan } = await keys();
    const files = await project(signer, 1);
    const other = {
      ...files,
      'gates/site.json': gateFile('BBBBBBBBBBBBBBBBBBBBBB'),
    };
    expect(await code(() => planDeploy(folder(other), 'site', plan))).toBe(
      'bundle_unverified',
    );
    const renamed = {
      ...BASE,
      'bundles/site/5.json': files['bundles/site/1.json'] as string,
    };
    expect(await code(() => planDeploy(folder(renamed), 'site', plan))).toBe(
      'bundle_unverified',
    );
    const broken = { ...BASE, 'bundles/site/1.json': '{"v":1' };
    expect(await code(() => planDeploy(folder(broken), 'site', plan))).toBe(
      'bundle_unverified',
    );
  });
});
