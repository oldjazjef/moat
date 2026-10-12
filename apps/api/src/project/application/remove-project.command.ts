import { Command } from '@nestjs/cqrs';

/** Takes a project off the list; its folder stays untouched. False when it was not listed. */
export class RemoveProjectCommand extends Command<boolean> {
  constructor(readonly id: string) {
    super();
  }
}
