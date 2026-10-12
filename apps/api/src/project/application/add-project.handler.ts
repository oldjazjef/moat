import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { isAbsolute } from 'node:path';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import type { ProjectEntry } from '../project.types';
import { AddProjectCommand } from './add-project.command';

@CommandHandler(AddProjectCommand)
export class AddProjectHandler implements ICommandHandler<AddProjectCommand> {
  constructor(private readonly registry: ProjectRegistryPort) {}

  async execute(command: AddProjectCommand): Promise<ProjectEntry> {
    if (!isAbsolute(command.folder) || command.folder.includes('\0')) {
      throw new Error('A project folder must be an absolute path');
    }
    return this.registry.add(command.folder);
  }
}
