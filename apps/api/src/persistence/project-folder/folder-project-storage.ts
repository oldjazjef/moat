import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StoragePort } from '@moat/core';
import type { Env } from '../../config/env';
import { ProjectStoragePort } from '../../project/ports/project-storage.port';
import { FolderStorage } from './folder-storage';

/** The project folder from `MOAT_PROJECT_DIR`, opened anew per request (it may change on disk). */
@Injectable()
export class FolderProjectStorage extends ProjectStoragePort {
  private readonly folder: string | null;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.folder = config.get('MOAT_PROJECT_DIR', { infer: true }) ?? null;
  }

  location(): string | null {
    return this.folder;
  }

  open(): StoragePort | null {
    if (this.folder === null) return null;
    try {
      return new FolderStorage(this.folder);
    } catch {
      return null;
    }
  }
}
