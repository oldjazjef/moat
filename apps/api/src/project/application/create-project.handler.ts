import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { isAbsolute } from 'node:path';
import { NEW_PROJECT_CONFIG } from '@moat/core';
import { FileExistsError, ProjectFilesPort } from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import {
  CreateProjectCommand,
  type CreateProjectResult,
} from './create-project.command';

@CommandHandler(CreateProjectCommand)
export class CreateProjectHandler implements ICommandHandler<CreateProjectCommand> {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  async execute(command: CreateProjectCommand): Promise<CreateProjectResult> {
    if (!isAbsolute(command.folder) || command.folder.includes('\0')) {
      throw new Error('A project folder must be an absolute path');
    }
    let created = true;
    try {
      this.files.createConfig(command.folder, NEW_PROJECT_CONFIG);
    } catch (error) {
      if (!(error instanceof FileExistsError)) throw error;
      created = false;
    }
    return { entry: this.registry.add(command.folder), created };
  }
}
