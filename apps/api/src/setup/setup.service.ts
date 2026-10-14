import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import {
  CompleteSetupCommand,
  GetSetupQuery,
  type SetupResult,
  type SetupUpdate,
  type SetupView,
  UpdateSetupCommand,
} from './application/setup.handlers';

/** The façade the controller talks to (Controller → Service → Bus → Handler → Port). */
@Injectable()
export class SetupService {
  constructor(
    private readonly queries: QueryBus,
    private readonly commands: CommandBus,
  ) {}

  get(): Promise<SetupView> {
    return this.queries.execute(new GetSetupQuery());
  }

  update(update: SetupUpdate): Promise<SetupResult> {
    return this.commands.execute(new UpdateSetupCommand(update));
  }

  complete(now: Date): Promise<SetupResult> {
    return this.commands.execute(new CompleteSetupCommand(now.toISOString()));
  }
}
