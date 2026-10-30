/**
 * Moat Desktop's assistant's one seam to a language model (taken from lazy-koins, same author,
 * MIT): provider-agnostic. Adapters live next to this file (`openai-compatible.adapter.ts`,
 * `anthropic.adapter.ts`); `AssistantModule` binds the port to a dispatcher that picks one per
 * call from the connection. The assistant never sees an HTTP client or a provider SDK.
 */

export const AI_PROVIDER_KINDS = ['openai_compatible', 'anthropic'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

/** Where to send a request — the user's settings with the key already decrypted. */
export interface AiConnection {
  readonly kind: AiProviderKind;
  /** Empty = the provider's default (`https://api.openai.com/v1`, `https://api.anthropic.com`). */
  readonly baseUrl: string;
  /** Empty = the provider's default model. */
  readonly model: string;
  /** Optional: a local Ollama / LM Studio needs none. Never logged. */
  readonly apiKey?: string;
}

export interface AiMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AiCompletionRequest {
  readonly system: string;
  /** The conversation so far; the last message is the user's. */
  readonly messages: readonly AiMessage[];
  /** The answer must be ONE JSON value conforming to this schema. */
  readonly output: {
    /** `[a-zA-Z0-9_-]`, e.g. `mapping_spec` — tool / schema name. */
    readonly name: string;
    readonly description: string;
    readonly schema: Record<string, unknown>;
  };
  readonly maxTokens?: number;
  /** Milliseconds until the request is aborted; default 120 s (local models are slow). */
  readonly timeoutMs?: number;
}

export interface AiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AiCompletion {
  /** The parsed JSON answer — untrusted, the caller validates it. */
  readonly json: unknown;
  /** The answer as text (JSON), for the follow-up message of a repair round. */
  readonly text: string;
  /** The model that answered, as the provider reports it. */
  readonly model: string;
  /** Only when the provider reports it. */
  readonly usage?: AiUsage;
}

/** Stable codes the app translates (`ai.errors.<code>`). */
export const AI_ERROR_CODES = [
  'invalidKey',
  'rateLimited',
  'network',
  'timeout',
  'badResponse',
  'providerError',
  'modelNotFound',
] as const;
export type AiErrorCode = (typeof AI_ERROR_CODES)[number];

/**
 * What went wrong, precisely enough to fix it (user rule: "genaue Fehlerinfos"). Every text is
 * already **redacted** (`redactSecrets`: no key, no `Bearer …`, no `sk-…`) and short (≤ 500
 * characters) when an adapter builds it; the gate redacts once more with the actual key.
 */
export interface AiErrorDetails {
  /** The provider's HTTP status. */
  readonly status?: number;
  /** The provider's own error text (OpenAI/Anthropic `error.message`, Ollama `error`). */
  readonly providerMessage?: string;
  /** OpenAI `error.type` / Anthropic `error.type` (`authentication_error`, …). */
  readonly providerType?: string;
  /** OpenAI `error.code` (`invalid_api_key`, `model_not_found`, …). */
  readonly providerCode?: string;
  /** `scheme://host/path` that was called — never the query. */
  readonly url?: string;
  readonly model?: string;
  /** A transport failure's system cause (`ECONNREFUSED`, `ENOTFOUND`, a TLS code) or a short reason. */
  readonly cause?: string;
  /** Set on `timeout`: how long was waited. */
  readonly timeoutMs?: number;
}

/**
 * A failed call, mapped to a code plus redacted details. Neither `message` nor `details` ever
 * contain the key or the request body.
 */
export class AiProviderError extends Error {
  constructor(
    readonly code: AiErrorCode,
    readonly details: AiErrorDetails = {},
  ) {
    const reason = details.providerMessage ?? details.cause;
    super(reason ? `${code}: ${reason}` : code);
    this.name = 'AiProviderError';
  }

  get status(): number | undefined {
    return this.details.status;
  }

  /** The same failure with context the caller knows (URL, model); existing values win. */
  with(context: AiErrorDetails): AiProviderError {
    return new AiProviderError(this.code, { ...context, ...this.details });
  }
}

/** A tool the model may call : the tool layer's name, description and JSON Schema. */
export interface AiToolSpec {
  /** `^[a-zA-Z0-9_-]{1,64}$` — both providers require it. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments; always `type: "object"`. */
  readonly inputSchema: Record<string, unknown>;
}

/** One tool call of the model; `input` is untrusted — the tool layer validates it. */
export interface AiToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** A turn of a conversation with tools, provider-neutral. */
export type AiChatMessage =
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string;
      readonly toolCalls?: readonly AiToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly name: string;
      /** The tool's result as text (JSON). */
      readonly content: string;
      readonly isError?: boolean;
    };

export interface AiConverseRequest {
  readonly system: string;
  readonly messages: readonly AiChatMessage[];
  readonly tools: readonly AiToolSpec[];
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
}

export interface AiConverseTurn {
  /** The model's text of this turn ('' when it only calls tools). */
  readonly text: string;
  readonly toolCalls: readonly AiToolCall[];
  readonly model: string;
  readonly usage?: AiUsage;
  /** Why the model stopped: answered, wants tools, ran out of tokens, or something else. */
  readonly stop: 'end' | 'toolUse' | 'maxTokens' | 'other';
}

export abstract class AiCompletionPort {
  abstract complete(
    connection: AiConnection,
    request: AiCompletionRequest,
  ): Promise<AiCompletion>;

  /**
   * One turn of a conversation with tool use : OpenAI-compatible `tools`/`tool_calls`,
   * Anthropic `tools`/`tool_use`. The caller runs the tools and calls again with their results
   * (the loop and its limit live in the chat, not here). Non-streaming.
   */
  abstract converse(
    connection: AiConnection,
    request: AiConverseRequest,
  ): Promise<AiConverseTurn>;
}
