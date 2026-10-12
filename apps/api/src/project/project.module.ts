import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { GetProjectHandler } from './application/get-project.handler';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';

@Module({
  imports: [CqrsModule],
  controllers: [ProjectController],
  providers: [ProjectService, GetProjectHandler],
})
export class ProjectModule {}
