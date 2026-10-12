import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { CONFIG_FILE, readProject } from '@moat/core';
import { ProjectFilesPort } from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { PROJECT_ID, type ProjectView } from '../project.types';
import { configHash } from './config-hash';
import { GetProjectQuery } from './get-project.query';
import { projectName } from './project-name';

@QueryHandler(GetProjectQuery)
export class GetProjectHandler implements IQueryHandler<GetProjectQuery> {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  async execute(query: GetProjectQuery): Promise<ProjectView | null> {
    if (!PROJECT_ID.test(query.id)) return null;
    const entry = this.registry.get(query.id);
    if (entry === null) return null;
    const storage = this.files.open(entry.folder);
    const config = storage?.read(CONFIG_FILE) ?? null;
    return {
      id: entry.id,
      name: projectName(entry.folder),
      folder: entry.folder,
      // Read once more by readProject: a change in between shows as a conflict on the next edit.
      project: storage === null ? null : await readProject(storage),
      configHash: config === null ? null : configHash(config),
    };
  }
}
