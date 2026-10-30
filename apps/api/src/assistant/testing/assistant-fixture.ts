import { createHash } from 'node:crypto';
import type { QueryBus } from '@nestjs/cqrs';
import type { ProjectService } from '../../project/project.service';
import type { ConfigEdit, ProjectView } from '../../project/project.types';
import { applyConfigEdit } from '../../project/application/apply-config-edit';
import {
  type AiConnection,
  AiCompletionPort,
  type AiConverseRequest,
  type AiConverseTurn,
} from '../ai/ai-completion.port';
import { ChatEngine } from '../application/chat-engine';
import { ProposalDecisions } from '../application/proposal-decisions';
import { ProposalStore } from '../application/proposals';
import { McpServer } from '../mcp/mcp-server';
import { MainProcessConnection } from '../ports/assistant-connection.port';
import { AssistantTools } from '../tools/assistant-tools';

export const PROJECT = 'assistantProject000000';
export const CONFIG = `version: 1
# the newsletter
upstreams:
  hubspot:
    origin: "https://api.hubapi.com"
routes:
  newsletter:
    method: POST
    path: "/newsletter"
    upstream: hubspot
    upstreamPath: "/contacts"
`;
/** TEST ONLY: never a real key. */
export const PLANTED_KEY = 'sk-test-PLANTED-0123456789abcdef';

const hash = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** A scripted model: each call returns the next turn; the requests are kept for assertions. */
export class ScriptedAi extends AiCompletionPort {
  readonly requests: AiConverseRequest[] = [];
  constructor(private readonly turns: (AiConverseTurn | Error)[]) {
    super();
  }
  complete(): never {
    throw new Error('not used');
  }
  converse(
    _connection: AiConnection,
    request: AiConverseRequest,
  ): Promise<AiConverseTurn> {
    this.requests.push(structuredClone(request));
    const next = this.turns.shift();
    if (next === undefined) throw new Error('script ran out');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  }
}

export function turn(
  text: string,
  calls: { name: string; input: unknown }[] = [],
): AiConverseTurn {
  return {
    text,
    toolCalls: calls.map((call, index) => ({ id: `call${index}`, ...call })),
    model: 'scripted',
    stop: calls.length > 0 ? 'toolUse' : 'end',
  };
}

/** The assistant over an in-memory project whose moat.yaml `files.text` holds. */
export function assistantSetup(turns: (AiConverseTurn | Error)[] = []) {
  const files = { text: CONFIG as string | null, writes: 0 };
  const projects = {
    list: () =>
      Promise.resolve([
        {
          id: PROJECT,
          name: 'shop',
          folder: '/home/someone/shop',
          config: 'valid' as const,
          routes: 1,
          gates: 0,
          gatesMissingSecrets: [],
          gatesLocked: [],
        },
      ]),
    get: (id: string) =>
      Promise.resolve(
        id === PROJECT
          ? ({
              id,
              name: 'shop',
              folder: '/home/someone/shop',
              project: null,
              configHash: files.text === null ? null : hash(files.text),
            } satisfies ProjectView)
          : null,
      ),
    configText: (id: string) =>
      Promise.resolve(
        id === PROJECT
          ? {
              text: files.text,
              hash: files.text === null ? null : hash(files.text),
            }
          : null,
      ),
    editConfig: (id: string, base: string, edit: ConfigEdit) => {
      if (id !== PROJECT)
        return Promise.resolve({ status: 'not_found' as const });
      if (files.text === null || hash(files.text) !== base)
        return Promise.resolve({ status: 'changed' as const });
      files.text = applyConfigEdit(files.text, edit);
      files.writes++;
      return Promise.resolve({ status: 'saved' as const });
    },
  } as unknown as ProjectService;
  const queries = {
    execute: () => Promise.resolve({ status: 'not_found' }),
  } as unknown as QueryBus;
  const store = new ProposalStore();
  const tools = new AssistantTools(projects, queries, store);
  const connection = new MainProcessConnection();
  connection.register({
    summary: () => ({
      kind: 'anthropic',
      baseUrl: '',
      model: '',
      hasKey: true,
    }),
    open: () =>
      Promise.resolve({
        kind: 'anthropic',
        baseUrl: '',
        model: '',
        apiKey: PLANTED_KEY,
      }),
  });
  const ai = new ScriptedAi(turns);
  const chat = new ChatEngine(ai, connection, tools, store, projects);
  const decisions = new ProposalDecisions(store, projects);
  const mcp = new McpServer(tools);
  return { files, store, tools, connection, ai, chat, decisions, mcp };
}
