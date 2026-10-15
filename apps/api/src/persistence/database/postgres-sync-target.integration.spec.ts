import { toBase64Url, type PushPlan } from '@moat/core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLANTED_SECRETS } from '../../testing/planted-secrets';
import {
  SyncConflictError,
  type SyncSession,
} from '../../project/ports/sync-target.port';
import { PostgresSyncTarget } from './postgres-sync-target';
import {
  startTestPostgres,
  type TestPostgres,
} from './testing/postgres-cluster';

const AT = '2026-10-14T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const GATE = JSON.stringify({
  moat: 'gate',
  v: 1,
  gateId: 'A'.repeat(22),
  boxKey: toBase64Url(new Uint8Array(32).fill(7)),
});
const sealed = (secretVersion: number) =>
  JSON.stringify({
    v: 1,
    alg: 'x25519-blake2b-xchacha20poly1305',
    secretVersion,
    epk: toBase64Url(new Uint8Array(32).fill(1)),
    nonce: toBase64Url(new Uint8Array(24).fill(2)),
    ct: toBase64Url(new Uint8Array(40).fill(3)),
  });
const BUNDLE = JSON.stringify({
  moat: 'bundle',
  v: 1,
  payload: 'e30',
  sigs: [],
});

const plan = (overrides: Partial<PushPlan>): PushPlan => ({
  config: null,
  gates: [],
  secrets: [],
  bundles: [],
  issues: [],
  ...overrides,
});

let pg: TestPostgres | null = null;

beforeAll(async () => {
  pg = await startTestPostgres();
});

afterAll(async () => {
  await pg?.stop();
});

async function sql(url: string, text: string, values: unknown[] = []) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

describe.skipIf(process.env['MOAT_TEST_POSTGRES'] === 'off')(
  'PostgresSyncTarget on a real PostgreSQL (Prisma 7 + adapter-pg)',
  () => {
    async function open(url: string): Promise<SyncSession> {
      const opened = await new PostgresSyncTarget().open(url);
      if (opened.status !== 'open') throw new Error(opened.code);
      return opened.session;
    }

    it('migrates an empty database on connect, then writes and reads a project', async (context) => {
      if (pg === null) return context.skip();
      const url = await pg.database();
      const session = await open(url);
      try {
        await session.write(
          'shop',
          plan({
            config: {
              text: 'version: 1\n',
              hash: HASH,
              expectedRevision: null,
            },
            gates: [{ name: 'site', gateId: 'A'.repeat(22), text: GATE }],
            secrets: [
              {
                gate: 'site',
                name: 'token',
                secretVersion: 1,
                text: sealed(1),
                expectedVersion: null,
              },
            ],
            bundles: [{ gate: 'site', version: 1, digest: HASH, text: BUNDLE }],
          }),
          AT,
        );
        expect(await session.read('shop')).toEqual({
          config: { text: 'version: 1\n', hash: HASH, revision: 1 },
          gates: [{ name: 'site', text: GATE }],
          secrets: [
            { gate: 'site', name: 'token', secretVersion: 1, text: sealed(1) },
          ],
          bundles: [{ gate: 'site', version: 1, digest: HASH }],
        });
        expect(await session.bundleText('shop', 'site', 1)).toBe(BUNDLE);
        expect(await session.read('other')).toEqual({
          config: null,
          gates: [],
          secrets: [],
          bundles: [],
        });
      } finally {
        await session.close();
      }
      // A second connect finds the schema current.
      await (await open(url)).close();
      const applied = await sql(
        url,
        'SELECT migration_name FROM _prisma_migrations',
      );
      expect(applied.rows).toEqual([{ migration_name: '20261014120000_init' }]);
    });

    it('keeps the optimistic locks (DT-13): revision, secret version, bundle key', async (context) => {
      if (pg === null) return context.skip();
      const url = await pg.database();
      const session = await open(url);
      try {
        await session.write(
          'shop',
          plan({
            config: {
              text: 'version: 1\n',
              hash: HASH,
              expectedRevision: null,
            },
            bundles: [{ gate: 'site', version: 1, digest: HASH, text: BUNDLE }],
          }),
          AT,
        );
        await expect(
          session.write(
            'shop',
            plan({
              config: {
                text: 'version: 1\n#x\n',
                hash: 'b'.repeat(64),
                expectedRevision: 7,
              },
            }),
            AT,
          ),
        ).rejects.toBeInstanceOf(SyncConflictError);
        await expect(
          session.write(
            'shop',
            plan({
              config: {
                text: 'version: 1\n#y\n',
                hash: 'c'.repeat(64),
                expectedRevision: 1,
              },
              bundles: [
                {
                  gate: 'site',
                  version: 1,
                  digest: 'd'.repeat(64),
                  text: BUNDLE,
                },
              ],
            }),
            AT,
          ),
        ).rejects.toBeInstanceOf(SyncConflictError);
        // The whole transaction rolled back: moat.yaml unchanged too.
        expect((await session.read('shop')).config?.revision).toBe(1);
      } finally {
        await session.close();
      }
      await expect(
        sql(url, `UPDATE sync_bundle SET text = $1`, [BUNDLE]),
      ).rejects.toThrow(/never changed/);
    });

    it('refuses a plaintext secret even when written past Moat (CHECK, SEC-31)', async (context) => {
      if (pg === null) return context.skip();
      const url = await pg.database();
      await (await open(url)).close();
      await sql(
        url,
        `INSERT INTO sync_project (key, config_text, config_hash, revision, updated_at) VALUES ('shop', '', $1, 1, $2)`,
        [HASH, AT],
      );
      for (const text of [
        PLANTED_SECRETS[0],
        JSON.stringify({ value: PLANTED_SECRETS[0] }),
        JSON.stringify({
          alg: 'x25519-blake2b-xchacha20poly1305',
          secretVersion: 2,
        }),
      ])
        await expect(
          sql(
            url,
            `INSERT INTO sync_secret (project, gate, name, secret_version, text) VALUES ('shop', 'site', 'token', 1, $1)`,
            [text],
          ),
        ).rejects.toThrow();
      const rows = await sql(url, 'SELECT count(*)::int AS n FROM sync_secret');
      expect(rows.rows[0]).toEqual({ n: 0 });
    });

    it('refuses a database with foreign tables or a newer schema, changing nothing', async (context) => {
      if (pg === null) return context.skip();
      const foreign = await pg.database();
      await sql(foreign, 'CREATE TABLE customers (id integer)');
      expect(await new PostgresSyncTarget().open(foreign)).toEqual({
        status: 'refused',
        code: 'foreign_tables',
      });
      const tables = await sql(
        foreign,
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`,
      );
      expect(tables.rows).toEqual([{ table_name: 'customers' }]);

      const newer = await pg.database();
      await (await open(newer)).close();
      await sql(
        newer,
        `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES ('x', $1, now(), '20991231000000_future', now(), 1)`,
        ['f'.repeat(64)],
      );
      expect(await new PostgresSyncTarget().open(newer)).toEqual({
        status: 'refused',
        code: 'schema_newer',
      });

      const damaged = await pg.database();
      await sql(damaged, 'CREATE TABLE sync_project (key text)');
      expect(await new PostgresSyncTarget().open(damaged)).toEqual({
        status: 'refused',
        code: 'schema_damaged',
      });
    });

    it('answers connect_failed without the driver message, and tls_required before connecting', async () => {
      expect(
        await new PostgresSyncTarget().open(
          'postgresql://moat:x@127.0.0.1:1/moat',
        ),
      ).toEqual({ status: 'refused', code: 'connect_failed' });
      expect(
        await new PostgresSyncTarget().open(
          'postgresql://moat:x@db.example.invalid/moat?sslmode=disable',
        ),
      ).toEqual({ status: 'refused', code: 'tls_required' });
    });
  },
);
