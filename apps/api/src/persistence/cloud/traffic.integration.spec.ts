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
import { PrismaCloudTrafficStore } from './prisma-traffic.repository';
import { PrismaOrgProjectRepository } from './prisma-tenancy.repositories';

const AT = '2026-10-18T12:00:00.000Z';
const KEY = 'B'.repeat(43);

let pg: TestPostgres | null = null;
let folder: string;
beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'moat-traffic-db-'));
  pg = await startTestPostgres();
});
afterAll(async () => {
  await pg?.stop();
  rmSync(folder, { recursive: true, force: true });
});

for (const provider of ['sqlite', 'postgresql'] as const) {
  describe(`reported traffic on ${provider} (FR-50, T-110)`, () => {
    let database: CloudDatabase;
    let store: PrismaCloudProjectStore;
    let traffic: PrismaCloudTrafficStore;
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
      traffic = new PrismaCloudTrafficStore(database);
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

    const H = 1_798_675_200;
    const bucket = (hour: number, route: string | null, requests = 3) => ({
      hour,
      route,
      requests,
      s2: requests - 1,
      s3: 0,
      s4: 1,
      s5: 0,
      errors: { rate_limited: 1 },
      msTotal: 9_000_000_000,
      msMax: 400,
      receivedAt: AT,
    });

    it('replaces a bucket reported twice, drops old ones and goes with the gate', async () => {
      if (unavailable()) return;
      const a = await project();
      expect(await store.addGate(gate(a))).toBe('ok');
      expect(
        await traffic.setReportTokenHash(a, 'nope', 'a'.repeat(64), AT),
      ).toBe(false);
      expect(
        await traffic.setReportTokenHash(a, 'site', 'a'.repeat(64), AT),
      ).toBe(true);
      expect(
        await traffic.setReportTokenHash(a, 'site', 'b'.repeat(64), AT),
      ).toBe(true);
      expect(
        await traffic.findGateByReportTokenHash('a'.repeat(64)),
      ).toBeNull();
      expect(
        (await traffic.findGateByReportTokenHash('b'.repeat(64)))?.name,
      ).toBe('site');
      expect(await traffic.gatesWithReportAddress(a)).toEqual(['site']);

      await traffic.record(
        a,
        'site',
        [bucket(H - 7200, 'newsletter'), bucket(H, null)],
        0,
      );
      await traffic.record(a, 'site', [bucket(H, null, 5)], H - 3600);
      const rows = await traffic.traffic(a, 0);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        hour: H,
        route: null,
        requests: 5,
        msTotal: 9_000_000_000,
        errors: { rate_limited: 1 },
      });

      expect(await store.removeGate(a, 'site')).toBe(true);
      expect(await traffic.traffic(a, 0)).toEqual([]);
      expect(await traffic.gatesWithReportAddress(a)).toEqual([]);
    });

    it('refuses rows whose sums do not add up or whose hour is not on the hour', async () => {
      if (unavailable()) return;
      const a = await project();
      await store.addGate(gate(a));
      const insert = (hour: number, s2: number) =>
        raw(
          `INSERT INTO "cloud_traffic" ("project_id","gate","hour","route","requests","s2","s3","s4","s5","errors","ms_total","ms_max","received_at") VALUES ('${a}','site',${hour},'',2,${s2},0,0,0,'{}',1,1,'${AT}')`,
        );
      await expect(insert(H, 1)).rejects.toThrow();
      await expect(insert(H + 1, 2)).rejects.toThrow();
      await expect(insert(H, 2)).resolves.toBe(1);
    });
  });
}
