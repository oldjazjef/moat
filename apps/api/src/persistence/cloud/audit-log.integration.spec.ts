import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AuditEvent, chainAudit, verifyAudit } from '@moat/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditTrail } from '../../cloud/audit/application/audit-trail';
import { newId } from '../../cloud/common/clock';
import { FixedClock } from '../../cloud/testing/in-memory';
import {
  startTestPostgres,
  type TestPostgres,
} from '../database/testing/postgres-cluster';
import { CloudDatabase } from './cloud-database';
import { PrismaAuditLogRepository } from './prisma-audit.repository';

const AT = '2026-10-17T12:00:00.000Z';
const SHA = 'a'.repeat(64);
const created = (org: string): AuditEvent => ({
  action: 'org.create',
  target: org,
  details: {},
});

let pg: TestPostgres | null = null;
let folder: string;
beforeAll(async () => {
  folder = mkdtempSync(join(tmpdir(), 'moat-audit-db-'));
  pg = await startTestPostgres();
});
afterAll(async () => {
  await pg?.stop();
  rmSync(folder, { recursive: true, force: true });
});

for (const provider of ['sqlite', 'postgresql'] as const) {
  describe(`audit log on ${provider} (SEC-53)`, () => {
    let database: CloudDatabase;
    let log: PrismaAuditLogRepository;
    // No PostgreSQL server on this machine and no MOAT_TEST_POSTGRES_URL: the specs return early.
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
      log = new PrismaAuditLogRepository(database);
    });
    afterAll(async () => {
      if (!unavailable()) await database.client.$disconnect();
    });

    it('takes the action `gate.remove` into the chain (T-87)', async () => {
      if (unavailable()) return;
      const org = newId();
      const actor = newId();
      const trail = new AuditTrail(log, new FixedClock());
      await trail.record(org, actor, created(org));
      await trail.record(org, actor, {
        action: 'gate.remove',
        target: newId(),
        details: { gate: 'site' },
      });
      const rows = await log.list(org, 0, 10);
      expect(rows.map((r) => r.action)).toEqual(['org.create', 'gate.remove']);
      expect(await verifyAudit(org, rows, await log.head(org))).toEqual({
        status: 'intact',
        entries: 2,
      });
    });

    it('appends, reads back in order and verifies the chain it stored', async () => {
      if (unavailable()) return;
      const org = newId();
      const actor = newId();
      const trail = new AuditTrail(log, new FixedClock());
      await trail.record(org, actor, created(org));
      await trail.record(org, actor, {
        action: 'member.add_requested',
        target: null,
        details: { role: 'viewer', emailHash: SHA },
      });
      await trail.record(org, actor, {
        action: 'project.delete',
        target: newId(),
        details: {},
      });
      const rows = await log.list(org, 0, 100);
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
      expect((await log.head(org))?.seq).toBe(3);
      expect(await verifyAudit(org, rows, null)).toMatchObject({
        status: 'intact',
        entries: 3,
      });
      expect((await log.list(org, 1, 1)).map((r) => r.seq)).toEqual([2]);
      expect(await log.head(newId())).toBeNull();
      expect(await log.list(newId(), 0, 10)).toEqual([]);
    });

    it('reports a taken seq as a conflict, and concurrent writers still end up with a gap-free chain', async () => {
      if (unavailable()) return;
      const org = newId();
      const actor = newId();
      const first = await chainAudit(null, org, AT, actor, created(org));
      expect(await log.append(first)).toBe('ok');
      const again = await chainAudit(null, org, AT, actor, created(org));
      expect(await log.append(again)).toBe('conflict');
      const trail = new AuditTrail(log, new FixedClock());
      await Promise.all(
        Array.from({ length: 6 }, () =>
          trail.record(org, actor, {
            action: 'project.create',
            target: newId(),
            details: {},
          }),
        ),
      );
      const rows = await log.list(org, 0, 100);
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(await verifyAudit(org, rows, null)).toMatchObject({
        status: 'intact',
      });
    });

    it('keeps organisations apart: the same seq in two chains, neither sees the other', async () => {
      if (unavailable()) return;
      const [a, b] = [newId(), newId()];
      const actor = newId();
      await new AuditTrail(log, new FixedClock()).record(a, actor, created(a));
      await new AuditTrail(log, new FixedClock()).record(b, actor, created(b));
      expect((await log.list(a, 0, 10)).map((r) => r.organisationId)).toEqual([
        a,
      ]);
      expect((await log.list(b, 0, 10)).map((r) => r.organisationId)).toEqual([
        b,
      ]);
    });

    it('refuses every UPDATE and DELETE in the database, and TRUNCATE on PostgreSQL', async () => {
      if (unavailable()) return;
      const org = newId();
      await new AuditTrail(log, new FixedClock()).record(
        org,
        newId(),
        created(org),
      );
      await expect(
        raw(`UPDATE "audit_entry" SET "actor" = '${newId()}'`),
      ).rejects.toThrow();
      await expect(
        raw(`DELETE FROM "audit_entry" WHERE "organisation_id" = '${org}'`),
      ).rejects.toThrow();
      if (provider === 'postgresql')
        await expect(raw(`TRUNCATE "audit_entry"`)).rejects.toThrow();
      expect(await log.list(org, 0, 10)).toHaveLength(1);
    });

    it('refuses in the database what the application never writes (CHECK constraints)', async () => {
      if (unavailable()) return;
      const org = newId();
      const base = await chainAudit(null, org, AT, newId(), created(org));
      const insert = (
        patch: Partial<Record<string, string | number | null>>,
      ) => {
        const row: Record<string, string | number | null> = {
          organisation_id: base.organisationId,
          seq: base.seq,
          at: base.at,
          actor: base.actor,
          action: base.action,
          target: base.target,
          details: base.details,
          prev_hash: base.prevHash,
          hash: base.hash,
          ...patch,
        };
        const value = (v: string | number | null) =>
          v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`;
        return raw(
          `INSERT INTO "audit_entry" (${Object.keys(row)
            .map((k) => `"${k}"`)
            .join(',')}) VALUES (${Object.values(row).map(value).join(',')})`,
        );
      };
      await expect(insert({ action: 'org.delete' })).rejects.toThrow();
      await expect(insert({ seq: 0 })).rejects.toThrow();
      await expect(insert({ at: '2026-10-17' })).rejects.toThrow();
      await expect(insert({ actor: 'short' })).rejects.toThrow();
      await expect(insert({ target: 'short' })).rejects.toThrow();
      await expect(insert({ details: '[]' })).rejects.toThrow();
      await expect(insert({ details: 'not json' })).rejects.toThrow();
      await expect(
        insert({ details: `{"x":"${'y'.repeat(1100)}"}` }),
      ).rejects.toThrow();
      await expect(insert({ prev_hash: 'ABC' })).rejects.toThrow();
      await expect(insert({ hash: 'G'.repeat(64) })).rejects.toThrow();
      expect(await log.list(org, 0, 10)).toEqual([]);
      await insert({});
      expect(await log.list(org, 0, 10)).toHaveLength(1);
    });
  });
}

describe('the migration that adds `gate.remove` on SQLite', () => {
  it('keeps the rows and their hashes and the append-only triggers of a log that already exists', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { MIGRATIONS } = await import('../database/migrations');
    const db = new DatabaseSync(':memory:');
    const all = MIGRATIONS.sqlite;
    const at = all.findIndex(
      (m) => m.name === '20261020120000_audit_gate_remove',
    );
    expect(at).toBeGreaterThan(0);
    const last = all[at];
    for (const m of all.slice(0, at)) db.exec(m.sql);
    const org = newId();
    const insert = db.prepare(
      'INSERT INTO audit_entry (organisation_id, seq, at, actor, action, target, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run(
      org,
      1,
      AT,
      newId(),
      'org.create',
      org,
      '{}',
      '0'.repeat(64),
      SHA,
    );
    expect(() =>
      insert.run(
        org,
        2,
        AT,
        newId(),
        'gate.remove',
        org,
        '{}',
        SHA,
        'b'.repeat(64),
      ),
    ).toThrow(/CHECK/);

    db.exec(last?.sql ?? '');

    expect(
      db.prepare('SELECT seq, action, hash FROM audit_entry').all(),
    ).toEqual([{ seq: 1, action: 'org.create', hash: SHA }]);
    insert.run(
      org,
      2,
      AT,
      newId(),
      'gate.remove',
      org,
      '{}',
      SHA,
      'b'.repeat(64),
    );
    expect(() => db.exec('UPDATE audit_entry SET seq = 9')).toThrow(
      /append-only/,
    );
    expect(() => db.exec('DELETE FROM audit_entry')).toThrow(/append-only/);
    expect(() =>
      insert.run(org, 3, AT, newId(), 'org.create', org, '{}', SHA, SHA),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});
