import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AddProjectHandler } from './application/add-project.handler';
import { CreateProjectHandler } from './application/create-project.handler';
import { AddGateHandler, CheckGateHandler } from './application/gate.handlers';
import { BundleSigningService } from './application/bundle-signing.service';
import { DatabaseSyncService } from './application/database-sync.service';
import { HistoryService } from './application/history.service';
import { DeployPackageService } from './application/deploy-package.service';
import { SecretSealingService } from './application/secret-sealing.service';
import { EditConfigHandler } from './application/edit-config.handler';
import { GetProjectHandler } from './application/get-project.handler';
import { ListProjectsHandler } from './application/list-projects.handler';
import { RemoveProjectHandler } from './application/remove-project.handler';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';

@Module({
  imports: [CqrsModule],
  controllers: [ProjectController],
  providers: [
    ProjectService,
    ListProjectsHandler,
    GetProjectHandler,
    AddProjectHandler,
    CreateProjectHandler,
    CheckGateHandler,
    AddGateHandler,
    RemoveProjectHandler,
    EditConfigHandler,
    BundleSigningService,
    SecretSealingService,
    DeployPackageService,
    HistoryService,
    DatabaseSyncService,
  ],
  exports: [
    ProjectService,
    BundleSigningService,
    SecretSealingService,
    DeployPackageService,
    HistoryService,
    DatabaseSyncService,
  ],
})
export class ProjectModule {}
