import { Global, Module } from '@nestjs/common';
import { ProjectFilesPort } from '../project/ports/project-files.port';
import { ProjectRegistryPort } from '../project/ports/project-registry.port';
import { FolderProjectFiles } from './project-folder/folder-project-files';
import { JsonProjectRegistry } from './project-registry/json-project-registry';

/** Global: every storage port → its adapter (as lazy-koins: nothing outside persistence/ does I/O on project data). */
@Global()
@Module({
  providers: [
    { provide: ProjectRegistryPort, useClass: JsonProjectRegistry },
    { provide: ProjectFilesPort, useClass: FolderProjectFiles },
  ],
  exports: [ProjectRegistryPort, ProjectFilesPort],
})
export class PersistenceModule {}
