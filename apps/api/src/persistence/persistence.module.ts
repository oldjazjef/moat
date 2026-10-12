import { Global, Module } from '@nestjs/common';
import { ProjectStoragePort } from '../project/ports/project-storage.port';
import { FolderProjectStorage } from './project-folder/folder-project-storage';

/** Global: every storage port → its adapter (as lazy-koins: nothing outside persistence/ does I/O on project data). */
@Global()
@Module({
  providers: [{ provide: ProjectStoragePort, useClass: FolderProjectStorage }],
  exports: [ProjectStoragePort],
})
export class PersistenceModule {}
