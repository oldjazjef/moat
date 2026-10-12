import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigEditDto, toConfigEdit } from './dto/config-edit.dto';
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

  /**
   * One edit of moat.yaml (EditConfigCommand), answered with the project as it is afterwards.
   * 409 `config_changed`: the file changed since `base`, nothing written. 422: the edit was
   * refused, `error` says why (ConfigEditRefusal).
   */
  @Post(':id/config/edits')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async edit(
    @Param('id') id: string,
    @Body() body: ConfigEditDto,
  ): Promise<ProjectView> {
    const edit = toConfigEdit(body);
    if (edit === null)
      throw new BadRequestException({ error: 'edit_incomplete' });
    const result = await this.projects.editConfig(id, body.base, edit);
    switch (result.status) {
      case 'not_found':
        throw new NotFoundException();
      case 'changed':
        throw new ConflictException({ error: 'config_changed' });
      case 'refused':
        throw new UnprocessableEntityException({
          error: result.code,
          ...(result.fields === undefined ? {} : { fields: result.fields }),
        });
      case 'saved':
        break;
    }
    const view = await this.projects.get(id);
    if (view === null) throw new NotFoundException();
    return view;
  }
}
