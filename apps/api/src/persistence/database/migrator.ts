import { randomUUID } from 'node:crypto';
import { MIGRATIONS_TABLE, MOAT_TABLES, type Migration } from './migrations';

/**
 * Brings a database to Moat's schema without the Prisma CLI (as lazy-koins' desktop does): the
 * migrations apply in name order, each once, in one transaction, and are recorded in a
 * `_prisma_migrations`-compatible table (checksum = SHA-256 of the file), so `prisma migrate
 * status` agrees.
 *
 * Eme's decisions (14.10.2026): a database without Moat's structure is migrated automatically on
 * connect. Moat refuses — and changes nothing — when the database
 *   - holds tables that are not Moat's (`foreign_tables`): it is someone else's database,
 *   - records a migration this app does not know (`schema_newer`): a newer Moat set it up,
 *   - has Moat tables without their record, a failed migration, or a changed one
 *     (`schema_damaged`).
 */
export type SchemaRefusal =
  'foreign_tables' | 'schema_newer' | 'schema_damaged';

export class SchemaRefusedError extends Error {
  override readonly name = 'SchemaRefusedError';
  constructor(readonly code: SchemaRefusal) {
    super(code);
  }
}

/** What the migrator needs of a connection; one implementation per dialect. */
export interface MigrationConnection {
  /** Runs `work` in one transaction that also keeps a second migrator out (lock). */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /** The names of the tables in the connection's schema, without the engine's own. */
  tables(): Promise<string[]>;
  /** The recorded migrations. */
  applied(): Promise<
    {
      name: string;
      checksum: string;
      finished: boolean;
      rolledBack: boolean;
    }[]
  >;
  createMigrationsTable(): Promise<void>;
  /** A whole migration file (several statements). */
  execScript(sql: string): Promise<void>;
  record(migration: Migration, id: string, at: Date): Promise<void>;
}

/** Applies the pending migrations; returns their names (empty: the schema was current). */
export async function migrate(
  connection: MigrationConnection,
  migrations: readonly Migration[],
  now: () => Date = () => new Date(),
): Promise<string[]> {
  return connection.exclusive(async () => {
    const tables = await connection.tables();
    const known = new Set<string>([...MOAT_TABLES, MIGRATIONS_TABLE]);
    if (tables.some((table) => !known.has(table)))
      throw new SchemaRefusedError('foreign_tables');

    const ours = new Map(migrations.map((m) => [m.name, m]));
    let applied: Awaited<ReturnType<MigrationConnection['applied']>> = [];
    if (tables.includes(MIGRATIONS_TABLE)) applied = await connection.applied();
    else if (tables.length > 0) throw new SchemaRefusedError('schema_damaged');

    const done = new Set<string>();
    for (const row of applied) {
      if (row.rolledBack) continue;
      const migration = ours.get(row.name);
      if (migration === undefined) throw new SchemaRefusedError('schema_newer');
      if (!row.finished || row.checksum !== migration.checksum)
        throw new SchemaRefusedError('schema_damaged');
      done.add(row.name);
    }
    // The applied ones must be a prefix of the history: no gap before a later one.
    const pending = migrations.filter((m) => !done.has(m.name));
    const firstPending = migrations.findIndex((m) => !done.has(m.name));
    if (
      firstPending !== -1 &&
      migrations.slice(firstPending).some((m) => done.has(m.name))
    )
      throw new SchemaRefusedError('schema_damaged');
    if (pending.length === 0) return [];

    await connection.createMigrationsTable();
    for (const migration of pending) {
      await connection.execScript(migration.sql);
      await connection.record(migration, randomUUID(), now());
    }
    return pending.map((m) => m.name);
  });
}
