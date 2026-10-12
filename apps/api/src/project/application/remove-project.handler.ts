import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { PROJECT_ID } from '../project.types';
import { RemoveProjectCommand } from './remove-project.command';

@CommandHandler(RemoveProjectCommand)
export class RemoveProjectHandler implements ICommandHandler<RemoveProjectCommand> {
  constructor(private readonly registry: ProjectRegistryPort) {}

  async execute(command: RemoveProjectCommand): Promise<boolean> {
    return PROJECT_ID.test(command.id) && this.registry.remove(command.id);
  }
}
