import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ProjectService } from './project.service';
import type { ProjectSummary, ProjectView } from './project.types';

/**
 * The projects (authz-matrix: `/api/projects…`). There is no route that adds a project: a folder
 * is chosen only in the desktop's own dialog (DT-08, see AddProjectCommand).
 */
@Controller('projects')
export class ProjectController {
  constructor(private readonly projects: ProjectService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(): Promise<readonly ProjectSummary[]> {
    return this.projects.list();
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(@Param('id') id: string): Promise<ProjectView> {
    const view = await this.projects.get(id);
    if (view === null) throw new NotFoundException();
    return view;
  }

  /** Takes the project off the list; the folder and its files stay as they are. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    if (!(await this.projects.remove(id))) throw new NotFoundException();
  }
}
