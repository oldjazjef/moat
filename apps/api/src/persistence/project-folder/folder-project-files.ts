import { Injectable } from '@nestjs/common';
import { CONFIG_FILE, type StoragePort } from '@moat/core';
import {
  BundleExistsError,
  ProjectFilesPort,
} from '../../project/ports/project-files.port';
import { FolderStorage, FolderWriteError } from './folder-storage';

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

  writeConfig(folder: string, text: string): void {
    new FolderStorage(folder).replace(CONFIG_FILE, text);
  }

  writeBundle(folder: string, gate: string, version: number, text: string) {
    try {
      new FolderStorage(folder).create(`bundles/${gate}/${version}.json`, text);
    } catch (error) {
      if (error instanceof FolderWriteError && error.reason === 'exists')
        throw new BundleExistsError(`bundle ${version} exists`);
      throw error;
    }
  }

  writeSecret(folder: string, gate: string, name: string, text: string): void {
    new FolderStorage(folder).replace(`secrets/${gate}/${name}.json`, text);
  }
}
