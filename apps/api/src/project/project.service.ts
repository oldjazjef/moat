import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { AddProjectCommand } from './application/add-project.command';
import { GetProjectQuery } from './application/get-project.query';
import { ListProjectsQuery } from './application/list-projects.query';
import { RemoveProjectCommand } from './application/remove-project.command';
import type {
  ProjectEntry,
  ProjectSummary,
  ProjectView,
} from './project.types';

/** The façade the controller talks to (Controller → Service → Bus → Handler → Port). */
@Injectable()
export class ProjectService {
  constructor(
    private readonly queries: QueryBus,
    private readonly commands: CommandBus,
  ) {}

  list(): Promise<readonly ProjectSummary[]> {
    return this.queries.execute(new ListProjectsQuery());
  }

  get(id: string): Promise<ProjectView | null> {
    return this.queries.execute(new GetProjectQuery(id));
  }

  /** In-process only (the desktop's main process, see AddProjectCommand). */
  add(folder: string): Promise<ProjectEntry> {
    return this.commands.execute(new AddProjectCommand(folder));
  }

  remove(id: string): Promise<boolean> {
    return this.commands.execute(new RemoveProjectCommand(id));
  }
}
