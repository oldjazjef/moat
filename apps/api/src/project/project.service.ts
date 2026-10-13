import { Injectable } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { AddProjectCommand } from './application/add-project.command';
import {
  CreateProjectCommand,
  type CreateProjectResult,
} from './application/create-project.command';
import {
  EditConfigCommand,
  type EditConfigResult,
} from './application/edit-config.command';
import {
  AddGateCommand,
  type AddGateResult,
  CheckGateQuery,
  type CheckGateResult,
  type GateInput,
} from './application/gate.commands';
import { GetProjectQuery } from './application/get-project.query';
import { ListProjectsQuery } from './application/list-projects.query';
import { RemoveProjectCommand } from './application/remove-project.command';
import type {
  ConfigEdit,
  ProjectEntry,
  ProjectSummary,
  ProjectView,
} from './project.types';

/** The façade the controller talks to (Controller → Service → Bus → Handler → Port). */
@Injectable()
export class ProjectService {
  constructor(
    private readonly queries: QueryBus,
    private readonly commands: CommandBus,
  ) {}

  list(): Promise<readonly ProjectSummary[]> {
    return this.queries.execute(new ListProjectsQuery());
  }

  get(id: string): Promise<ProjectView | null> {
    return this.queries.execute(new GetProjectQuery(id));
  }

  /** In-process only (the desktop's main process, see AddProjectCommand). */
  add(folder: string): Promise<ProjectEntry> {
    return this.commands.execute(new AddProjectCommand(folder));
  }

  /** In-process only, like add(): «Neues Projekt» (CreateProjectCommand). */
  create(folder: string): Promise<CreateProjectResult> {
    return this.commands.execute(new CreateProjectCommand(folder));
  }

  checkGate(id: string, gate: GateInput): Promise<CheckGateResult> {
    return this.queries.execute(new CheckGateQuery(id, gate));
  }

  addGate(
    id: string,
    gate: GateInput,
    fingerprint: string,
  ): Promise<AddGateResult> {
    return this.commands.execute(new AddGateCommand(id, gate, fingerprint));
  }

  remove(id: string): Promise<boolean> {
    return this.commands.execute(new RemoveProjectCommand(id));
  }

  editConfig(
    id: string,
    base: string,
    edit: ConfigEdit,
  ): Promise<EditConfigResult> {
    return this.commands.execute(new EditConfigCommand(id, base, edit));
  }
}
