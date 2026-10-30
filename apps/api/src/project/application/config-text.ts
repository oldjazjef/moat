import {
  Command,
  CommandHandler,
  type ICommandHandler,
  type IQueryHandler,
  Query,
  QueryHandler,
} from '@nestjs/cqrs';
import {
  CONFIG_FILE,
  ConfigError,
  type ConfigIssue,
  loadMoatYaml,
  MAX_YAML_BYTES,
  MoatRejection,
} from '@moat/core';
import { ProjectFilesPort } from '../ports/project-files.port';
import { ProjectRegistryPort } from '../ports/project-registry.port';
import { PROJECT_ID } from '../project.types';
import { configHash } from './config-hash';
import { HistoryService } from './history.service';

/** moat.yaml as text, for the editor; `hash` is the base the next save names. */
export interface ConfigText {
  readonly text: string | null;
  readonly hash: string | null;
}

/** Where a refused text is wrong: the core's issue without its English message. */
export interface ConfigTextIssue {
  readonly code: ConfigIssue['code'] | 'rejected';
  readonly path: readonly (string | number)[];
  readonly line: number | null;
  readonly column: number | null;
}

export type ReplaceConfigResult =
  | { readonly status: 'saved'; readonly config: ConfigText }
  | { readonly status: 'not_found' }
  /** moat.yaml changed since `base` was read: nothing written (409). */
  | { readonly status: 'changed' }
  | {
      readonly status: 'refused';
      readonly code: 'config_invalid' | 'config_too_large' | 'not_writable';
      readonly issues?: readonly ConfigTextIssue[];
    };

export class GetConfigTextQuery extends Query<ConfigText | null> {
  constructor(readonly id: string) {
    super();
  }
}

/**
 * The editor's «Speichern»: moat.yaml as a whole, checked as the CLI and the gate check it
 * (strict YAML, the schema) before anything is written. Like an edit it changes the config only:
 * a gate sees it with the next signed bundle.
 */
export class ReplaceConfigCommand extends Command<ReplaceConfigResult> {
  constructor(
    readonly id: string,
    /** ConfigText.hash as the editor loaded it; null when there was no moat.yaml. */
    readonly base: string | null,
    readonly text: string,
  ) {
    super();
  }
}

@QueryHandler(GetConfigTextQuery)
export class GetConfigTextHandler implements IQueryHandler<GetConfigTextQuery> {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  execute(query: GetConfigTextQuery): Promise<ConfigText | null> {
    if (!PROJECT_ID.test(query.id)) return Promise.resolve(null);
    const entry = this.registry.get(query.id);
    if (entry === null) return Promise.resolve(null);
    const text = this.files.open(entry.folder)?.read(CONFIG_FILE) ?? null;
    return Promise.resolve({
      text,
      hash: text === null ? null : configHash(text),
    });
  }
}

@CommandHandler(ReplaceConfigCommand)
export class ReplaceConfigHandler implements ICommandHandler<ReplaceConfigCommand> {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
    private readonly history: HistoryService,
  ) {}

  async execute(command: ReplaceConfigCommand): Promise<ReplaceConfigResult> {
    if (!PROJECT_ID.test(command.id)) return { status: 'not_found' };
    const entry = this.registry.get(command.id);
    if (entry === null) return { status: 'not_found' };
    // The text first: a refused text never depends on what is on disk.
    if (Buffer.byteLength(command.text, 'utf8') > MAX_YAML_BYTES)
      return { status: 'refused', code: 'config_too_large' };
    const issues = configIssues(command.text);
    if (issues !== null)
      return { status: 'refused', code: 'config_invalid', issues };
    const current = this.files.open(entry.folder)?.read(CONFIG_FILE) ?? null;
    const currentHash = current === null ? null : configHash(current);
    if (currentHash !== command.base) return { status: 'changed' };
    const saved = { text: command.text, hash: configHash(command.text) };
    if (command.text === current) return { status: 'saved', config: saved };
    try {
      this.files.writeConfig(entry.folder, command.text);
    } catch {
      return { status: 'refused', code: 'not_writable' };
    }
    await this.history.record(command.id, {
      kind: 'config_edited',
      details: {
        op: 'replace',
        before: currentHash ?? configHash(''),
        after: saved.hash,
      },
    });
    return { status: 'saved', config: saved };
  }
}

/** Null when the text is a valid moat.yaml; else where it is wrong (never the core's message). */
export function configIssues(text: string): ConfigTextIssue[] | null {
  try {
    loadMoatYaml(text);
    return null;
  } catch (error) {
    if (error instanceof ConfigError)
      return error.issues.slice(0, 50).map((issue) => ({
        code: issue.code,
        path: issue.path,
        line: issue.line ?? null,
        column: issue.column ?? null,
      }));
    if (error instanceof MoatRejection)
      return [{ code: 'rejected', path: [], line: null, column: null }];
    throw error;
  }
}

export const CONFIG_TEXT_HANDLERS = [
  GetConfigTextHandler,
  ReplaceConfigHandler,
];
