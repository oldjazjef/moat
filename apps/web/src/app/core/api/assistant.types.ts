/**
 * `/api/assistant/*` (Moat Desktop) — a mirror of apps/api/src/assistant/application/chat-engine.ts
 * and proposals.ts. Keep in step. Never carries a token, a secret or a key.
 */
export type AiProviderKind = 'anthropic' | 'openai_compatible';

export interface AssistantStatus {
  readonly configured: boolean;
  readonly provider: {
    readonly kind: AiProviderKind;
    readonly baseUrl: string;
    readonly model: string;
    readonly hasKey: boolean;
  } | null;
}

/** The tools the assistant has (names as the API uses them); `assistant.tools.<name>`. */
export const ASSISTANT_TOOLS = [
  'list_projects',
  'get_project',
  'get_config',
  'get_config_schema',
  'list_recipes',
  'suggest_policy',
  'dry_run',
  'propose_config_edit',
] as const;

export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly at: string;
  readonly tools: readonly string[];
  readonly proposalIds: readonly string[];
  readonly cutShort?: boolean;
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Conversation extends ConversationSummary {
  readonly messages: readonly ChatMessage[];
  readonly proposals: readonly Proposal[];
}

export const PROPOSAL_STATUSES = [
  'pending',
  'done',
  'cancelled',
  'changed',
  'failed',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export type DiffEntry =
  | { readonly kind: ' ' | '-' | '+'; readonly text: string }
  | { readonly kind: '…'; readonly lines: number };

export interface Proposal {
  readonly id: string;
  readonly source: 'chat' | 'mcp';
  readonly conversationId: string | null;
  readonly projectId: string;
  readonly projectName: string;
  readonly edit: { readonly op: string };
  readonly diff: readonly DiffEntry[];
  readonly reason: string;
  readonly createdAt: string;
  readonly status: ProposalStatus;
  readonly error: string | null;
  readonly decidedAt: string | null;
}

/** Why a question got no answer: `assistant.errors.<code>`. */
export const ASSISTANT_ERRORS = [
  'not_configured',
  'invalidKey',
  'rateLimited',
  'network',
  'timeout',
  'badResponse',
  'providerError',
  'modelNotFound',
  'failed',
] as const;
export type AssistantError = (typeof ASSISTANT_ERRORS)[number];
