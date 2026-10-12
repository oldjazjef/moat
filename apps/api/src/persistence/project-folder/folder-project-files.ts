import { Injectable } from '@nestjs/common';
import type { StoragePort } from '@moat/core';
import { ProjectFilesPort } from '../../project/ports/project-files.port';
import { FolderStorage } from './folder-storage';

/** A project folder on disk, opened anew per request (it may change on disk). */
@Injectable()
export class FolderProjectFiles extends ProjectFilesPort {
  open(folder: string): StoragePort | null {
    try {
      return new FolderStorage(folder);
    } catch {
      return null;
    }
  }
}
