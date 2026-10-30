import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PROJECT_ID } from '../../project/project.types';
import { ProjectService } from '../../project/project.service';
import {
  type AiChatMessage,
  AiCompletionPort,
  type AiErrorCode,
  type AiErrorDetails,
  AiProviderError,
  type AiToolSpec,
} from '../ai/ai-completion.port';
import { redactDetails } from '../ai/redact';
import { AssistantConnectionPort } from '../ports/assistant-connection.port';
import {
  AssistantTools,
  inputSchemaOf,
  ToolError,
} from '../tools/assistant-tools';
import { type Proposal, ProposalStore } from './proposals';
import { systemPrompt } from '../domain/system-prompt';

/** Model ↔ tool round trips per question; then the answer is cut short. */
export const MAX_TOOL_STEPS = 8;
/** History sent with a question. */
export const MAX_HISTORY_MESSAGES = 40;
/** A tool result as the model sees it, at most this long (the schema is ~18 KB). */
export const MAX_TOOL_RESULT_CHARS = 24_000;
/** Older tool results in the history are cut harder. */
const MAX_HISTORY_TOOL_CHARS = 2_000;
export const MAX_QUESTION_LENGTH = 4_000;
/** Conversations kept in memory; the oldest goes first. */
export const MAX_CONVERSATIONS = 30;
const MAX_ANSWER_TOKENS = 4096;
const CHAT_TIMEOUT_MS = 120_000;

export type ChatLocale = 'de-CH' | 'en';

/** A message as the page shows it. */
export interface ChatMessageView {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly at: string;
  /** Tools the model used for this answer (names only). */
  readonly tools: readonly string[];
  readonly proposalIds: readonly string[];
  /** The answer stopped at MAX_TOOL_STEPS. */
  readonly cutShort?: boolean;
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationView extends ConversationSummary {
  readonly messages: readonly ChatMessageView[];
  readonly proposals: readonly ProposalView[];
}

/** A proposal as the page shows it: what changes where, and its state. */
export type ProposalView = Omit<Proposal, 'base'>;

export type AskResult =
  | { readonly status: 'not_found' }
  | { readonly status: 'not_configured' }
  | {
      readonly status: 'failed';
      readonly code: AiErrorCode;
      readonly details: AiErrorDetails;
    }
  | { readonly status: 'ok'; readonly conversation: ConversationView };

interface Conversation {
  readonly id: string;
  title: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly messages: ChatMessageView[];
  /** What the model has seen, in its own shape. */
  history: AiChatMessage[];
}

export function proposalView(proposal: Proposal): ProposalView {
  const { base: _base, ...view } = proposal;
  return view;
}

/**
 * The assistant (Moat Desktop only): question → model with the read tools and the one proposal
 * tool → read tools run at once, a proposal is filed and shown → … at most MAX_TOOL_STEPS times.
 * Conversations live in memory for this launch only; nothing about them is written to disk. A
 * failed provider call leaves the conversation as it was, so the question can be sent again.
 */
@Injectable()
export class ChatEngine {
  private readonly conversations = new Map<string, Conversation>();

  constructor(
    private readonly ai: AiCompletionPort,
    private readonly connection: AssistantConnectionPort,
    private readonly tools: AssistantTools,
    private readonly proposals: ProposalStore,
    private readonly projects: ProjectService,
  ) {}

  list(): ConversationSummary[] {
    return [...this.conversations.values()]
      .map(({ id, title, createdAt, updatedAt }) => ({
        id,
        title,
        createdAt,
        updatedAt,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  create(): ConversationView {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomBytes(16).toString('base64url'),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      history: [],
    };
    this.conversations.set(conversation.id, conversation);
    while (this.conversations.size > MAX_CONVERSATIONS) {
      const oldest = this.list().at(-1);
      if (oldest === undefined) break;
      this.remove(oldest.id);
    }
    return this.view(conversation);
  }

  get(id: string): ConversationView | null {
    const conversation = this.conversations.get(id);
    return conversation === undefined ? null : this.view(conversation);
  }

  remove(id: string): boolean {
    this.proposals.forgetConversation(id);
    return this.conversations.delete(id);
  }

  async ask(
    id: string,
    question: { text: string; projectId: string | null; locale: ChatLocale },
  ): Promise<AskResult> {
    const conversation = this.conversations.get(id);
    if (conversation === undefined) return { status: 'not_found' };
    const connection = await this.connection.open();
    if (connection === null) return { status: 'not_configured' };

    const context =
      question.projectId !== null && PROJECT_ID.test(question.projectId)
        ? await this.projects.get(question.projectId)
        : null;
    const system = systemPrompt(
      question.locale,
      context === null ? null : { id: context.id, name: context.name },
    );
    const specs: AiToolSpec[] = this.tools.all.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: inputSchemaOf(tool),
    }));

    const turn: AiChatMessage[] = [{ role: 'user', content: question.text }];
    const used = new Set<string>();
    const proposalIds: string[] = [];
    let answer = '';
    let cutShort = true;
    try {
      for (let step = 0; step < MAX_TOOL_STEPS; step++) {
        const reply = await this.ai.converse(connection, {
          system,
          messages: [...trimmedHistory(conversation.history), ...turn],
          tools: specs,
          maxTokens: MAX_ANSWER_TOKENS,
          timeoutMs: CHAT_TIMEOUT_MS,
        });
        turn.push({
          role: 'assistant',
          content: reply.text,
          ...(reply.toolCalls.length > 0 ? { toolCalls: reply.toolCalls } : {}),
        });
        if (reply.toolCalls.length === 0) {
          answer = reply.text;
          cutShort = false;
          break;
        }
        for (const call of reply.toolCalls) {
          used.add(call.name);
          const result = await this.runTool(call.name, call.input, id);
          if (
            typeof result.value === 'object' &&
            result.value !== null &&
            'proposalId' in result.value &&
            typeof result.value.proposalId === 'string'
          )
            proposalIds.push(result.value.proposalId);
          turn.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: cut(JSON.stringify(result.value), MAX_TOOL_RESULT_CHARS),
            ...(result.error ? { isError: true } : {}),
          });
        }
      }
    } catch (error) {
      // Proposals filed during a failed turn would hang without their answer.
      for (const proposalId of proposalIds) this.proposals.claim(proposalId);
      if (error instanceof AiProviderError)
        return {
          status: 'failed',
          code: error.code,
          details: redactDetails(error.details, [connection.apiKey]),
        };
      return {
        status: 'failed',
        code: 'providerError',
        details: {},
      };
    }

    const now = new Date().toISOString();
    if (conversation.title === '')
      conversation.title = question.text.replace(/\s+/g, ' ').slice(0, 80);
    conversation.messages.push(
      {
        role: 'user',
        text: question.text,
        at: now,
        tools: [],
        proposalIds: [],
      },
      {
        role: 'assistant',
        text: answer,
        at: now,
        tools: [...used],
        proposalIds,
        ...(cutShort ? { cutShort: true } : {}),
      },
    );
    if (cutShort)
      turn.push({
        role: 'assistant',
        content: '[stopped: too many tool steps]',
      });
    conversation.history = [...conversation.history, ...turn];
    conversation.updatedAt = now;
    return { status: 'ok', conversation: this.view(conversation) };
  }

  private async runTool(
    name: string,
    input: unknown,
    conversationId: string,
  ): Promise<{ value: unknown; error: boolean }> {
    try {
      return {
        value: await this.tools.call(name, input, {
          source: 'chat',
          conversationId,
        }),
        error: false,
      };
    } catch (error) {
      if (error instanceof ToolError)
        return {
          value: { error: error.code, detail: error.detail },
          error: true,
        };
      return { value: { error: 'failed' }, error: true };
    }
  }

  private view(conversation: Conversation): ConversationView {
    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: conversation.messages,
      proposals: this.proposals
        .list({ conversationId: conversation.id })
        .map(proposalView),
    };
  }
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[cut]`;
}

/**
 * The last MAX_HISTORY_MESSAGES of the history, starting at a user message (a tool result
 * without its call is refused by both providers), older tool results cut harder.
 */
export function trimmedHistory(
  history: readonly AiChatMessage[],
): AiChatMessage[] {
  let start = Math.max(0, history.length - MAX_HISTORY_MESSAGES);
  while (start < history.length && history[start]?.role !== 'user') start++;
  return history
    .slice(start)
    .map((message) =>
      message.role === 'tool'
        ? { ...message, content: cut(message.content, MAX_HISTORY_TOOL_CHARS) }
        : message,
    );
}
