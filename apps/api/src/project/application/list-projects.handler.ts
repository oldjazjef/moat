import { QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import { readProject } from '@moat/core';
import { ProjectFilesPort } from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import type { ProjectEntry, ProjectSummary } from '../project.types';
import { ListProjectsQuery } from './list-projects.query';
import { projectName } from './project-name';

@QueryHandler(ListProjectsQuery)
export class ListProjectsHandler implements IQueryHandler<ListProjectsQuery> {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  async execute(_query: ListProjectsQuery): Promise<readonly ProjectSummary[]> {
    const summaries: ProjectSummary[] = [];
    for (const entry of this.registry.list()) {
      summaries.push(await this.summarise(entry));
    }
    return summaries;
  }

  private async summarise(entry: ProjectEntry): Promise<ProjectSummary> {
    const base = {
      id: entry.id,
      name: projectName(entry.folder),
      folder: entry.folder,
    };
    const storage = this.files.open(entry.folder);
    if (storage === null) {
      return {
        ...base,
        config: null,
        routes: 0,
        gates: 0,
        gatesMissingSecrets: [],
        gatesLocked: [],
      };
    }
    const project = await readProject(storage);
    return {
      ...base,
      config: project.config.status,
      routes:
        project.config.status === 'valid'
          ? Object.keys(project.config.config.routes).length
          : 0,
      gates: project.gates.length,
      gatesMissingSecrets: project.gates
        .filter(
          (gate) => gate.status === 'valid' && gate.missingSecrets.length > 0,
        )
        .map((gate) => gate.name),
      gatesLocked: project.gates
        .filter(
          (gate) => gate.status === 'valid' && gate.lock?.enabled === false,
        )
        .map((gate) => gate.name),
    };
  }
}
