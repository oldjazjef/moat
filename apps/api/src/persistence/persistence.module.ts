import { Global, Module } from '@nestjs/common';
import { ProjectFilesPort } from '../project/ports/project-files.port';
import { ProjectRegistryPort } from '../project/ports/project-registry.port';
import { FolderProjectFiles } from './project-folder/folder-project-files';
import { JsonProjectRegistry } from './project-registry/json-project-registry';
import { SetupProgressPort } from '../setup/ports/setup-progress.port';
import { JsonSetupProgress } from './setup/json-setup-progress';
import { HistoryStorePort } from '../project/ports/history-store.port';
import { SyncStatePort } from '../project/ports/sync-state.port';
import { SyncTargetPort } from '../project/ports/sync-target.port';
import { JsonSyncState } from './database/json-sync-state';
import { PostgresSyncTarget } from './database/postgres-sync-target';
import { SqliteHistoryStore } from './database/sqlite-history-store';

/** Global: every storage port → its adapter (as lazy-koins: nothing outside persistence/ does I/O on project data). */
@Global()
@Module({
  providers: [
    { provide: ProjectRegistryPort, useClass: JsonProjectRegistry },
    { provide: ProjectFilesPort, useClass: FolderProjectFiles },
    { provide: SetupProgressPort, useClass: JsonSetupProgress },
    // DT-03: the local history (SQLite) and the external database (PostgreSQL), through Prisma.
    { provide: HistoryStorePort, useClass: SqliteHistoryStore },
    { provide: SyncTargetPort, useClass: PostgresSyncTarget },
    { provide: SyncStatePort, useClass: JsonSyncState },
  ],
  exports: [
    ProjectRegistryPort,
    ProjectFilesPort,
    SetupProgressPort,
    HistoryStorePort,
    SyncTargetPort,
    SyncStatePort,
  ],
})
export class PersistenceModule {}
