import { Command } from '@nestjs/cqrs';
import type { ProjectEntry } from '../project.types';

/**
 * Puts a folder into the project list. Only the desktop's main process sends it, in-process,
 * after its own folder dialog (DT-08): there is no HTTP route for it, so the page can never name
 * a path.
 */
export class AddProjectCommand extends Command<ProjectEntry> {
  constructor(readonly folder: string) {
    super();
  }
}
