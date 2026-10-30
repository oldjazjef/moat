import { Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { z } from 'zod';
import {
  ConfigEditError,
  ConfigError,
  moatJsonSchema,
  RECIPE_IDS,
  RECIPES,
} from '@moat/core';
import { DryRunQuery } from '../../gate-test/application/dry-run.handler';
import { SuggestPolicyQuery } from '../../gate-test/application/gate-test.handlers';
import { applyConfigEdit } from '../../project/application/apply-config-edit';
import { configHash } from '../../project/application/config-hash';
import { ConfigEditDto, toConfigEdit } from '../../project/dto/config-edit.dto';
import { ProjectService } from '../../project/project.service';
import { CONFIG_EDIT_OPS, PROJECT_ID } from '../../project/project.types';
import { type ProposalSource, ProposalStore } from '../application/proposals';
import { lineDiff } from '../domain/line-diff';

/**
 * What a tool may do. There is deliberately no third value: no tool signs a bundle, seals or
 * reads a secret, pins a gate, deploys, touches a key or sends a request anywhere (T-107). A
 * `propose` tool writes nothing either: it files a proposal the person confirms in Moat Desktop.
 */
export type ToolEffect = 'read' | 'propose';

export interface ToolContext {
  readonly source: ProposalSource;
  readonly conversationId: string | null;
}

export interface AssistantTool {
  /** `^[a-z_]{1,64}$`, the same for the chat and MCP. */
  readonly name: string;
  /** For the model (English). */
  readonly description: string;
  readonly effect: ToolEffect;
  readonly input: z.ZodType;
  run(input: unknown, context: ToolContext): Promise<unknown>;
}

/** A refused call, told to the model as a result it can act on, never thrown at the person. */
export class ToolError extends Error {
  constructor(
    readonly code:
      'invalid_arguments' | 'not_found' | 'refused' | 'unknown_tool',
    readonly detail: unknown = null,
  ) {
    super(code);
    this.name = 'ToolError';
  }
}

const projectId = z
  .string()
  .regex(PROJECT_ID)
  .describe('A project id from list_projects.');

const NAME = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

/** The edit's shape for the model; ConfigEditDto then checks it exactly as the HTTP route does. */
const editSchema = z
  .object({
    op: z.enum(CONFIG_EDIT_OPS),
    environment: NAME.optional(),
    gate: NAME.optional(),
    route: NAME.optional(),
    definition: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'addRoute/updateRoute: the whole route as in moat.yaml routes.<name> (method, path, upstream, upstreamPath, …).',
      ),
    upstream: NAME.optional(),
    upstreamDefinition: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'addUpstream/updateUpstream: the whole upstream as in moat.yaml upstreams.<name> (origin, auth, timeout).',
      ),
    recipe: z.enum(RECIPE_IDS).optional(),
    origins: z.array(z.string()).max(10).optional(),
  })
  .strict();

@Injectable()
export class AssistantTools {
  readonly all: readonly AssistantTool[];

  constructor(
    private readonly projects: ProjectService,
    private readonly queries: QueryBus,
    private readonly proposals: ProposalStore,
  ) {
    this.all = [
      {
        name: 'list_projects',
        description:
          'Lists the Moat projects on this computer: id, name, whether moat.yaml is valid, route and gate counts, gates that miss secrets or are locked.',
        effect: 'read',
        input: z.object({}).strict(),
        run: async () =>
          (await this.projects.list()).map(
            ({ folder: _folder, ...rest }) => rest,
          ),
      },
      {
        name: 'get_project',
        description:
          'One project: the compiled config (upstreams, routes, environments), the names of the secrets it uses, and per gate its trust mode, sealed secret names and versions (never values), missing secrets, latest bundle version and lock state.',
        effect: 'read',
        input: z.object({ projectId }).strict(),
        run: async (input) => {
          const { projectId: id } = input as { projectId: string };
          const view = await this.projects.get(id);
          if (view === null) throw new ToolError('not_found');
          const { folder: _folder, ...rest } = view;
          return rest;
        },
      },
      {
        name: 'get_config',
        description:
          "A project's moat.yaml as text, with its hash. Read it before proposing an edit.",
        effect: 'read',
        input: z.object({ projectId }).strict(),
        run: async (input) => {
          const { projectId: id } = input as { projectId: string };
          const config = await this.projects.configText(id);
          if (config === null) throw new ToolError('not_found');
          return config;
        },
      },
      {
        name: 'get_config_schema',
        description:
          'The JSON Schema of moat.yaml (version 1): every field a route, upstream, environment or gate may have.',
        effect: 'read',
        input: z.object({}).strict(),
        run: () => Promise.resolve(moatJsonSchema()),
      },
      {
        name: 'list_recipes',
        description:
          'Ready-made templates (recipes) for common APIs: the upstream and route each one adds and the secret name it uses.',
        effect: 'read',
        input: z.object({}).strict(),
        run: () =>
          Promise.resolve(
            RECIPE_IDS.map((id) => {
              const { testBody: _testBody, ...recipe } = RECIPES[id];
              return recipe;
            }),
          ),
      },
      {
        name: 'suggest_policy',
        description:
          'The local policy Moat suggests for this project (what a gate allows at most). Read only.',
        effect: 'read',
        input: z.object({ projectId }).strict(),
        run: async (input) => {
          const { projectId: id } = input as { projectId: string };
          const result = await this.queries.execute(new SuggestPolicyQuery(id));
          if (result.status === 'not_found') throw new ToolError('not_found');
          if (result.status === 'refused')
            throw new ToolError('refused', result.code);
          return result.policy;
        },
      },
      {
        name: 'dry_run',
        description:
          "What a gate would answer to one request, worked out locally from moat.yaml and the suggested policy. Sends nothing and opens no secret; the secret is shown as <SECRET>. Use it to explain a gate's behaviour or check a proposed route.",
        effect: 'read',
        input: z
          .object({
            projectId,
            gate: NAME.optional().describe(
              'A gate whose lock and sealed secrets count; omit for the config alone.',
            ),
            method: z.string().max(16),
            path: z.string().max(2048),
            origin: z.string().max(2048).optional(),
            contentType: z.string().max(256).optional(),
            body: z.string().max(65536).optional(),
          })
          .strict(),
        run: async (input) => {
          const request = input as {
            projectId: string;
            gate?: string;
            method: string;
            path: string;
            origin?: string;
            contentType?: string;
            body?: string;
          };
          const result = await this.queries.execute(
            new DryRunQuery(request.projectId, request.gate ?? null, {
              method: request.method,
              path: request.path,
              origin: request.origin ?? null,
              contentType: request.contentType ?? null,
              requestMethod: null,
              body: request.body ?? '',
            }),
          );
          if (result.status === 'not_found') throw new ToolError('not_found');
          if (result.status === 'refused')
            throw new ToolError('refused', result.code);
          return result.result;
        },
      },
      {
        name: 'propose_config_edit',
        description:
          "Proposes ONE change to a project's moat.yaml from the closed list of edits (environments, gate locks and assignment, routes, upstreams, recipes). Writes nothing: Moat Desktop shows the person the exact change and only «Ausführen» there applies it. Never put a secret value anywhere; upstreams name secrets only (auth.secret). Signing bundles, sealing secrets, pinning gates and deploying are not possible through the assistant — tell the person where to do them in Moat Desktop.",
        effect: 'propose',
        input: z
          .object({
            projectId,
            edit: editSchema,
            reason: z
              .string()
              .min(1)
              .max(300)
              .describe('One sentence for the person: why this change.'),
          })
          .strict(),
        run: (input, context) =>
          this.propose(
            input as {
              projectId: string;
              edit: Record<string, unknown>;
              reason: string;
            },
            context,
          ),
      },
    ];
  }

  byName(name: string): AssistantTool | null {
    return this.all.find((tool) => tool.name === name) ?? null;
  }

  /** Validates the arguments and runs the tool; every refusal is a ToolError. */
  async call(
    name: string,
    args: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const tool = this.byName(name);
    if (tool === null) throw new ToolError('unknown_tool');
    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success)
      throw new ToolError(
        'invalid_arguments',
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      );
    return tool.run(parsed.data, context);
  }

  private async propose(
    input: { projectId: string; edit: Record<string, unknown>; reason: string },
    context: ToolContext,
  ): Promise<unknown> {
    const view = await this.projects.get(input.projectId);
    const config = await this.projects.configText(input.projectId);
    if (view === null || config === null) throw new ToolError('not_found');
    if (config.text === null || config.hash === null)
      throw new ToolError('refused', 'config_missing');
    if (config.hash !== configHash(config.text))
      throw new ToolError('refused', 'changed');

    // Exactly the checks of POST /config/edits (whitelist, forbidden extras, nested DTOs).
    const dto = plainToInstance(ConfigEditDto, {
      ...input.edit,
      base: config.hash,
    });
    const issues = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (issues.length > 0)
      throw new ToolError(
        'invalid_arguments',
        issues.map((issue) => issue.property),
      );
    const edit = toConfigEdit(dto);
    if (edit === null) throw new ToolError('invalid_arguments', 'fields');

    let after: string;
    try {
      after = applyConfigEdit(config.text, edit);
    } catch (error) {
      if (error instanceof ConfigEditError)
        throw new ToolError('refused', {
          code: error.code,
          fields: error.fields,
        });
      if (error instanceof ConfigError)
        throw new ToolError('refused', 'config_invalid');
      throw error;
    }
    if (after === config.text)
      return { status: 'unchanged', note: 'moat.yaml already says this.' };

    const proposal = this.proposals.add({
      source: context.source,
      conversationId: context.conversationId,
      projectId: input.projectId,
      projectName: view.name,
      edit,
      base: config.hash,
      diff: lineDiff(config.text, after),
      reason: input.reason,
    });
    return {
      status: 'proposed',
      proposalId: proposal.id,
      note: 'Nothing is written yet. The person sees the change in Moat Desktop and applies it there with «Ausführen».',
    };
  }
}

/** JSON Schema of a tool's arguments for the providers and MCP (`type: object`, no `$schema`). */
export function inputSchemaOf(tool: AssistantTool): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(tool.input) as Record<
    string,
    unknown
  >;
  return schema;
}
