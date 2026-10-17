import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../cloud/common/clock';
import type { GateRecord } from '../../cloud/gates/ports/gates.ports';
import {
  startTestPostgres,
  type TestPostgres,
} from '../database/testing/postgres-cluster';
import { CloudDatabase } from './cloud-database';
import { PrismaCloudProjectStore } from './prisma-gates.repository';
import { PrismaOrgProjectRepository } from './prisma-tenancy.repositories';

const AT = '2026-10-18T12:00:00.000Z';
const KEY = 'B'.repeat(43);
const SEALED = (version: number) =>
  JSON.stringify({
    v: 1,
    alg: 'x25519-blake2b-xchacha20poly1305',
    secretVersion: version,
    epk: 'E'.repeat(43),
    nonce: 'N'.repeat(32),
    ct: 'C'.repeat(40),
  });
const ENVELOPE = JSON.stringify({
  moat: 'bundle',
  v: 1,
  payload: 'AAAA',
  sigs: [],
});

let pg: TestPostgres | null = null;
let folder: string;
beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'moat-gates-db-'));
  pg = await startTestPostgres();
});
afterAll(async () => {
  await pg?.stop();
  rmSync(folder, { recursive: true, force: true });
});

for (const provider of ['sqlite', 'postgresql'] as const) {
  describe(`cloud project store on ${provider} (Prisma 7)`, () => {
    let database: CloudDatabase;
    let store: PrismaCloudProjectStore;
    let projects: PrismaOrgProjectRepository;
    const unavailable = () => provider === 'postgresql' && pg === null;
    const raw = (text: string) => database.client.$executeRawUnsafe(text);

    beforeAll(async () => {
      if (unavailable()) return;
      database =
        provider === 'sqlite'
          ? await CloudDatabase.open({
              provider,
              dataDir: mkdtempSync(join(folder, 'db-')),
            })
          : await CloudDatabase.open({
              provider,
              dataDir: folder,
              databaseUrl: await (pg as TestPostgres).database(),
            });
      store = new PrismaCloudProjectStore(database);
      projects = new PrismaOrgProjectRepository(database);
    });
    afterAll(async () => {
      if (!unavailable()) await database.client.$disconnect();
    });

    async function project(): Promise<string> {
      const org = newId();
      await raw(
        `INSERT INTO "organisation" ("id","name","created_at") VALUES ('${org}','O','${AT}')`,
      );
      const id = newId();
      await projects.create({
        id,
        organisationId: org,
        name: 'P',
        createdAt: AT,
      });
      return id;
    }
    const gate = (
      projectId: string,
      name = 'site',
      patch: Partial<GateRecord> = {},
    ): GateRecord => ({
      projectId,
      name,
      gateId: newId(),
      boxKey: KEY,
      mode: 'managed',
      signerKid: null,
      signerKey: null,
      pullTokenHash: null,
      createdAt: AT,
      ...patch,
    });

    it('writes moat.yaml by compare-and-set on the revision', async () => {
      if (unavailable()) return;
      const id = await project();
      expect(await store.getConfig(id)).toBeNull();
      expect(await store.setConfig(id, 'a', 0, AT)).toBe('ok');
      expect(await store.setConfig(id, 'b', 0, AT)).toBe('conflict');
      expect(await store.setConfig(id, 'b', 1, AT)).toBe('ok');
      expect(await store.setConfig(id, 'c', 1, AT)).toBe('conflict');
      expect(await store.getConfig(id)).toMatchObject({
        text: 'b',
        revision: 2,
      });
      const race = await Promise.all([
        store.setConfig(id, 'x', 2, AT),
        store.setConfig(id, 'y', 2, AT),
      ]);
      expect(race.sort()).toEqual(['conflict', 'ok']);
    });

    it('keeps gates, secrets and bundles of a project apart and removes them with the project', async () => {
      if (unavailable()) return;
      const a = await project();
      const b = await project();
      expect(await store.addGate(gate(a))).toBe('ok');
      expect(await store.addGate(gate(a))).toBe('exists');
      expect(await store.addGate(gate(b))).toBe('ok');
      expect(await store.listGates(a)).toHaveLength(1);
      expect(await store.findGate(a, 'nope')).toBeNull();
      expect(
        await store.putSecret({
          projectId: a,
          gate: 'site',
          name: 'k',
          secretVersion: 1,
          text: SEALED(1),
          updatedAt: AT,
        }),
      ).toBe('ok');
      expect(await store.listSecrets(b, 'site')).toEqual([]);
      expect(
        await store.addBundle({
          projectId: a,
          gate: 'site',
          version: 1,
          digest: 'a'.repeat(64),
          text: ENVELOPE,
          createdAt: AT,
        }),
      ).toBe('ok');
      expect((await store.latestBundle(a, 'site'))?.version).toBe(1);
      expect(await store.latestBundle(b, 'site')).toBeNull();
      await projects.delete(
        (
          await database.client.orgProject.findUniqueOrThrow({
            where: { id: a },
          })
        ).organisationId,
        a,
      );
      expect(await store.listGates(a)).toEqual([]);
      expect(await store.latestBundle(a, 'site')).toBeNull();
      expect(await store.listSecrets(a, 'site')).toEqual([]);
      expect(await store.listGates(b)).toHaveLength(1);
    });

    it('replaces a secret only by a higher version, atomically', async () => {
      if (unavailable()) return;
      const id = await project();
      await store.addGate(gate(id));
      const put = (version: number) =>
        store.putSecret({
          projectId: id,
          gate: 'site',
          name: 'k',
          secretVersion: version,
          text: SEALED(version),
          updatedAt: AT,
        });
      expect(await put(2)).toBe('ok');
      expect(await put(2)).toBe('stale');
      expect(await put(1)).toBe('stale');
      expect(await put(3)).toBe('ok');
      expect((await store.listSecrets(id, 'site'))[0]).toMatchObject({
        secretVersion: 3,
      });
      const race = await Promise.all([put(4), put(4)]);
      expect(race.sort()).toEqual(['ok', 'stale']);
      expect(
        await store.putSecret({
          projectId: id,
          gate: 'nogate',
          name: 'k',
          secretVersion: 1,
          text: SEALED(1),
          updatedAt: AT,
        }),
      ).toBe('no_gate');
    });

    it('never replaces a bundle: a version is taken once, and the database refuses an UPDATE', async () => {
      if (unavailable()) return;
      const id = await project();
      await store.addGate(gate(id));
      const bundle = {
        projectId: id,
        gate: 'site',
        version: 1,
        digest: 'a'.repeat(64),
        text: ENVELOPE,
        createdAt: AT,
      };
      expect(await store.addBundle(bundle)).toBe('ok');
      expect(
        await store.addBundle({
          ...bundle,
          text: ENVELOPE.replace('AAAA', 'BBBB'),
        }),
      ).toBe('exists');
      await expect(
        raw(`UPDATE "cloud_bundle" SET "digest" = '${'b'.repeat(64)}'`),
      ).rejects.toThrow();
      expect((await store.latestBundle(id, 'site'))?.text).toBe(ENVELOPE);
    });

    it('finds a gate by the hash of its pull token, one gate per hash', async () => {
      if (unavailable()) return;
      const id = await project();
      await store.addGate(gate(id, 'one'));
      await store.addGate(gate(id, 'two'));
      const hash = 'c'.repeat(64);
      expect(await store.setPullTokenHash(id, 'one', hash)).toBe(true);
      expect((await store.findGateByPullTokenHash(hash))?.name).toBe('one');
      await expect(store.setPullTokenHash(id, 'two', hash)).rejects.toThrow();
      expect(await store.setPullTokenHash(id, 'nope', 'd'.repeat(64))).toBe(
        false,
      );
      expect(await store.findGateByPullTokenHash('e'.repeat(64))).toBeNull();
    });

    it('refuses in the database what the application never writes (CHECK constraints)', async () => {
      if (unavailable()) return;
      const id = await project();
      const insertGate = (cols: Record<string, string | null>) => {
        const row: Record<string, string | null> = {
          project_id: id,
          name:
            'g' +
            newId()
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '')
              .slice(0, 8),
          gate_id: newId(),
          box_key: KEY,
          mode: 'managed',
          signer_kid: null,
          signer_key: null,
          pull_token_hash: null,
          created_at: AT,
          ...cols,
        };
        const value = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);
        return raw(
          `INSERT INTO "cloud_gate" (${Object.keys(row)
            .map((k) => `"${k}"`)
            .join(',')}) VALUES (${Object.values(row).map(value).join(',')})`,
        );
      };
      await insertGate({});
      await expect(insertGate({ mode: 'cloud' })).rejects.toThrow();
      await expect(insertGate({ name: 'Bad_Name' })).rejects.toThrow();
      await expect(insertGate({ gate_id: 'short' })).rejects.toThrow();
      await expect(insertGate({ box_key: 'short' })).rejects.toThrow();
      await expect(insertGate({ pull_token_hash: 'zz' })).rejects.toThrow();
      // A signed gate carries its key and key id, a managed gate neither.
      await expect(insertGate({ mode: 'signed' })).rejects.toThrow();
      await expect(
        insertGate({ signer_key: KEY, signer_kid: 'K'.repeat(22) }),
      ).rejects.toThrow();
      await insertGate({
        mode: 'signed',
        signer_key: KEY,
        signer_kid: 'K'.repeat(22),
      });
      // A secret must be a sealed secret of the version it says (ciphertext only, SEC-31).
      const insertSecret = (text: string, version = 1) =>
        raw(
          `INSERT INTO "cloud_secret" ("project_id","gate","name","secret_version","text","updated_at") VALUES ('${id}','${'x'}','k',${version},'${text.replace(/'/g, "''")}','${AT}')`,
        );
      await store.addGate(gate(id, 'x'));
      await expect(insertSecret('plain text secret')).rejects.toThrow();
      await expect(insertSecret('{"alg":"rot13"}')).rejects.toThrow();
      await expect(insertSecret(SEALED(2), 1)).rejects.toThrow();
      await expect(insertSecret(SEALED(0), 0)).rejects.toThrow();
      await insertSecret(SEALED(1), 1);
      // A bundle is an envelope, nothing else.
      const insertBundle = (text: string) =>
        raw(
          `INSERT INTO "cloud_bundle" ("project_id","gate","version","digest","text","created_at") VALUES ('${id}','x',9,'${'a'.repeat(64)}','${text.replace(/'/g, "''")}','${AT}')`,
        );
      await expect(insertBundle('not json')).rejects.toThrow();
      await expect(insertBundle('{"moat":"gate"}')).rejects.toThrow();
      await insertBundle(ENVELOPE);
    });
  });
}
