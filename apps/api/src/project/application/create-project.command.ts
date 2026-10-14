import { Command } from '@nestjs/cqrs';
import type { ProjectEntry } from '../project.types';

export interface CreateProjectResult {
  readonly entry: ProjectEntry;
  /** False: the folder had a moat.yaml already, which was kept as it is. */
  readonly created: boolean;
}

/**
 * «Neues Projekt» (FR-73): writes the moat.yaml of a new project (core NEW_PROJECT_CONFIG) into a
 * folder and puts it into the project list. Like AddProjectCommand only the desktop's main
 * process sends it, in-process, after its own folder dialog (DT-08). An existing moat.yaml is
 * never replaced.
 */
export class CreateProjectCommand extends Command<CreateProjectResult> {
  constructor(readonly folder: string) {
    super();
  }
}
