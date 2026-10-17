import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { CONFIG_FILE, ConfigEditError, ConfigError } from '@moat/core';
import { applyConfigEdit as apply } from './apply-config-edit';
import { ProjectFilesPort } from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { PROJECT_ID } from '../project.types';
import { configHash } from './config-hash';
import { HistoryService } from './history.service';
import {
  EditConfigCommand,
  type EditConfigResult,
} from './edit-config.command';

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
