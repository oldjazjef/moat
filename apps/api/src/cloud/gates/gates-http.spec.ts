import {
  fingerprint,
  fromBase64Url,
  keyId,
  NEW_PROJECT_CONFIG,
  openSecret,
  parseStrictJson,
  sealSecret,
  signBundle,
  toBase64Url,
  buildBundlePayload,
  loadMoatYaml,
  verifyBundle,
  type PinnedSigner,
} from '@moat/core';
import sodium from 'libsodium-wrappers-sumo';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLANTED_SECRETS } from '../../testing/planted-secrets';
import { csrfTokenOf } from '../auth/domain/session';
import { newId } from '../common/clock';
import { type CloudHarness, startCloudHarness } from '../testing/cloud-harness';
import { CloudDatabase } from '../../persistence/cloud/cloud-database';

/**
 * Gates in the Cloud, end to end over HTTP (SEC-01, SEC-02, SEC-31, SEC-32, SEC-52, T-90 ff.): a
 * managed gate is enrolled, a secret sealed to its box key is stored, Moat Cloud signs a bundle,
 * and the bundle is checked exactly as a gate checks it — and the secret opened with the gate's
 * own key. The Cloud never holds the secret in the clear: that is asserted on every place it could
 * leak to.
 */
const PASSWORD = PLANTED_SECRETS[2];
const PLAINTEXT = PLANTED_SECRETS[0];
let cloud: CloudHarness;
let counter = 0;
let signing: { seed: string; publicKey: Uint8Array };

beforeAll(async () => {
  await sodium.ready;
  const seed = sodium.randombytes_buf(32);
  signing = {
    seed: toBase64Url(seed),
    publicKey: sodium.crypto_sign_seed_keypair(seed).publicKey,
  };
  cloud = await startCloudHarness({
    MOAT_TRUST_PROXY: '1',
    MOAT_SIGNING_KEY: signing.seed,
  });
}, 60_000);
afterAll(async () => {
  await cloud?.stop();
});

const ip = () => ({ 'x-forwarded-for': `10.9.0.${(counter += 1) % 250}` });

interface Session {
  readonly email: string;
  readonly token: string;
  readonly csrf: string;
  readonly id: string;
}

async function account(name: string): Promise<Session> {
  const email = `${name}${counter}@example.ch`;
  await cloud.call('POST', '/api/auth/register', {
    body: { email, password: PASSWORD },
    headers: ip(),
  });
  const login = await cloud.call('POST', '/api/auth/login', {
    body: { email, password: PASSWORD },
    headers: ip(),
  });
  const token =
    /=([A-Za-z0-9_-]{43});/.exec(login.setCookies[0] ?? '')?.[1] ?? '';
  const me = await cloud.call('GET', '/api/auth/me', { token });
  return {
    email,
    token,
    csrf: csrfTokenOf(token),
    id: me.json<{ account: { id: string } }>().account.id,
  };
}
const as = (s: Session) => ({ token: s.token, csrf: s.csrf });

interface Setup {
  readonly owner: Session;
  readonly editor: Session;
  readonly org: string;
  readonly project: string;
  readonly base: string;
}

async function setup(): Promise<Setup> {
  const owner = await account('owner');
  const editor = await account('editor');
  const org = (
    await cloud.call('POST', '/api/orgs', {
      ...as(owner),
      body: { name: 'Acme' },
    })
  ).json<{ organisation: { id: string } }>().organisation.id;
  await cloud.call('POST', `/api/orgs/${org}/members`, {
    ...as(owner),
    body: { email: editor.email, role: 'editor' },
  });
  const project = (
    await cloud.call('POST', `/api/orgs/${org}/projects`, {
      ...as(owner),
      body: { name: 'Shop' },
    })
  ).json<{ project: { id: string } }>().project.id;
  return {
    owner,
    editor,
    org,
    project,
    base: `/api/orgs/${org}/projects/${project}`,
  };
}

interface Gate {
  readonly name: string;
  readonly gateId: string;
  readonly boxKey: string;
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly fingerprint: string;
}

async function newGate(name = 'site'): Promise<Gate> {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return {
    name,
    gateId: newId(),
    boxKey: toBase64Url(pair.publicKey),
    secretKey: pair.privateKey,
    publicKey: pair.publicKey,
    fingerprint: await fingerprint('x25519', pair.publicKey),
  };
}

const enrol = (s: Setup, gate: Gate, extra: object = {}) =>
  cloud.call('POST', `${s.base}/gates`, {
    ...as(s.owner),
    body: {
      name: gate.name,
      gateId: gate.gateId,
      boxKey: gate.boxKey,
      fingerprint: gate.fingerprint,
      ...extra,
    },
  });

/** A config with the HubSpot recipe: one upstream, one route, the secret `hubspot-token`. */
async function recipeConfig(s: Setup): Promise<void> {
  const put = await cloud.call('PUT', `${s.base}/config`, {
    ...as(s.owner),
    body: { text: NEW_PROJECT_CONFIG, base: null },
  });
  expect(put.status).toBe(200);
  const edited = await cloud.call('POST', `${s.base}/config/edits`, {
    ...as(s.owner),
    body: {
      base: put.json<{ hash: string }>().hash,
      op: 'applyRecipe',
      recipe: 'hubspot-newsletter',
      origins: ['https://shop.example.ch'],
    },
  });
  expect(edited.status).toBe(200);
}

async function seal(gate: Gate, name: string, version: number) {
  return sealSecret(new TextEncoder().encode(PLAINTEXT), gate.publicKey, {
    gateId: gate.gateId,
    secretName: name,
    secretVersion: version,
  });
}

const preview = (s: Setup, gate: string, who: Session = s.owner) =>
  cloud.call('GET', `${s.base}/gates/${gate}/release`, { token: who.token });
const release = (
  s: Setup,
  gate: string,
  digest: string,
  who: Session = s.owner,
) =>
  cloud.call('POST', `${s.base}/gates/${gate}/releases`, {
    ...as(who),
    body: { digest },
  });

async function cloudKey(): Promise<PinnedSigner> {
  return {
    kid: await keyId('ed25519', signing.publicKey),
    alg: 'ed25519',
    publicKey: signing.publicKey,
  };
}

describe('a managed gate, end to end (trust mode 0)', () => {
  it('enrols, seals, releases, serves — and the gate verifies and opens it', async () => {
    const s = await setup();
    const gate = await newGate();
    await recipeConfig(s);
    expect((await enrol(s, gate)).status).toBe(201);

    // The secret is sealed on the client and stored as ciphertext (SEC-31).
    const sealed = await seal(gate, 'hubspot-token', 1);
    const put = await cloud.call(
      'PUT',
      `${s.base}/gates/site/secrets/hubspot-token`,
      {
        ...as(s.owner),
        body: { sealed },
      },
    );
    expect(put.status).toBe(200);

    const first = (await preview(s, 'site')).json<{
      preview: { version: number; digest: string; changes: { kind: string }[] };
    }>().preview;
    expect(first.version).toBe(1);
    expect(first.changes.map((c) => c.kind).sort()).toEqual([
      'route',
      'secret',
      'upstream',
    ]);
    const signed = await release(s, 'site', first.digest);
    expect(signed.status).toBe(201);
    expect(signed.json()).toMatchObject({ version: 1 });

    // The pull address is shown once; the gate fetches the bundle with it.
    const address = (
      await cloud.call('POST', `${s.base}/gates/site/pull-address`, as(s.owner))
    ).json<{ url: string }>().url;
    const path = new URL(address).pathname;
    expect(path).toMatch(/^\/api\/pull\/[A-Za-z0-9_-]{43}$/);
    const pulled = await cloud.call('GET', path);
    expect(pulled.status).toBe(200);
    expect(String(pulled.headers['cache-control'])).toContain('no-store');
    expect(pulled.setCookies).toEqual([]);

    // Exactly as the gate verifies it: pinned Cloud key, gate id, monotonic version.
    const verified = await verifyBundle(new TextEncoder().encode(pulled.body), {
      gateId: gate.gateId,
      signers: [await cloudKey()],
      threshold: 1,
      currentVersion: 0,
      now: Math.floor(Date.now() / 1000),
      expiryEnabled: false,
    });
    expect(verified.payload.version).toBe(1);
    // …and a gate with another id refuses it (SEC-07).
    await expect(
      verifyBundle(new TextEncoder().encode(pulled.body), {
        gateId: newId(),
        signers: [await cloudKey()],
        threshold: 1,
        currentVersion: 0,
        now: Math.floor(Date.now() / 1000),
        expiryEnabled: false,
      }),
    ).rejects.toBeDefined();
    // The gate opens the secret with its own key; nobody else could.
    const secrets = verified.payload.secrets as Record<string, unknown>;
    const opened = await openSecret(
      secrets['hubspot-token'],
      gate.secretKey,
      gate.gateId,
      'hubspot-token',
    );
    expect(new TextDecoder().decode(opened)).toBe(PLAINTEXT);

    // The second release is version 2, and the same input gives no new release to sign.
    const again = (await preview(s, 'site')).json<{
      preview: { version: number; previousVersion: number; changes: unknown[] };
    }>().preview;
    expect(again).toMatchObject({
      version: 2,
      previousVersion: 1,
      changes: [],
    });
  });

  it('keeps the plaintext out of every place the Cloud could leak it to', async () => {
    const s = await setup();
    const gate = await newGate();
    await recipeConfig(s);
    await enrol(s, gate);
    await cloud.call('PUT', `${s.base}/gates/site/secrets/hubspot-token`, {
      ...as(s.owner),
      body: { sealed: await seal(gate, 'hubspot-token', 1) },
    });
    const digest = (await preview(s, 'site')).json<{
      preview: { digest: string };
    }>().preview.digest;
    await release(s, 'site', digest);
    const db = cloud.get(CloudDatabase).client;
    const everything = [
      JSON.stringify(await db.cloudSecret.findMany()),
      JSON.stringify(await db.cloudBundle.findMany()),
      JSON.stringify(await db.cloudConfig.findMany()),
      JSON.stringify(await db.auditEntry.findMany()),
      (await cloud.call('GET', `${s.base}/gates/site/secrets`, as(s.owner)))
        .body,
      (await cloud.call('GET', `${s.base}/gates`, as(s.owner))).body,
      (await cloud.call('GET', `${s.base}/config`, as(s.owner))).body,
      (await cloud.call('GET', `/api/orgs/${s.org}/audit/export`, as(s.owner)))
        .body,
    ].join('\n');
    expect(everything).not.toContain(PLAINTEXT);
    // The secrets list names and versions only, never the ciphertext.
    const listed = (
      await cloud.call('GET', `${s.base}/gates/site/secrets`, as(s.owner))
    ).json<{ secrets: Record<string, unknown>[] }>().secrets;
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual([
      'name',
      'secretVersion',
      'updatedAt',
    ]);
  });

  it('signs nothing without the release permission, nothing that changed since the preview, and nothing with a missing secret', async () => {
    const s = await setup();
    const gate = await newGate();
    await recipeConfig(s);
    await enrol(s, gate);
    // The recipe uses `hubspot-token`, which is not sealed yet: no bundle can be planned.
    const missing = await preview(s, 'site');
    expect(missing.status).toBe(422);
    expect(missing.json()).toMatchObject({
      error: 'secrets_missing',
      secrets: ['hubspot-token'],
    });
    await cloud.call('PUT', `${s.base}/gates/site/secrets/hubspot-token`, {
      ...as(s.owner),
      body: { sealed: await seal(gate, 'hubspot-token', 1) },
    });
    const digest = (await preview(s, 'site')).json<{
      preview: { digest: string };
    }>().preview.digest;
    // An Editor holds no release flag (the Owner grants it): 403, nothing signed.
    expect((await release(s, 'site', digest, s.editor)).status).toBe(403);
    // A confirmation of something else: 409, nothing signed.
    expect((await release(s, 'site', '0'.repeat(64))).status).toBe(409);
    // The config changes after the preview: the old digest is refused.
    const config = (
      await cloud.call('GET', `${s.base}/config`, as(s.owner))
    ).json<{
      hash: string;
    }>();
    await cloud.call('POST', `${s.base}/config/edits`, {
      ...as(s.owner),
      body: { base: config.hash, op: 'disableRoute', route: 'newsletter' },
    });
    expect((await release(s, 'site', digest)).status).toBe(409);
    const db = cloud.get(CloudDatabase).client;
    expect(
      await db.cloudBundle.count({ where: { projectId: s.project } }),
    ).toBe(0);
  });

  it("refuses a fingerprint that is not the box key's, a replaced box key, and a bad gate id (SEC-32)", async () => {
    const s = await setup();
    const gate = await newGate();
    const other = await newGate('other');
    const mismatch = await enrol(s, gate, { fingerprint: other.fingerprint });
    expect(mismatch.status).toBe(422);
    expect(mismatch.json()).toMatchObject({ error: 'fingerprint_mismatch' });
    expect((await enrol(s, gate, { gateId: 'short' })).json()).toMatchObject({
      error: 'gate_id_invalid',
    });
    expect(
      (await enrol(s, gate, { boxKey: 'not-a-key' })).json(),
    ).toMatchObject({
      error: 'box_key_invalid',
    });
    expect((await enrol(s, gate)).status).toBe(201);
    expect((await enrol(s, gate)).json()).toMatchObject({
      error: 'gate_exists',
    });
    // Only Owner and Admin enrol gates: an Editor may not pin a key.
    const asEditor = await cloud.call('POST', `${s.base}/gates`, {
      ...as(s.editor),
      body: {
        name: 'other',
        gateId: other.gateId,
        boxKey: other.boxKey,
        fingerprint: other.fingerprint,
      },
    });
    expect(asEditor.status).toBe(403);
  });

  it('stores a secret version once, refuses an older or equal one, and refuses anything that is not a sealed secret', async () => {
    const s = await setup();
    const gate = await newGate();
    await enrol(s, gate);
    const put = (sealed: unknown, name = 'hubspot-token', who = s.owner) =>
      cloud.call('PUT', `${s.base}/gates/site/secrets/${name}`, {
        ...as(who),
        body: { sealed },
      });
    expect((await put(await seal(gate, 'hubspot-token', 2))).status).toBe(200);
    for (const version of [1, 2])
      expect(
        (await put(await seal(gate, 'hubspot-token', version))).json(),
      ).toMatchObject({
        error: 'version_stale',
      });
    expect((await put(await seal(gate, 'hubspot-token', 3))).status).toBe(200);
    const good = await seal(gate, 'other-token', 1);
    for (const bad of [
      { ...good, alg: 'rot13' },
      { ...good, v: 2 },
      { ...good, epk: 'short' },
      { ...good, nonce: good.nonce.slice(1) },
      { ...good, ct: 'short' },
      { ...good, ct: '!!!'.repeat(20) },
    ])
      expect(
        (await put(bad, 'other-token')).status,
        JSON.stringify(Object.keys(bad)),
      ).toBe(422);
    expect((await put(good, 'Bad_Name')).status).toBe(422);
    expect((await put(good, 'x', s.editor)).status).toBe(200);
    // A secret for a gate that does not exist is a 404.
    expect(
      (
        await cloud.call('PUT', `${s.base}/gates/nogate/secrets/x`, {
          ...as(s.owner),
          body: { sealed: good },
        })
      ).status,
    ).toBe(404);
  });

  it('serves a gate only through its own address, and a new address ends the old one', async () => {
    const s = await setup();
    const gate = await newGate();
    await recipeConfig(s);
    await enrol(s, gate);
    await cloud.call('PUT', `${s.base}/gates/site/secrets/hubspot-token`, {
      ...as(s.owner),
      body: { sealed: await seal(gate, 'hubspot-token', 1) },
    });
    const digest = (await preview(s, 'site')).json<{
      preview: { digest: string };
    }>().preview.digest;
    await release(s, 'site', digest);
    const first = new URL(
      (
        await cloud.call(
          'POST',
          `${s.base}/gates/site/pull-address`,
          as(s.owner),
        )
      ).json<{ url: string }>().url,
    ).pathname;
    expect((await cloud.call('GET', first)).status).toBe(200);
    const second = new URL(
      (
        await cloud.call(
          'POST',
          `${s.base}/gates/site/pull-address`,
          as(s.owner),
        )
      ).json<{ url: string }>().url,
    ).pathname;
    expect(second).not.toBe(first);
    expect((await cloud.call('GET', first)).status).toBe(404);
    expect((await cloud.call('GET', second)).status).toBe(200);
    // Only the hash is stored.
    const rows = await cloud.get(CloudDatabase).client.cloudGate.findMany();
    expect(JSON.stringify(rows)).not.toContain(second.split('/').at(-1) ?? 'x');
    // Not a token, an unknown token, a token of a gate without a bundle: the same 404.
    for (const path of [
      '/api/pull/short',
      `/api/pull/${'A'.repeat(43)}`,
      '/api/pull/%2e%2e',
    ])
      expect((await cloud.call('GET', path)).status, path).toBe(404);
  });
});

describe('a gate the customer signs for (trust modes 1 to 3)', () => {
  async function customerKey() {
    await sodium.ready;
    const pair = sodium.crypto_sign_keypair();
    return {
      publicKey: pair.publicKey,
      secretKey: pair.privateKey,
      kid: await keyId('ed25519', pair.publicKey),
    };
  }

  it('stores what that key signed, and only that: Moat Cloud cannot sign for it (SEC-02)', async () => {
    const s = await setup();
    const gate = await newGate();
    const customer = await customerKey();
    const added = await enrol(s, gate, {
      signerKey: toBase64Url(customer.publicKey),
    });
    expect(added.status).toBe(201);
    expect(added.json<{ gate: { mode: string } }>().gate.mode).toBe('signed');
    await recipeConfig(s);
    // The Cloud will not plan or sign a bundle for this gate.
    expect((await preview(s, 'site')).json()).toMatchObject({
      error: 'not_managed',
    });
    expect((await release(s, 'site', '0'.repeat(64))).json()).toMatchObject({
      error: 'not_managed',
    });

    const sign = async (version: number, key = customer, id = gate.gateId) =>
      signBundle(
        buildBundlePayload({
          config: loadMoatYaml(NEW_PROJECT_CONFIG),
          gate: gate.name,
          gateId: id,
          secrets: {},
          version,
          issuedAt: 1_700_000_000,
        }),
        [
          {
            alg: 'ed25519',
            secretKey: key.secretKey,
            publicKey: key.publicKey,
          },
        ],
      );
    const upload = (envelope: string) =>
      cloud.call('POST', `${s.base}/gates/site/bundles`, {
        ...as(s.owner),
        body: { envelope },
      });
    expect((await upload(await sign(1))).status).toBe(201);
    // Replay and rollback (SEC-04): the same or a lower version is refused.
    for (const version of [1])
      expect((await upload(await sign(version))).status).toBe(422);
    expect((await upload(await sign(3))).status).toBe(201);
    expect((await upload(await sign(2))).status).toBe(422);
    // Another gate's bundle (SEC-07) and another key's signature (SEC-01).
    expect((await upload(await sign(4, customer, newId()))).status).toBe(422);
    expect((await upload(await sign(4, await customerKey()))).status).toBe(422);
    // Not a bundle at all.
    for (const junk of [
      '{}',
      'x',
      JSON.stringify({ moat: 'bundle', v: 1, payload: 'AAAA', sigs: [] }),
    ])
      expect((await upload(junk)).status).toBe(422);
    // The pull serves the latest (3), as signed.
    const url = new URL(
      (
        await cloud.call(
          'POST',
          `${s.base}/gates/site/pull-address`,
          as(s.owner),
        )
      ).json<{
        url: string;
      }>().url,
    ).pathname;
    const pulled = await cloud.call('GET', url);
    const payload = parseStrictJson(
      fromBase64Url(JSON.parse(pulled.body).payload as string),
    ) as { version: number };
    expect(payload.version).toBe(3);
    // An Editor without the release flag cannot upload.
    expect(
      (
        await cloud.call('POST', `${s.base}/gates/site/bundles`, {
          ...as(s.editor),
          body: { envelope: await sign(5) },
        })
      ).status,
    ).toBe(403);
  });

  it('refuses a malformed signer key', async () => {
    const s = await setup();
    const gate = await newGate();
    expect((await enrol(s, gate, { signerKey: 'nope' })).json()).toMatchObject({
      error: 'signer_key_invalid',
    });
  });
});

describe('the audit log of gate changes (SEC-53)', () => {
  it('records config, gate, secret, pull address and release events without any value', async () => {
    const s = await setup();
    const gate = await newGate();
    await recipeConfig(s);
    await enrol(s, gate);
    await cloud.call('PUT', `${s.base}/gates/site/secrets/hubspot-token`, {
      ...as(s.owner),
      body: { sealed: await seal(gate, 'hubspot-token', 1) },
    });
    await cloud.call('POST', `${s.base}/gates/site/pull-address`, as(s.owner));
    const digest = (await preview(s, 'site')).json<{
      preview: { digest: string };
    }>().preview.digest;
    await release(s, 'site', digest);
    const log = await cloud.call(
      'GET',
      `/api/orgs/${s.org}/audit?limit=200`,
      as(s.owner),
    );
    const entries = log.json<{
      entries: { action: string; details: string }[];
    }>().entries;
    expect(entries.map((e) => e.action)).toEqual([
      'org.create',
      'member.add_requested',
      'project.create',
      'config.edit',
      'config.edit',
      'gate.add',
      'secret.set',
      'gate.pull_token',
      'bundle.sign',
    ]);
    const text = log.body;
    expect(text).not.toContain(PLAINTEXT);
    expect(text).not.toContain('api.hubapi.com');
    expect(text).not.toContain('/api/pull/');
    const verified = await cloud.call(
      'GET',
      `/api/orgs/${s.org}/audit/verify`,
      as(s.owner),
    );
    expect(verified.json()).toMatchObject({ check: { status: 'intact' } });
  });
});
