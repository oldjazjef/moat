import type { DatabaseSync } from 'node:sqlite';
import type { Client } from 'pg';
import { MIGRATIONS_TABLE } from './migrations';
import type { MigrationConnection } from './migrator';

/** Prisma's own `_prisma_migrations` (SQLite flavour). */
const SQLITE_MIGRATIONS = `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

/** Prisma's own `_prisma_migrations` (PostgreSQL flavour). */
const POSTGRES_MIGRATIONS = `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
    "id"                    VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum"              VARCHAR(64) NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        VARCHAR(255) NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count"   INTEGER NOT NULL DEFAULT 0
)`;

interface AppliedRow {
  migration_name: string;
  checksum: string;
  finished_at: unknown;
  rolled_back_at: unknown;
}

const APPLIED = `SELECT "migration_name", "checksum", "finished_at", "rolled_back_at" FROM "${MIGRATIONS_TABLE}" ORDER BY "started_at"`;

function toApplied(rows: AppliedRow[]) {
  return rows.map((row) => ({
    name: row.migration_name,
    checksum: row.checksum,
    finished: row.finished_at !== null,
    rolledBack: row.rolled_back_at !== null,
  }));
}

/** A SQLite file (node:sqlite): BEGIN IMMEDIATE takes the write lock for the whole run. */
export function sqliteMigrationConnection(
  db: DatabaseSync,
): MigrationConnection {
  return {
    async exclusive(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    tables: () =>
      Promise.resolve(
        (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
            )
            .all() as { name: string }[]
        ).map((row) => row.name),
      ),
    applied: () =>
      Promise.resolve(
        toApplied(db.prepare(APPLIED).all() as unknown as AppliedRow[]),
      ),
    createMigrationsTable: () => {
      db.exec(SQLITE_MIGRATIONS);
      return Promise.resolve();
    },
    execScript: (sql) => {
      db.exec(sql);
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0)
        throw new Error('foreign_key_check reports violations');
      return Promise.resolve();
    },
    record: (migration, id, at) => {
      db.prepare(
        `INSERT INTO "${MIGRATIONS_TABLE}" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count") VALUES (?, ?, ?, ?, NULL, NULL, ?, 1)`,
      ).run(
        id,
        migration.checksum,
        at.toISOString(),
        migration.name,
        at.toISOString(),
      );
      return Promise.resolve();
    },
  };
}

/** An arbitrary 64-bit number: Moat's advisory lock, so two desktops never migrate at once. */
const ADVISORY_LOCK = '7239861235441';

/**
 * A PostgreSQL connection (`pg`): one transaction holding a transaction-level advisory lock, in
 * the connection's current schema only.
 */
export function postgresMigrationConnection(
  client: Client,
): MigrationConnection {
  return {
    async exclusive(work) {
      await client.query('BEGIN');
      try {
        await client.query(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK})`);
        const result = await work();
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
    async tables() {
      const result = await client.query<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()`,
      );
      return result.rows.map((row) => row.name);
    },
    async applied() {
      return toApplied((await client.query<AppliedRow>(APPLIED)).rows);
    },
    async createMigrationsTable() {
      await client.query(POSTGRES_MIGRATIONS);
    },
    async execScript(sql) {
      await client.query(sql);
    },
    async record(migration, id, at) {
      await client.query(
        `INSERT INTO "${MIGRATIONS_TABLE}" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count") VALUES ($1, $2, $3, $4, NULL, NULL, $3, 1)`,
        [id, migration.checksum, at.toISOString(), migration.name],
      );
    },
  };
}
