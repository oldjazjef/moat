import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { HistoryAnchor, HistoryKind, HistoryRow } from '@moat/core';
import type { Env } from '../../config/env';
import { PrismaClient } from '../../generated/prisma-sqlite/client';
import {
  HistoryConflictError,
  HistoryStorePort,
  MAX_HISTORY_ROWS,
} from '../../project/ports/history-store.port';
import { PROJECT_ID } from '../../project/project.types';
import { sqliteMigrationConnection } from './migration-connections';
import { MIGRATIONS } from './migrations';
import { migrate } from './migrator';
import { PrismaNodeSqlite } from './node-sqlite-adapter';

/** `<MOAT_DATA_DIR>/history/`: one `<project id>.db` and its `<project id>.anchor.json`. */
export const HISTORY_DIR = 'history';
const ANCHOR = /^\{"seq":([1-9][0-9]{0,14}),"hash":"([0-9a-f]{64})"\}\n?$/;

/**
 * The local history on SQLite (DT-03): Prisma 7 on Node's own `node:sqlite` (PrismaNodeSqlite),
 * one file per project in the API's data folder — never in the project folder, which lives in Git.
 * The schema comes from apps/api/prisma/sqlite/migrations, applied by `migrate` when the file is
 * created or opened by a newer Moat. The anchor sits next to the database as a small JSON file,
 * written atomically after each row.
 */
@Injectable()
export class SqliteHistoryStore
  extends HistoryStorePort
  implements OnApplicationShutdown
{
  private readonly dir: string;
  private readonly clients = new Map<string, PrismaClient>();

  constructor(config: ConfigService<Env, true>) {
    super();
    this.dir = join(config.get('MOAT_DATA_DIR', { infer: true }), HISTORY_DIR);
  }

  enabled(projectId: string): boolean {
    return PROJECT_ID.test(projectId) && existsSync(this.file(projectId));
  }

  async enable(projectId: string): Promise<void> {
    if (!PROJECT_ID.test(projectId)) throw new Error('project id');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    await this.client(projectId);
  }

  async list(projectId: string): Promise<HistoryRow[]> {
    if (!this.enabled(projectId)) return [];
    const client = await this.client(projectId);
    const rows = await client.historyEntry.findMany({
      orderBy: { seq: 'desc' },
      take: MAX_HISTORY_ROWS,
    });
    return rows.reverse().map((row) => ({
      seq: row.seq,
      at: row.at,
      kind: row.kind as HistoryKind,
      details: row.details,
      prevHash: row.prevHash,
      hash: row.hash,
    }));
  }

  anchor(projectId: string): HistoryAnchor | null {
    if (!PROJECT_ID.test(projectId)) return null;
    let text: string;
    try {
      text = readFileSync(this.anchorFile(projectId), 'utf8');
    } catch {
      return null;
    }
    const match = ANCHOR.exec(text);
    // A damaged anchor reads like a moved one: verify then reports the mismatch.
    return match === null
      ? { seq: 0, hash: '' }
      : { seq: Number(match[1]), hash: match[2] as string };
  }

  async append(projectId: string, row: HistoryRow): Promise<void> {
    if (!this.enabled(projectId)) throw new Error('history not enabled');
    const client = await this.client(projectId);
    try {
      await client.historyEntry.create({ data: { ...row } });
    } catch (error) {
      if ((error as { code?: unknown }).code === 'P2002')
        throw new HistoryConflictError('seq taken');
      throw error;
    }
    const anchor = this.anchorFile(projectId);
    const temp = `${anchor}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(
        temp,
        `${JSON.stringify({ seq: row.seq, hash: row.hash })}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      renameSync(temp, anchor);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.$disconnect()));
  }

  /** The project's client; the file is created and migrated on first use. */
  private async client(projectId: string): Promise<PrismaClient> {
    const known = this.clients.get(projectId);
    if (known !== undefined) return known;
    const file = this.file(projectId);
    const db = new DatabaseSync(file);
    try {
      await migrate(sqliteMigrationConnection(db), MIGRATIONS.sqlite);
    } finally {
      db.close();
    }
    const client = new PrismaClient({ adapter: new PrismaNodeSqlite(file) });
    this.clients.set(projectId, client);
    return client;
  }

  private file(projectId: string): string {
    return join(this.dir, `${projectId}.db`);
  }

  private anchorFile(projectId: string): string {
    return join(this.dir, `${projectId}.anchor.json`);
  }
}
