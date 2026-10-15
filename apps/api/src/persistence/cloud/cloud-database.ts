import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OnApplicationShutdown } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client } from 'pg';
import { PrismaClient as PostgresClient } from '../../generated/prisma-postgresql/client';
import { PrismaClient as SqliteClient } from '../../generated/prisma-sqlite/client';
import {
  postgresMigrationConnection,
  sqliteMigrationConnection,
} from '../database/migration-connections';
import { parseDatabaseUrl } from '../database/database-url';
import { MIGRATIONS } from '../database/migrations';
import { migrate } from '../database/migrator';
import { PrismaNodeSqlite } from '../database/node-sqlite-adapter';

/**
 * The client the Cloud repositories use. Both generated clients come from structurally equal
 * schemas (database-schemas.spec.ts), so the PostgreSQL client is used through the SQLite client's
 * type: one set of repositories for both providers.
 */
export type CloudClient = InstanceType<typeof SqliteClient>;

export interface CloudDatabaseOptions {
  readonly provider: 'sqlite' | 'postgresql';
  /** SQLite: the file is `<dataDir>/cloud.db`. */
  readonly dataDir: string;
  /** PostgreSQL only; TLS required but for this machine (database-url.ts). */
  readonly databaseUrl?: string;
}

/**
 * The Cloud's database (AUTH_MODE=cloud): migrated to the current schema on start (migrator.ts —
 * which refuses a foreign or newer database) and then opened through Prisma 7.
 */
export class CloudDatabase implements OnApplicationShutdown {
  constructor(readonly client: CloudClient) {}

  static async open(options: CloudDatabaseOptions): Promise<CloudDatabase> {
    if (options.provider === 'sqlite') {
      mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
      const file = join(options.dataDir, 'cloud.db');
      const db = new DatabaseSync(file);
      try {
        await migrate(sqliteMigrationConnection(db), MIGRATIONS.sqlite);
      } finally {
        db.close();
      }
      return new CloudDatabase(
        new SqliteClient({ adapter: new PrismaNodeSqlite(file) }),
      );
    }
    const parsed = parseDatabaseUrl(options.databaseUrl ?? '');
    // Never the URL or the driver's message: either can carry the password (SEC-34).
    if (parsed.status === 'refused')
      throw new Error(`MOAT_DATABASE_URL refused: ${parsed.code}`);
    const config = { ...parsed.config, application_name: 'moat-cloud' };
    const client = new Client(config);
    try {
      await client.connect();
      await migrate(postgresMigrationConnection(client), MIGRATIONS.postgresql);
    } catch (error) {
      throw new Error(
        `The Cloud database could not be prepared (${error instanceof Error ? error.name : 'error'})`,
      );
    } finally {
      await client.end().catch(() => undefined);
    }
    const prisma = new PostgresClient({
      adapter: new PrismaPg({ ...config, max: 10 }),
    });
    return new CloudDatabase(prisma as unknown as CloudClient);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}
