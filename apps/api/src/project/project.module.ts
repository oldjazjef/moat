import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AddProjectHandler } from './application/add-project.handler';
import { BundleSigningService } from './application/bundle-signing.service';
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
    RemoveProjectHandler,
    EditConfigHandler,
    BundleSigningService,
    SecretSealingService,
  ],
  exports: [ProjectService, BundleSigningService, SecretSealingService],
})
export class ProjectModule {}
