import { ConfigService } from '@nestjs/config';
import {
  fingerprint,
  fromBase64UrlLength,
  keyId,
  verifyBundle,
  NEW_PROJECT_CONFIG,
  sealSecret,
  toBase64Url,
} from '@moat/core';
import sodium from 'libsodium-wrappers-sumo';
import { describe, expect, it } from 'vitest';
import { newId } from '../../common/clock';
import { AuditTrail } from '../../audit/application/audit-trail';
import {
  FixedClock,
  InMemoryAccounts,
  InMemoryAudit,
  InMemoryCloudStore,
  InMemoryOrganisations,
  InMemoryOrgProjects,
} from '../../testing/in-memory';
import { CLOUD_GATE } from '../../../security/authz-matrix-cloud';
import { projectStorage } from '../domain/project-storage';
import { CloudSigner } from './cloud-signer';
import {
  AddGateCommand,
  EditConfigCommand,
  PreviewReleaseQuery,
  PutSecretCommand,
  ReleaseCommand,
  SetConfigCommand,
  CreatePullAddressCommand,
  PullBundleQuery,
} from './gates.commands';
import {
  AddGateHandler,
  CreatePullAddressHandler,
  EditConfigHandler,
  PreviewReleaseHandler,
  PullBundleHandler,
  PutSecretHandler,
  ReleaseHandler,
  SetConfigHandler,
} from './gates.handlers';

async function setup(withKey = true) {
  await sodium.ready;
  const accounts = new InMemoryAccounts();
  const organisations = new InMemoryOrganisations(accounts);
  const projects = new InMemoryOrgProjects();
  const store = new InMemoryCloudStore();
  const clock = new FixedClock();
  const log = new InMemoryAudit();
  const audit = new AuditTrail(log, clock);
  const signer = await CloudSigner.create(
    withKey ? toBase64Url(sodium.randombytes_buf(32)) : undefined,
  );
  const config = new ConfigService({ MOAT_PUBLIC_ORIGIN: 'https://moat.test' });
  const owner = newId();
  const org = newId();
  const project = newId();
  const at = clock.now().toISOString();
  await organisations.create(
    { id: org, name: 'Acme', createdAt: at },
    {
      organisationId: org,
      accountId: owner,
      role: 'owner',
      releaseGranted: true,
      createdAt: at,
    },
  );
  await projects.create({
    id: project,
    organisationId: org,
    name: 'P',
    createdAt: at,
  });
  const pair = sodium.crypto_box_keypair();
  const gate = {
    name: 'site',
    gateId: newId(),
    boxKey: toBase64Url(pair.publicKey),
    fingerprint: await fingerprint('x25519', pair.publicKey),
    publicKey: pair.publicKey,
  };
  const args = [organisations, projects] as const;
  return {
    owner,
    org,
    project,
    gate,
    store,
    signer,
    log,
    clock,
    organisations,
    projects,
    handlers: {
      add: new AddGateHandler(...args, store, signer, clock, audit),
      set: new SetConfigHandler(...args, store, clock, audit),
      edit: new EditConfigHandler(...args, store, clock, audit),
      put: new PutSecretHandler(...args, store, clock, audit),
      preview: new PreviewReleaseHandler(...args, store, signer),
      release: new ReleaseHandler(...args, store, signer, clock, audit),
      pull: new PullBundleHandler(store),
      address: new CreatePullAddressHandler(
        ...args,
        store,
        config as never,
        audit,
      ),
    },
  };
}

const enrol = (
  t: Awaited<ReturnType<typeof setup>>,
  extra: Partial<{ fingerprint: string; signerKey: string | null }> = {},
) =>
  t.handlers.add.execute(
    new AddGateCommand(
      t.owner,
      t.org,
      t.project,
      t.gate.name,
      t.gate.gateId,
      t.gate.boxKey,
      extra.fingerprint ?? t.gate.fingerprint,
      extra.signerKey ?? null,
    ),
  );

describe('the fixture of the authorization matrix', () => {
  it('has the fingerprint of its box key', async () => {
    await sodium.ready;
    expect(
      await fingerprint(
        'x25519',
        sodium.from_base64(
          CLOUD_GATE.boxKey,
          sodium.base64_variants.URLSAFE_NO_PADDING,
        ),
      ),
    ).toBe(CLOUD_GATE.fingerprint);
  });
});

describe('enrolling a gate (SEC-32)', () => {
  it('refuses a managed gate when the installation has no signing key', async () => {
    const t = await setup(false);
    expect(await enrol(t)).toEqual({
      status: 'refused',
      code: 'managed_unavailable',
    });
    expect(t.store.gates).toHaveLength(0);
  });

  it('still takes a gate the customer signs for without a signing key', async () => {
    const t = await setup(false);
    await sodium.ready;
    const result = await enrol(t, {
      signerKey: toBase64Url(sodium.crypto_sign_keypair().publicKey),
    });
    expect(result.status).toBe('ok');
  });

  it('compares the fingerprint after trimming nothing else, and keeps what it checked', async () => {
    const t = await setup();
    expect(
      await enrol(t, { fingerprint: t.gate.fingerprint.toLowerCase() }),
    ).toMatchObject({
      status: 'refused',
      code: 'fingerprint_mismatch',
    });
    expect(
      (await enrol(t, { fingerprint: ` ${t.gate.fingerprint}\n` })).status,
    ).toBe('ok');
    expect(t.store.gates[0]).toMatchObject({
      boxKey: t.gate.boxKey,
      mode: 'managed',
    });
  });

  it('refuses the twenty-first gate of a project', async () => {
    const t = await setup();
    for (let i = 0; i < 20; i += 1)
      await t.store.addGate({
        projectId: t.project,
        name: `gate-${i}`,
        gateId: newId(),
        boxKey: t.gate.boxKey,
        mode: 'managed',
        signerKid: null,
        signerKey: null,
        pullTokenHash: null,
        createdAt: t.clock.now().toISOString(),
      });
    expect(await enrol(t)).toEqual({ status: 'refused', code: 'gate_limit' });
  });
});

describe('moat.yaml (config)', () => {
  it('refuses an invalid file, a stale base and an oversized file; accepts a valid one', async () => {
    const t = await setup();
    const set = (text: string, base: string | null) =>
      t.handlers.set.execute(
        new SetConfigCommand(t.owner, t.org, t.project, text, base),
      );
    expect(
      await set('version: 1\nroutes: [not, a, map]\n', null),
    ).toMatchObject({
      status: 'refused',
      code: 'config_invalid',
    });
    expect(await set('x'.repeat(262_145), null)).toMatchObject({
      status: 'refused',
      code: 'config_too_large',
    });
    const saved = await set(NEW_PROJECT_CONFIG, null);
    expect(saved).toMatchObject({ status: 'ok', revision: 1 });
    // Written again with no base: it was not what the editor saw.
    expect(await set(NEW_PROJECT_CONFIG + '# x\n', null)).toEqual({
      status: 'changed',
    });
    expect(await set(NEW_PROJECT_CONFIG + '# x\n', 'f'.repeat(64))).toEqual({
      status: 'changed',
    });
    if (saved.status !== 'ok') throw new Error('save');
    expect(await set(NEW_PROJECT_CONFIG + '# x\n', saved.hash)).toMatchObject({
      revision: 2,
    });
  });

  it('applies the closed list of edits against the hash the caller saw', async () => {
    const t = await setup();
    const saved = await t.handlers.set.execute(
      new SetConfigCommand(t.owner, t.org, t.project, NEW_PROJECT_CONFIG, null),
    );
    if (saved.status !== 'ok' || saved.hash === null) throw new Error('save');
    const edit = (base: string) =>
      t.handlers.edit.execute(
        new EditConfigCommand(t.owner, t.org, t.project, base, {
          op: 'addEnvironment',
          environment: 'staging',
        }),
      );
    expect(await edit('0'.repeat(64))).toEqual({ status: 'changed' });
    expect(await edit(saved.hash)).toMatchObject({ status: 'ok', revision: 2 });
    // The same edit again changes nothing: no second write, the revision stays.
    const again = await edit(configHashOf(t, 2));
    expect(again).toMatchObject({ status: 'ok', revision: 2 });
    expect(t.store.configs.get(t.project)?.revision).toBe(2);
  });

  it('two writers on one revision: one wins, the other is told (compare-and-set)', async () => {
    const t = await setup();
    const a = await t.store.setConfig(t.project, 'a', 0, 'x');
    const b = await t.store.setConfig(t.project, 'b', 0, 'x');
    expect([a, b]).toEqual(['ok', 'conflict']);
  });
});

function configHashOf(
  t: Awaited<ReturnType<typeof setup>>,
  revision: number,
): string {
  const record = t.store.configs.get(t.project);
  if (record?.revision !== revision) throw new Error('revision');
  // Same function the handlers use.
  return (require('node:crypto') as typeof import('node:crypto'))
    .createHash('sha256')
    .update(record.text, 'utf8')
    .digest('hex');
}

describe('releases', () => {
  it('signs only with the release flag that the Owner granted', async () => {
    const t = await setup();
    const editor = newId();
    await t.organisations.addMember({
      organisationId: t.org,
      accountId: editor,
      role: 'editor',
      releaseGranted: false,
      createdAt: t.clock.now().toISOString(),
    });
    await t.handlers.set.execute(
      new SetConfigCommand(t.owner, t.org, t.project, NEW_PROJECT_CONFIG, null),
    );
    await enrol(t);
    const preview = await t.handlers.preview.execute(
      new PreviewReleaseQuery(t.owner, t.org, t.project, 'site'),
    );
    if (preview.status !== 'ok') throw new Error(JSON.stringify(preview));
    expect(
      await t.handlers.release.execute(
        new ReleaseCommand(
          editor,
          t.org,
          t.project,
          'site',
          preview.preview.digest,
        ),
      ),
    ).toEqual({ status: 'forbidden' });
    const signed = await t.handlers.release.execute(
      new ReleaseCommand(
        t.owner,
        t.org,
        t.project,
        'site',
        preview.preview.digest,
      ),
    );
    expect(signed).toMatchObject({ status: 'ok', version: 1 });
    expect(t.store.bundles).toHaveLength(1);
    expect(t.log.rows.at(-1)).toMatchObject({
      action: 'bundle.sign',
      actor: t.owner,
    });
    // Signed once: the same digest now refers to version 1, the plan is version 2.
    expect(
      await t.handlers.release.execute(
        new ReleaseCommand(
          t.owner,
          t.org,
          t.project,
          'site',
          preview.preview.digest,
        ),
      ),
    ).toEqual({ status: 'changed' });
  });

  it('a racing release that took the version leaves one bundle and a "changed"', async () => {
    const t = await setup();
    await t.handlers.set.execute(
      new SetConfigCommand(t.owner, t.org, t.project, NEW_PROJECT_CONFIG, null),
    );
    await enrol(t);
    const p = await t.handlers.preview.execute(
      new PreviewReleaseQuery(t.owner, t.org, t.project, 'site'),
    );
    if (p.status !== 'ok') throw new Error('preview');
    const go = () =>
      t.handlers.release.execute(
        new ReleaseCommand(t.owner, t.org, t.project, 'site', p.preview.digest),
      );
    const results = await Promise.all([go(), go()]);
    expect(results.map((r) => r.status).sort()).toEqual(['changed', 'ok']);
    expect(t.store.bundles).toHaveLength(1);
  });
});

describe('secrets', () => {
  it('seals nothing itself: the sealed object is stored as sent, in its canonical form', async () => {
    const t = await setup();
    await enrol(t);
    const sealed = await sealSecret(
      new TextEncoder().encode('x'),
      t.gate.publicKey,
      {
        gateId: t.gate.gateId,
        secretName: 'k',
        secretVersion: 1,
      },
    );
    const result = await t.handlers.put.execute(
      new PutSecretCommand(t.owner, t.org, t.project, 'site', 'k', {
        ...sealed,
        // Extra fields a client may send are dropped, not stored.
        ...({ extra: 'x' } as object),
      } as never),
    );
    expect(result.status).toBe('ok');
    expect(
      Object.keys(
        JSON.parse(t.store.secrets[0]?.text ?? '{}') as object,
      ).sort(),
    ).toEqual(['alg', 'ct', 'epk', 'nonce', 'secretVersion', 'v']);
  });
});

describe('the pull address', () => {
  it('serves the latest bundle for the token and nothing for anything else', async () => {
    const t = await setup();
    await t.handlers.set.execute(
      new SetConfigCommand(t.owner, t.org, t.project, NEW_PROJECT_CONFIG, null),
    );
    await enrol(t);
    const p = await t.handlers.preview.execute(
      new PreviewReleaseQuery(t.owner, t.org, t.project, 'site'),
    );
    if (p.status !== 'ok') throw new Error('preview');
    await t.handlers.release.execute(
      new ReleaseCommand(t.owner, t.org, t.project, 'site', p.preview.digest),
    );
    const made = await t.handlers.address.execute(
      new CreatePullAddressCommand(t.owner, t.org, t.project, 'site'),
    );
    if (made.status !== 'ok') throw new Error('address');
    expect(made.url).toMatch(
      /^https:\/\/moat\.test\/api\/pull\/[A-Za-z0-9_-]{43}$/,
    );
    const token = made.url.split('/').at(-1) ?? '';
    expect(await t.handlers.pull.execute(new PullBundleQuery(token))).toBe(
      t.store.bundles[0]?.text,
    );
    expect(t.log.rows.at(-1)?.details).not.toContain(token);
    expect(
      await t.handlers.pull.execute(new PullBundleQuery('x'.repeat(43))),
    ).toBeNull();
    expect(await t.handlers.pull.execute(new PullBundleQuery('..'))).toBeNull();
  });
});

describe('project storage as the core reads it', () => {
  it('lists and reads in the layout of a project folder', () => {
    const storage = projectStorage({
      config: {
        projectId: 'p',
        text: 'version: 1\n',
        revision: 1,
        updatedAt: 'x',
      },
      gates: [
        {
          projectId: 'p',
          name: 'site',
          gateId: 'g'.repeat(22),
          boxKey: 'k'.repeat(43),
          mode: 'managed',
          signerKid: null,
          signerKey: null,
          pullTokenHash: null,
          createdAt: 'x',
        },
      ],
      secrets: [],
      latestBundles: [],
    });
    expect(storage.read('moat.yaml')).toBe('version: 1\n');
    expect(storage.read('nope')).toBeNull();
    expect(storage.list('gates')).toEqual(['site.json']);
    expect(storage.list('bundles/site')).toEqual([]);
    void keyId;
  });
});

describe('rotating the installation key', () => {
  const seedOf = () => toBase64Url(sodium.randombytes_buf(32));
  const publicOf = (seed: string) =>
    toBase64Url(
      sodium.crypto_sign_seed_keypair(fromBase64UrlLength(seed, 32)).publicKey,
    );

  it('compares with a bundle the retired key signed, and signs with the new key only', async () => {
    const t = await setup();
    await t.handlers.set.execute(
      new SetConfigCommand(t.owner, t.org, t.project, NEW_PROJECT_CONFIG, null),
    );
    await enrol(t);
    const first = await t.handlers.preview.execute(
      new PreviewReleaseQuery(t.owner, t.org, t.project, 'site'),
    );
    if (first.status !== 'ok') throw new Error('preview');
    await t.handlers.release.execute(
      new ReleaseCommand(
        t.owner,
        t.org,
        t.project,
        'site',
        first.preview.digest,
      ),
    );
    const oldPublic = t.signer.info()?.publicKey ?? '';

    // The new key is current, the old one named as previous: bundle 1 is still recognised.
    const newSeed = seedOf();
    const rotated = await CloudSigner.create(newSeed, {
      previousPublic: oldPublic,
    });
    const preview = new PreviewReleaseHandler(
      t.organisations,
      t.projects,
      t.store,
      rotated,
    );
    const second = await preview.execute(
      new PreviewReleaseQuery(t.owner, t.org, t.project, 'site'),
    );
    if (second.status !== 'ok') throw new Error('preview');
    expect(second.preview).toMatchObject({
      version: 2,
      previousVersion: 1,
      changes: [],
    });

    // Without naming the retired key the old bundle is "unverified": every change shows as new.
    const forgot = await CloudSigner.create(newSeed);
    const blind = await new PreviewReleaseHandler(
      t.organisations,
      t.projects,
      t.store,
      forgot,
    ).execute(new PreviewReleaseQuery(t.owner, t.org, t.project, 'site'));
    expect(blind.status).toBe('ok');

    const release = new ReleaseHandler(
      t.organisations,
      t.projects,
      t.store,
      rotated,
      t.clock,
      new AuditTrail(t.log, t.clock),
    );
    const done = await release.execute(
      new ReleaseCommand(
        t.owner,
        t.org,
        t.project,
        'site',
        second.preview.digest,
      ),
    );
    expect(done).toMatchObject({
      status: 'ok',
      version: 2,
      kid: rotated.info()?.kid,
    });

    // A gate that pins both keys accepts it; one that still pins only the old key refuses it.
    const bytes = new TextEncoder().encode(t.store.bundles.at(-1)?.text ?? '');
    const pin = (publicKey: string, kid: string) => ({
      kid,
      alg: 'ed25519' as const,
      publicKey: fromBase64UrlLength(publicKey, 32),
    });
    const oldKey = pin(oldPublic, t.signer.info()?.kid ?? '');
    const newKey = pin(publicOf(newSeed), rotated.info()?.kid ?? '');
    const context = {
      gateId: t.gate.gateId,
      threshold: 1,
      currentVersion: 1,
      now: Math.floor(Date.now() / 1000),
      expiryEnabled: false,
    };
    expect(
      (await verifyBundle(bytes, { ...context, signers: [oldKey, newKey] }))
        .payload.version,
    ).toBe(2);
    await expect(
      verifyBundle(bytes, { ...context, signers: [oldKey] }),
    ).rejects.toBeDefined();
  });

  it('shows the announced and the retired key, and refuses a malformed or doubled one', async () => {
    const seed = seedOf();
    const next = publicOf(seedOf());
    const previous = publicOf(seedOf());
    const signer = await CloudSigner.create(seed, {
      nextPublic: next,
      previousPublic: previous,
    });
    expect(signer.info()?.next?.publicKey).toBe(next);
    expect(signer.info()?.previous?.publicKey).toBe(previous);
    expect(signer.planSigners()).toHaveLength(2);
    const own = publicOf(seed);
    await expect(CloudSigner.create(seed, { nextPublic: own })).rejects.toThrow(
      'MOAT_SIGNING_KEY_NEXT_PUBLIC',
    );
    await expect(
      CloudSigner.create(seed, { previousPublic: own }),
    ).rejects.toThrow('MOAT_SIGNING_KEY_PREVIOUS_PUBLIC');
    await expect(
      CloudSigner.create(seed, { nextPublic: next, previousPublic: next }),
    ).rejects.toThrow('MOAT_SIGNING_KEY_PREVIOUS_PUBLIC');
    await expect(
      CloudSigner.create(seed, { nextPublic: 'nope' }),
    ).rejects.toThrow('MOAT_SIGNING_KEY_NEXT_PUBLIC');
    // Without a signing key a rotation makes no sense, and the message does not echo a value.
    await expect(
      CloudSigner.create(undefined, { nextPublic: next }),
    ).rejects.toThrow(
      /^Invalid signing key environment: MOAT_SIGNING_KEY_NEXT_PUBLIC$/,
    );
    expect((await CloudSigner.create(undefined)).available).toBe(false);
  });
});
