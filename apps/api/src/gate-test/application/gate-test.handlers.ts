import { ConfigService } from '@nestjs/config';
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
  type Policy,
  readProject,
  suggestPolicy,
  type StoragePort,
} from '@moat/core';
import type { Env } from '../../config/env';
import { ProjectFilesPort } from '../../project/ports/project-files.port';
import { ProjectRegistryPort } from '../../project/ports/project-registry.port';
import { PROJECT_ID } from '../../project/project.types';
import { GateClientPort, type GateAnswer } from '../ports/gate-client.port';
import { gateTestTarget } from './gate-test-target';

/** A test body larger than any recipe's; the gate checks the route's own limit. */
export const MAX_TEST_BODY = 16 * 1024;
const WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

export type GateTestRefusal =
  | 'config_missing'
  | 'config_invalid'
  | 'route_unknown'
  | 'url_invalid'
  | 'body_invalid';

export type GateTestResult =
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly code: GateTestRefusal }
  | { readonly status: 'sent'; readonly answer: GateAnswer };

export type PolicyResult =
  | { readonly status: 'not_found' }
  | {
      readonly status: 'refused';
      readonly code: 'config_missing' | 'config_invalid';
    }
  | { readonly status: 'ok'; readonly policy: Policy };

/**
 * «Testen» (FR-73): sends the route's method and path of this project's moat.yaml, with `body`,
 * to the gate at `url`, and reports what came back. The request goes to the gate only — never to
 * the upstream directly, and never with a secret: the gate adds that itself.
 */
export class TestGateCommand extends Command<GateTestResult> {
  constructor(
    readonly id: string,
    readonly url: string,
    readonly route: string,
    readonly body: string,
  ) {
    super();
  }
}

/** The narrowest local policy for the project's moat.yaml (SEC-14), as `moat policy suggest`. */
export class SuggestPolicyQuery extends Query<PolicyResult> {
  constructor(readonly id: string) {
    super();
  }
}

function open(
  registry: ProjectRegistryPort,
  files: ProjectFilesPort,
  id: string,
): StoragePort | 'not_found' | 'config_missing' {
  if (!PROJECT_ID.test(id)) return 'not_found';
  const entry = registry.get(id);
  if (entry === null) return 'not_found';
  const storage = files.open(entry.folder);
  if (storage === null || storage.read(CONFIG_FILE) === null)
    return 'config_missing';
  return storage;
}

@CommandHandler(TestGateCommand)
export class TestGateHandler implements ICommandHandler<TestGateCommand> {
  private readonly allowLoopback: boolean;

  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
    private readonly client: GateClientPort,
    config: ConfigService<Env, true>,
  ) {
    this.allowLoopback =
      config.get('MOAT_GATE_TEST_LOOPBACK', { infer: true }) === 'true';
  }

  async execute(command: TestGateCommand): Promise<GateTestResult> {
    const storage = open(this.registry, this.files, command.id);
    if (storage === 'not_found') return { status: 'not_found' };
    if (storage === 'config_missing')
      return { status: 'refused', code: 'config_missing' };
    const { config } = await readProject(storage);
    if (config.status !== 'valid')
      return { status: 'refused', code: 'config_invalid' };
    const route = Object.hasOwn(config.config.routes, command.route)
      ? config.config.routes[command.route]
      : undefined;
    if (route === undefined)
      return { status: 'refused', code: 'route_unknown' };
    const url = gateTestTarget(command.url, route.path, this.allowLoopback);
    if (url === null) return { status: 'refused', code: 'url_invalid' };
    const hasBody = WITH_BODY.has(route.method);
    if (hasBody ? !isJson(command.body) : command.body.trim() !== '')
      return { status: 'refused', code: 'body_invalid' };
    const answer = await this.client.send({
      url,
      method: route.method,
      body: hasBody ? command.body : null,
    });
    return { status: 'sent', answer };
  }
}

@QueryHandler(SuggestPolicyQuery)
export class SuggestPolicyHandler implements IQueryHandler<SuggestPolicyQuery> {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  async execute(query: SuggestPolicyQuery): Promise<PolicyResult> {
    const storage = open(this.registry, this.files, query.id);
    if (storage === 'not_found') return { status: 'not_found' };
    if (storage === 'config_missing')
      return { status: 'refused', code: 'config_missing' };
    const { config } = await readProject(storage);
    if (config.status !== 'valid')
      return { status: 'refused', code: 'config_invalid' };
    return { status: 'ok', policy: suggestPolicy(config.config) };
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
