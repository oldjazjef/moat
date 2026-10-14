import { Query, QueryHandler, type IQueryHandler } from '@nestjs/cqrs';
import {
  DryRunPlanError,
  dryRun,
  planDryRun,
  type DryRunPlanErrorCode,
  type DryRunResult,
} from '@moat/core';
import { ProjectFilesPort } from '../../project/ports/project-files.port';
import { ProjectRegistryPort } from '../../project/ports/project-registry.port';
import { PROJECT_ID } from '../../project/project.types';

/** The request the console describes; only what a gate reads from a client request. */
export interface DryRunInput {
  readonly method: string;
  readonly path: string;
  readonly origin: string | null;
  readonly contentType: string | null;
  /** `Access-Control-Request-Method`, for a preflight (`OPTIONS`). */
  readonly requestMethod: string | null;
  readonly body: string;
}

export type DryRunQueryResult =
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly code: DryRunPlanErrorCode }
  | { readonly status: 'ok'; readonly result: DryRunResult };

/**
 * The test console (FR-42): what the gate would answer, worked out in-process from the project's
 * moat.yaml and the suggested policy (core `planDryRun` + `dryRun`). Nothing is sent anywhere and
 * no secret is opened: the answer names the secret the gate would add, never its value.
 */
export class DryRunQuery extends Query<DryRunQueryResult> {
  constructor(
    readonly id: string,
    /** The gate whose lock and sealed secrets count; null for the config alone. */
    readonly gate: string | null,
    readonly request: DryRunInput,
  ) {
    super();
  }
}

@QueryHandler(DryRunQuery)
export class DryRunHandler implements IQueryHandler<DryRunQuery> {
  constructor(
    private readonly registry: ProjectRegistryPort,
    private readonly files: ProjectFilesPort,
  ) {}

  execute(query: DryRunQuery): Promise<DryRunQueryResult> {
    return Promise.resolve(this.run(query));
  }

  private run(query: DryRunQuery): DryRunQueryResult {
    if (!PROJECT_ID.test(query.id)) return { status: 'not_found' };
    const entry = this.registry.get(query.id);
    if (entry === null) return { status: 'not_found' };
    const storage = this.files.open(entry.folder);
    if (storage === null) return { status: 'refused', code: 'config_missing' };
    let context;
    try {
      context = planDryRun(storage, query.gate);
    } catch (error) {
      if (error instanceof DryRunPlanError)
        return { status: 'refused', code: error.code };
      throw error;
    }
    const { request } = query;
    const headers: Record<string, string> = {};
    if (request.origin !== null) headers['Origin'] = request.origin;
    if (request.contentType !== null)
      headers['Content-Type'] = request.contentType;
    if (request.requestMethod !== null)
      headers['Access-Control-Request-Method'] = request.requestMethod;
    return {
      status: 'ok',
      result: dryRun(context, {
        method: request.method,
        path: request.path,
        headers,
        body: request.body,
      }),
    };
  }
}
