import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { readProject } from '@moat/core';
import { ProjectStoragePort } from '../ports/project-storage.port';
import type { ProjectView } from '../project.types';
import { GetProjectQuery } from './get-project.query';

@QueryHandler(GetProjectQuery)
export class GetProjectHandler implements IQueryHandler<GetProjectQuery> {
  constructor(private readonly storage: ProjectStoragePort) {}

  async execute(_query: GetProjectQuery): Promise<ProjectView> {
    const folder = this.storage.location();
    const files = this.storage.open();
    return {
      folder,
      project: files === null ? null : await readProject(files),
    };
  }
}
