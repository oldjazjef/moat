import { Injectable } from '@nestjs/common';
import {
  Command,
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  Query,
  QueryHandler,
} from '@nestjs/cqrs';
import { readProject } from '@moat/core';
import { ProjectFilesPort } from '../../project/ports/project-files.port';
import { ProjectRegistryPort } from '../../project/ports/project-registry.port';
import {
  canMarkDone,
  EMPTY_PROGRESS,
  isRequired,
  missingRequired,
  STEP_DEFINITIONS,
  type SetupFacts,
  type SetupProgress,
  type SetupStepId,
  type StepState,
} from '../domain/setup';
import { SetupProgressPort } from '../ports/setup-progress.port';

/** `GET /api/setup`: the steps with their state, what exists, whether the wizard is finished. */
export interface SetupView {
  readonly steps: readonly {
    readonly id: SetupStepId;
    readonly required: boolean;
    readonly state: StepState;
  }[];
  readonly currentStep: SetupStepId;
  readonly completedAt: string | null;
  readonly complete: boolean;
  /** Required steps not done yet (or whose facts went missing). */
  readonly missing: readonly SetupStepId[];
  readonly facts: SetupFacts;
}

export interface SetupUpdate {
  readonly currentStep?: SetupStepId;
  readonly states?: Readonly<Partial<Record<SetupStepId, StepState>>>;
}

export type SetupRefusal =
  /** A required step cannot be skipped. */
  | 'step_required'
  /** `done` for a step whose facts are missing (no project, no gate). */
  | 'step_incomplete'
  /** «Fertig» while required steps are missing; the body lists them. */
  | 'setup_incomplete';

export type SetupResult =
  | { readonly status: 'ok'; readonly view: SetupView }
  | {
      readonly status: 'refused';
      readonly code: SetupRefusal;
      readonly missing?: readonly SetupStepId[];
    };

export class GetSetupQuery extends Query<SetupView> {}

export class UpdateSetupCommand extends Command<SetupResult> {
  constructor(readonly update: SetupUpdate) {
    super();
  }
}

/** «Fertig»: the wizard is finished; the app no longer opens it on its own. */
export class CompleteSetupCommand extends Command<SetupResult> {
  /** `now`: ISO time from the controller (the handlers keep no clock). */
  constructor(readonly now: string) {
    super();
  }
}

/**
 * Counts projects and valid pinned gates (as readProject reads them: a damaged gate file is no
 * gate, §1.5); a folder that cannot be read counts as nothing.
 */
async function readFacts(
  registry: ProjectRegistryPort,
  files: ProjectFilesPort,
): Promise<SetupFacts> {
  const projects = registry.list();
  let gates = 0;
  for (const { folder } of projects) {
    const storage = files.open(folder);
    if (storage === null) continue;
    const state = await readProject(storage);
    gates += state.gates.filter((gate) => gate.status === 'valid').length;
  }
  return { projects: projects.length, gates };
}

function view(progress: SetupProgress, facts: SetupFacts): SetupView {
  // Nothing stored but projects listed: a desktop from before the wizard, already set up.
  const upgraded = progress === EMPTY_PROGRESS && facts.projects > 0;
  return {
    steps: STEP_DEFINITIONS.map(({ id, required }) => ({
      id,
      required,
      state: progress.steps[id] ?? 'open',
    })),
    currentStep: progress.currentStep,
    completedAt: progress.completedAt,
    complete: progress.completedAt !== null || upgraded,
    missing: missingRequired(progress, facts),
    facts,
  };
}

/** Shared by the three handlers; @Injectable so its constructor's types reach Nest's injector. */
@Injectable()
abstract class SetupHandler {
  constructor(
    protected readonly progress: SetupProgressPort,
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  protected facts(): Promise<SetupFacts> {
    return readFacts(this.registry, this.files);
  }
}

@QueryHandler(GetSetupQuery)
export class GetSetupHandler
  extends SetupHandler
  implements IQueryHandler<GetSetupQuery>
{
  async execute(): Promise<SetupView> {
    return view(this.progress.read(), await this.facts());
  }
}

@CommandHandler(UpdateSetupCommand)
export class UpdateSetupHandler
  extends SetupHandler
  implements ICommandHandler<UpdateSetupCommand>
{
  async execute(command: UpdateSetupCommand): Promise<SetupResult> {
    const current = this.progress.read();
    const states = command.update.states ?? {};
    const facts = await this.facts();
    for (const [step, state] of Object.entries(states) as [
      SetupStepId,
      StepState,
    ][]) {
      if (state === 'skipped' && isRequired(step))
        return { status: 'refused', code: 'step_required' };
      if (state === 'done' && !canMarkDone(step, facts))
        return { status: 'refused', code: 'step_incomplete' };
    }
    const next: SetupProgress = {
      ...current,
      steps: { ...current.steps, ...states },
      currentStep: command.update.currentStep ?? current.currentStep,
    };
    this.progress.write(next);
    return { status: 'ok', view: view(next, facts) };
  }
}

@CommandHandler(CompleteSetupCommand)
export class CompleteSetupHandler
  extends SetupHandler
  implements ICommandHandler<CompleteSetupCommand>
{
  async execute(command: CompleteSetupCommand): Promise<SetupResult> {
    const current = this.progress.read();
    const facts = await this.facts();
    const missing = missingRequired(current, facts);
    if (missing.length > 0)
      return { status: 'refused', code: 'setup_incomplete', missing };
    const next: SetupProgress = {
      ...current,
      steps: { ...current.steps, summary: 'done' },
      currentStep: 'summary',
      completedAt: current.completedAt ?? command.now,
    };
    this.progress.write(next);
    return { status: 'ok', view: view(next, facts) };
  }
}
