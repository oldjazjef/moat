import { Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { GetProjectQuery } from './application/get-project.query';
import type { ProjectView } from './project.types';

/** The façade the controller talks to (Controller → Service → QueryBus → Handler → Port). */
@Injectable()
export class ProjectService {
  constructor(private readonly queries: QueryBus) {}

  get(): Promise<ProjectView> {
    return this.queries.execute(new GetProjectQuery());
  }
}
