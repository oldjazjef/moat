import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env';
import { SyncStatePort } from '../../project/ports/sync-state.port';
import { PROJECT_ID } from '../../project/project.types';

/** `<MOAT_DATA_DIR>/database-sync.json`: `{ "<project id>/<key>": "<config sha-256>" }`. */
export const SYNC_STATE_FILE = 'database-sync.json';
const MAX_FILE_BYTES = 256 * 1024;
const KEY = /^[a-z][a-z0-9-]{0,62}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * What each project last agreed on with its database, as one small JSON file in the API's data
 * folder (atomic write, 0600). A missing or damaged file reads as "never synced": then any
 * difference in moat.yaml is a conflict, never an overwrite.
 */
@Injectable()
export class JsonSyncState extends SyncStatePort {
  private readonly file: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.file = join(
      config.get('MOAT_DATA_DIR', { infer: true }),
      SYNC_STATE_FILE,
    );
  }

  base(projectId: string, key: string): string | null {
    return this.read()[`${projectId}/${key}`] ?? null;
  }

  setBase(projectId: string, key: string, configHash: string): void {
    if (
      !PROJECT_ID.test(projectId) ||
      !KEY.test(key) ||
      !HEX64.test(configHash)
    )
      throw new Error('sync state');
    const next = { ...this.read(), [`${projectId}/${key}`]: configHash };
    mkdirSync(join(this.file, '..'), { recursive: true });
    const temp = `${this.file}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temp, this.file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  private read(): Record<string, string> {
    let value: unknown;
    try {
      if (statSync(this.file).size > MAX_FILE_BYTES) return {};
      value = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
    const result: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return result;
    for (const [entry, hash] of Object.entries(value)) {
      const [id, key, ...rest] = entry.split('/');
      if (
        rest.length === 0 &&
        id !== undefined &&
        PROJECT_ID.test(id) &&
        key !== undefined &&
        KEY.test(key) &&
        typeof hash === 'string' &&
        HEX64.test(hash)
      )
        result[entry] = hash;
    }
    return result;
  }
}
