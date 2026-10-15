import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import {
  addEnvironment,
  applyRecipe,
  assignGate,
  CONFIG_FILE,
  ConfigEditError,
  ConfigError,
  removeRoute,
  removeUpstream,
  setEnvironmentEnabled,
  setGateEnabled,
  setRoute,
  setRouteEnabled,
  setUpstream,
} from '@moat/core';
import { ProjectFilesPort } from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { type ConfigEdit, PROJECT_ID } from '../project.types';
import { configHash } from './config-hash';
import { HistoryService } from './history.service';
import {
  EditConfigCommand,
  type EditConfigResult,
} from './edit-config.command';

/** The edit as text → text, through the core's comment-preserving edits (config/edit.ts). */
function apply(text: string, edit: ConfigEdit): string {
  switch (edit.op) {
    case 'addEnvironment':
      return addEnvironment(text, edit.environment);
    case 'lockEnvironment':
      return setEnvironmentEnabled(text, edit.environment, false);
    case 'unlockEnvironment':
      return setEnvironmentEnabled(text, edit.environment, true);
    case 'lockGate':
      return setGateEnabled(text, edit.gate, false);
    case 'unlockGate':
      return setGateEnabled(text, edit.gate, true);
    case 'assignGate':
      // Choosing another environment in the window is the explicit move the CLI asks `--move` for.
      return assignGate(text, edit.gate, edit.environment, true);
    case 'addRoute':
      return setRoute(text, edit.route, edit.definition, 'create');
    case 'updateRoute':
      return setRoute(text, edit.route, edit.definition, 'update');
    case 'removeRoute':
      return removeRoute(text, edit.route);
    case 'enableRoute':
      return setRouteEnabled(text, edit.route, true);
    case 'disableRoute':
      return setRouteEnabled(text, edit.route, false);
    case 'addUpstream':
      return setUpstream(
        text,
        edit.upstream,
        edit.upstreamDefinition,
        'create',
      );
    case 'updateUpstream':
      return setUpstream(
        text,
        edit.upstream,
        edit.upstreamDefinition,
        'update',
      );
    case 'removeUpstream':
      return removeUpstream(text, edit.upstream);
    case 'applyRecipe':
      return applyRecipe(
        text,
        edit.recipe,
        edit.origins === undefined ? {} : { origins: [...edit.origins] },
      );
  }
}

@CommandHandler(EditConfigCommand)
export class EditConfigHandler implements ICommandHandler<EditConfigCommand> {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
    private readonly history: HistoryService,
  ) {}

  async execute(command: EditConfigCommand): Promise<EditConfigResult> {
    if (!PROJECT_ID.test(command.id)) return { status: 'not_found' };
    const entry = this.registry.get(command.id);
    if (entry === null) return { status: 'not_found' };
    const text = this.files.open(entry.folder)?.read(CONFIG_FILE) ?? null;
    if (text === null) return { status: 'refused', code: 'config_missing' };
    if (configHash(text) !== command.base) return { status: 'changed' };

    let next: string;
    try {
      next = apply(text, command.edit);
    } catch (error) {
      if (error instanceof ConfigEditError)
        return error.code === 'value_invalid' ||
          error.code === 'upstream_in_use'
          ? { status: 'refused', code: error.code, fields: error.fields }
          : { status: 'refused', code: error.code };
      if (error instanceof ConfigError)
        return { status: 'refused', code: 'config_invalid' };
      throw error;
    }
    if (next === text) return { status: 'saved' };
    try {
      this.files.writeConfig(entry.folder, next);
    } catch {
      return { status: 'refused', code: 'not_writable' };
    }
    await this.history.record(command.id, {
      kind: 'config_edited',
      details: {
        op: command.edit.op,
        before: command.base,
        after: configHash(next),
      },
    });
    return { status: 'saved' };
  }
}
