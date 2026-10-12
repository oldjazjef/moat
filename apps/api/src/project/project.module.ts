import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { AddProjectHandler } from './application/add-project.handler';
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
  ],
  exports: [ProjectService],
})
export class ProjectModule {}
