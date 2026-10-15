import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConfigService } from '@nestjs/config';
import { chainHistory, verifyHistory, type HistoryRow } from '@moat/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../config/env';
import { PLANTED_SECRETS } from '../../testing/planted-secrets';
import { HistoryConflictError } from '../../project/ports/history-store.port';
import { sqliteMigrationConnection } from './migration-connections';
import { MIGRATIONS } from './migrations';
import { migrate, SchemaRefusedError } from './migrator';
import { SqliteHistoryStore } from './sqlite-history-store';

const ID = 'historyProject00000000';
const AT = '2026-10-14T12:00:00.000Z';

describe('SqliteHistoryStore on a real SQLite file (node:sqlite + Prisma 7)', () => {
  let data: string;
  let store: SqliteHistoryStore;

  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'moat-history-'));
    store = new SqliteHistoryStore({
      get: () => data,
    } as unknown as ConfigService<Env, true>);
  });

  afterEach(async () => {
    await store.onApplicationShutdown();
    rmSync(data, { recursive: true, force: true });
  });

  async function append(count: number): Promise<HistoryRow[]> {
    const rows: HistoryRow[] = [];
    for (let i = 0; i < count; i++) {
      const row = await chainHistory(rows.at(-1) ?? null, AT, {
        kind: 'secret_sealed',
        details: { gate: 'site', name: 'token', secretVersion: i + 1 },
      });
      await store.append(ID, row);
      rows.push(row);
    }
    return rows;
  }

  it('is off until enabled, then keeps rows and the anchor', async () => {
    expect(store.enabled(ID)).toBe(false);
    expect(await store.list(ID)).toEqual([]);
    await store.enable(ID);
    expect(store.enabled(ID)).toBe(true);
    const rows = await append(3);
    expect(await store.list(ID)).toEqual(rows);
    const last = rows[2];
    if (last === undefined) throw new Error('no rows');
    expect(store.anchor(ID)).toEqual({ seq: 3, hash: last.hash });
    expect(await verifyHistory(await store.list(ID), store.anchor(ID))).toEqual(
      { status: 'intact', entries: 3 },
    );
    await expect(store.append(ID, last)).rejects.toBeInstanceOf(
      HistoryConflictError,
    );
  });

  it('refuses UPDATE and DELETE (triggers), and verify finds a row changed behind its back', async () => {
    await store.enable(ID);
    const rows = await append(3);
    await store.onApplicationShutdown();
    const db = new DatabaseSync(join(data, 'history', `${ID}.db`));
    expect(() =>
      db.exec(`UPDATE history_entry SET details = '{}' WHERE seq = 2`),
    ).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM history_entry')).toThrow(/append-only/);
    // An attacker with the file drops the triggers first.
    db.exec('DROP TRIGGER history_entry_no_update');
    db.exec(
      `UPDATE history_entry SET details = '{"gate":"site","name":"token","secretVersion":9}' WHERE seq = 2`,
    );
    db.close();
    const check = await verifyHistory(await store.list(ID), store.anchor(ID));
    expect(check).toMatchObject({ status: 'broken', seq: 2, reason: 'hash' });
    expect(rows).toHaveLength(3);
  });

  it('enforces the CHECK constraints even for writes outside Moat', async () => {
    await store.enable(ID);
    await store.onApplicationShutdown();
    const db = new DatabaseSync(join(data, 'history', `${ID}.db`));
    const insert = (kind: string, details: string, hash: string) =>
      db
        .prepare(
          'INSERT INTO history_entry (seq, at, kind, details, prev_hash, hash) VALUES (1, ?, ?, ?, ?, ?)',
        )
        .run(AT, kind, details, '0'.repeat(64), hash);
    expect(() => insert('secret_value', '{}', 'a'.repeat(64))).toThrow(/CHECK/);
    expect(() => insert('deploy', 'not json', 'a'.repeat(64))).toThrow(/CHECK/);
    expect(() => insert('deploy', '{}', 'XYZ')).toThrow(/CHECK/);
    // The same file's sync tables take ciphertext only (SEC-31).
    db.exec(
      `INSERT INTO sync_project (key, config_text, config_hash, revision, updated_at) VALUES ('shop', '', '${'a'.repeat(64)}', 1, '${AT}')`,
    );
    for (const text of [
      PLANTED_SECRETS[0],
      JSON.stringify({ value: PLANTED_SECRETS[0] }),
      JSON.stringify({
        alg: 'x25519-blake2b-xchacha20poly1305',
        secretVersion: 1,
      }),
    ])
      expect(() =>
        db
          .prepare(
            `INSERT INTO sync_secret (project, gate, name, secret_version, text) VALUES ('shop', 'site', 'token', 1, ?)`,
          )
          .run(text),
      ).toThrow(/CHECK|JSON/);
    db.close();
  });

  it('refuses a file holding foreign tables or a newer schema, changing nothing', async () => {
    const dir = join(data, 'history');
    await store.enable(ID);
    await store.onApplicationShutdown();
    const other = join(dir, 'other.db');
    const foreign = new DatabaseSync(other);
    foreign.exec('CREATE TABLE customers (id INTEGER)');
    await expect(
      migrate(sqliteMigrationConnection(foreign), MIGRATIONS.sqlite),
    ).rejects.toMatchObject({ code: 'foreign_tables' });
    foreign.close();

    const newer = new DatabaseSync(join(dir, `${ID}.db`));
    newer
      .prepare(
        'INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, ?, 1)',
      )
      .run('x', 'f'.repeat(64), AT, '20991231000000_future', AT);
    let error: unknown;
    try {
      await migrate(sqliteMigrationConnection(newer), MIGRATIONS.sqlite);
    } catch (caught) {
      error = caught;
    }
    newer.close();
    expect(error).toBeInstanceOf(SchemaRefusedError);
    expect((error as SchemaRefusedError).code).toBe('schema_newer');
  });

  it('reads a damaged anchor as one that does not match', async () => {
    await store.enable(ID);
    await append(1);
    writeFileSync(join(data, 'history', `${ID}.anchor.json`), 'garbage');
    expect(
      await verifyHistory(await store.list(ID), store.anchor(ID)),
    ).toMatchObject({ status: 'broken', reason: 'anchor' });
  });
});
