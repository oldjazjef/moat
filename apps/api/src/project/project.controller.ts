import { Controller, Get, Header } from '@nestjs/common';
import { ProjectService } from './project.service';
import type { ProjectView } from './project.types';

@Controller('project')
export class ProjectController {
  constructor(private readonly project: ProjectService) {}

  /** The open project folder: config, routes and gates (authz-matrix: `GET /api/project`). */
  @Get()
  @Header('Cache-Control', 'no-store')
  get(): Promise<ProjectView> {
    return this.project.get();
  }
}
