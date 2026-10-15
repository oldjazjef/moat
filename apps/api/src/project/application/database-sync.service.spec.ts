import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createKeyFile,
  fromBase64Url,
  sha256Hex,
  toBase64Url,
  verifyHistory,
  type KeyFile,
} from '@moat/core';
import { describe, expect, it } from 'vitest';
import { plantedIn, PLANTED_SECRETS } from '../../testing/planted-secrets';
import {
  InMemoryProjectFiles,
  InMemoryProjectRegistry,
} from '../testing/in-memory-projects';
import {
  InMemoryHistoryStore,
  InMemorySyncState,
  InMemorySyncTarget,
} from '../testing/in-memory-storage';
import { BundleSigningService } from './bundle-signing.service';
import { DatabaseSyncService } from './database-sync.service';
import { HistoryService } from './history.service';

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const GATE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const GATE = JSON.stringify({
  moat: 'gate',
  v: 1,
  gateId: GATE_ID,
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
const URL = 'postgresql://moat@db.example.ch/moat?sslmode=verify-full';
const KEY = 'shop';
const PASSPHRASE = PLANTED_SECRETS[2];

let keyFile: KeyFile | null = null;
async function key(): Promise<KeyFile> {
  keyFile ??= await createKeyFile(PASSPHRASE, {
    ops: 2,
    mem: 64 * 1024 * 1024,
    fixed: {
      seed: randomBytes(32),
      salt: randomBytes(16),
      nonce: randomBytes(24),
    },
  });
  return keyFile;
}

/** One desktop: its folder, its history and its sync state; the database is shared. */
async function desktop(db: InMemorySyncTarget, files: Record<string, string>) {
  const registry = new InMemoryProjectRegistry();
  const folders = new InMemoryProjectFiles({ '/site': files });
  const { id } = registry.add('/site');
  const store = new InMemoryHistoryStore();
  const history = new HistoryService(registry, store);
  const file = await key();
  const signer = { kid: file.kid, publicKey: fromBase64Url(file.pk) };
  const signing = new BundleSigningService(registry, folders, history);
  const service = new DatabaseSyncService(
    registry,
    folders,
    db,
    new InMemorySyncState(),
    history,
  );
  return {
    id,
    files,
    store,
    history,
    sync: (direction: 'push' | 'pull') =>
      service.sync(id, { url: URL, key: KEY, direction, signer }),
    sign: async (issuedAt = 1_800_000_000) => {
      const prepared = await signing.prepare(id, 'site', signer);
      if (prepared.status !== 'ready') throw new Error(prepared.status);
      const signed = await signing.sign(
        id,
        'site',
        prepared.preview.digest,
        JSON.stringify(file),
        PASSPHRASE,
        issuedAt,
      );
      if (signed.status !== 'signed') throw new Error(signed.status);
    },
  };
}

const base = () => ({
  'moat.yaml': RECIPE,
  'gates/site.json': GATE,
  'secrets/site/hubspot-token.json': SEALED,
});

describe('DatabaseSyncService (DT-03, DT-13)', () => {
  it('pushes ciphertext and signed bundles only — never a plaintext planted in the folder', async () => {
    const db = new InMemorySyncTarget();
    const a = await desktop(db, {
      ...base(),
      // Plaintext where a sealed secret belongs, and next to the project's files.
      'secrets/site/leaked.json': PLANTED_SECRETS[0],
      'secrets/site/wrapped.json': JSON.stringify({
        value: PLANTED_SECRETS[1],
      }),
    });
    await a.history.enable(a.id);
    await a.sign();
    const result = await a.sync('push');
    expect(result).toMatchObject({
      status: 'done',
      config: true,
      gates: 1,
      secrets: 1,
      bundles: 1,
      issues: [],
    });
    const stored = JSON.stringify(
      [...db.projects.values()].map((p) => ({
        ...p,
        gates: [...p.gates],
        secrets: [...p.secrets],
        bundles: [...p.bundles],
      })),
    );
    expect(plantedIn(stored)).toEqual([]);
    expect(stored).toContain('x25519-blake2b-xchacha20poly1305');
    // The history knows the push, and nothing of the connection string.
    const view = await a.history.view(a.id);
    expect(view?.entries.map((entry) => entry.kind)).toEqual([
      'history_started',
      'bundle_signed',
      'database_pushed',
    ]);
    expect(JSON.stringify(view)).not.toContain('db.example.ch');
    expect(
      await verifyHistory(await a.store.list(a.id), a.store.anchor(a.id)),
    ).toMatchObject({ status: 'intact' });
    // A second push has nothing to do.
    expect(await a.sync('push')).toMatchObject({
      config: false,
      gates: 0,
      secrets: 0,
      bundles: 0,
    });
  });

  it('pulls verified bundles and a new secret into another desktop, listed as unauthenticated (T-76)', async () => {
    const db = new InMemorySyncTarget();
    const a = await desktop(db, base());
    await a.sign();
    await a.sign();
    await a.sync('push');
    const b = await desktop(db, {
      'moat.yaml': RECIPE,
      'gates/site.json': GATE,
    });
    expect(await b.sync('pull')).toMatchObject({
      status: 'done',
      config: false,
      secrets: 1,
      bundles: 2,
      issues: [
        {
          code: 'secret_from_database',
          gate: 'site',
          name: 'hubspot-token',
          version: 1,
        },
      ],
    });
    expect(b.files['bundles/site/2.json']).toBe(a.files['bundles/site/2.json']);
    expect(b.files['secrets/site/hubspot-token.json']).toBe(SEALED);
  });

  it('never overwrites a local sealed secret with ciphertext from the database (T-76)', async () => {
    const db = new InMemorySyncTarget();
    const a = await desktop(db, base());
    await a.sync('push');
    const row = db.project(KEY).secrets.get('site/hubspot-token');
    if (row === undefined) throw new Error('no secret pushed');
    const substituted = SEALED.replace(
      '"secretVersion":1',
      '"secretVersion":2',
    );
    db.project(KEY).secrets.set('site/hubspot-token', {
      ...row,
      secretVersion: 2,
      text: substituted,
    });
    const result = await a.sync('pull');
    expect(result).toMatchObject({
      status: 'done',
      secrets: 0,
      issues: [
        {
          code: 'secret_unverified',
          gate: 'site',
          name: 'hubspot-token',
          version: 2,
        },
      ],
    });
    expect(a.files['secrets/site/hubspot-token.json']).toBe(SEALED);
  });

  it('refuses a bundle tampered in the database and writes nothing for it', async () => {
    const db = new InMemorySyncTarget();
    const a = await desktop(db, base());
    await a.sign();
    await a.sync('push');
    const row = db.project(KEY).bundles.get('site/1');
    if (row === undefined) throw new Error('no bundle pushed');
    // The attacker changes the text and fixes up the digest.
    const tampered = row.text.replace('"payload":"', '"payload":"e');
    db.project(KEY).bundles.set('site/1', {
      ...row,
      text: tampered,
      digest: await sha256Hex(tampered),
    });
    const b = await desktop(db, {
      'moat.yaml': RECIPE,
      'gates/site.json': GATE,
    });
    const result = await b.sync('pull');
    expect(result).toMatchObject({
      status: 'done',
      bundles: 0,
      issues: [
        {
          code: 'secret_from_database',
          gate: 'site',
          name: 'hubspot-token',
          version: 1,
        },
        { code: 'bundle_unverified', gate: 'site', name: null, version: 1 },
      ],
    });
    expect(b.files['bundles/site/1.json']).toBeUndefined();
  });

  it('never pins a gate from the database (its box key is compared first, SEC-32)', async () => {
    const db = new InMemorySyncTarget();
    const a = await desktop(db, base());
    await a.sync('push');
    const b = await desktop(db, { 'moat.yaml': RECIPE });
    const result = await b.sync('pull');
    expect(result).toMatchObject({
      status: 'done',
      secrets: 0,
      issues: [{ code: 'gate_not_pinned', gate: 'site' }],
    });
    expect(Object.keys(b.files)).toEqual(['moat.yaml']);
  });

  it('reports the same bundle version signed elsewhere and overwrites nothing (DT-13)', async () => {
    const db = new InMemorySyncTarget();
    const a = await desktop(db, base());
    const b = await desktop(db, base());
    await a.sign();
    await a.sync('push');
    // Signed at another time: the same version, other bytes.
    await b.sign(1_800_000_100);
    await b.sign(1_800_000_200);
    const before = structuredClone(db.project(KEY).bundles.get('site/1'));
    const push = await b.sync('push');
    expect(push).toMatchObject({ status: 'done', bundles: 0 });
    if (push.status !== 'done') throw new Error();
    expect(push.issues.map((issue) => issue.code)).toContain('bundle_conflict');
    expect(db.project(KEY).bundles.get('site/1')).toEqual(before);
    // And a higher version elsewhere is reported to the one behind.
    const c = await desktop(db, base());
    await a.sign();
    await a.sync('push');
    const fromC = await c.sync('push');
    if (fromC.status !== 'done') throw new Error();
    expect(fromC.issues.map((issue) => issue.code)).toContain(
      'bundle_newer_elsewhere',
    );
  });

  it('keeps both moat.yaml when both sides changed it', async () => {
    const db = new InMemorySyncTarget();
    const a = await desktop(db, base());
    await a.sync('push');
    const b = await desktop(db, base());
    await b.sync('pull');
    a.files['moat.yaml'] = `${RECIPE}# a\n`;
    await a.sync('push');
    b.files['moat.yaml'] = `${RECIPE}# b\n`;
    const pull = await b.sync('pull');
    expect(pull).toMatchObject({
      status: 'done',
      config: false,
      issues: [{ code: 'config_conflict' }],
    });
    expect(b.files['moat.yaml']).toBe(`${RECIPE}# b\n`);
    const push = await b.sync('push');
    expect(push).toMatchObject({
      config: false,
      issues: [{ code: 'config_conflict' }],
    });
    expect(db.project(KEY).config?.text).toBe(`${RECIPE}# a\n`);
  });

  it('writes nothing when the database changed between read and write', async () => {
    const db = new InMemorySyncTarget();
    const a = await desktop(db, base());
    await a.sync('push');
    a.files['moat.yaml'] = `${RECIPE}# next\n`;
    db.beforeWrite = () => {
      const config = db.project(KEY).config;
      if (config !== null && config !== undefined) config.revision += 1;
    };
    expect(await a.sync('push')).toEqual({ status: 'changed' });
    expect(db.project(KEY).config?.text).toBe(RECIPE);
  });

  it('passes a refused database on, and refuses a bad key or a missing project', async () => {
    const db = new InMemorySyncTarget();
    const a = await desktop(db, base());
    for (const code of [
      'foreign_tables',
      'schema_newer',
      'tls_required',
    ] as const) {
      db.refusal = code;
      expect(await a.sync('push')).toEqual({ status: 'refused', code });
    }
    db.refusal = null;
    const service = new DatabaseSyncService(
      new InMemoryProjectRegistry(),
      new InMemoryProjectFiles({}),
      db,
      new InMemorySyncState(),
      new HistoryService(
        new InMemoryProjectRegistry(),
        new InMemoryHistoryStore(),
      ),
    );
    const file = await key();
    const signer = { kid: file.kid, publicKey: fromBase64Url(file.pk) };
    expect(
      await service.sync('nope', {
        url: URL,
        key: KEY,
        direction: 'pull',
        signer,
      }),
    ).toEqual({ status: 'not_found' });
    const registry = new InMemoryProjectRegistry();
    const { id } = registry.add('/site');
    const keyed = new DatabaseSyncService(
      registry,
      new InMemoryProjectFiles({ '/site': base() }),
      db,
      new InMemorySyncState(),
      new HistoryService(registry, new InMemoryHistoryStore()),
    );
    expect(
      await keyed.sync(id, {
        url: URL,
        key: '../x',
        direction: 'push',
        signer,
      }),
    ).toEqual({ status: 'refused', code: 'key_invalid' });
  });
});
