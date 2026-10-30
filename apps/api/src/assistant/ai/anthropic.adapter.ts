import {
  type AiChatMessage,
  type AiCompletion,
  AiCompletionPort,
  type AiCompletionRequest,
  type AiConnection,
  type AiConverseRequest,
  type AiConverseTurn,
  AiProviderError,
  type AiUsage,
} from './ai-completion.port';
import { Logger } from '@nestjs/common';
import {
  extractJson,
  type FetchLike,
  joinUrl,
  plainSchema,
  postJson,
} from './ai-http';
import { safeUrl } from './redact';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

interface MessagesResponse {
  model?: string;
  content?: {
    type: string;
    id?: string;
    name?: string;
    input?: unknown;
    text?: string;
  }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Current models think adaptively before answering, and that thinking counts against
 * `max_tokens`: a tiny budget (the connection test asks for 50) would cut the JSON off.
 */
const MIN_STRUCTURED_MAX_TOKENS = 2048;

function maxTokensOf(request: AiCompletionRequest): number {
  return Math.max(
    request.maxTokens ?? DEFAULT_MAX_TOKENS,
    MIN_STRUCTURED_MAX_TOKENS,
  );
}

/** Keywords structured outputs do not accept (the caller validates the answer with zod anyway). */
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);
const SUPPORTED_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/**
 * The JSON Schema as structured outputs accept it: unsupported constraints dropped, every object
 * closed with `additionalProperties: false`, unknown string formats removed.
 */
export function structuredOutputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(structuredOutputSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'format' && !SUPPORTED_FORMATS.has(String(value))) continue;
    if (key === 'additionalProperties') continue;
    out[key] =
      key === 'enum' || key === 'const' ? value : structuredOutputSchema(value);
  }
  if (out['type'] === 'object' || 'properties' in out) {
    out['additionalProperties'] = false;
  }
  return out;
}

/** The structured call was refused as a request (400/422): unknown parameter or schema it cannot compile. */
function structuredOutputsRefused(error: unknown): error is AiProviderError {
  return (
    error instanceof AiProviderError &&
    error.code === 'providerError' &&
    (error.status === 400 || error.status === 422)
  );
}

/**
 * The Anthropic Messages API (`POST /v1/messages`, `x-api-key`, `anthropic-version`).
 *
 * Structured output through **structured outputs** (`output_config.format` = `json_schema`): the
 * answer is a text block holding JSON that matches the schema. Forced tool use
 * (`tool_choice: {type: "tool"}`) is refused with a 400 by the current models (Claude Sonnet 5.5,
 * Opus 5.5, Fable 5.1) and is never used. When the structured call is refused with a 400 (an
 * endpoint without `output_config`, or a schema structured outputs cannot compile), the adapter
 * asks for **JSON in the text** with the schema in the prompt — works on every model; the caller
 * validates the answer with zod and has a repair round. The first refusal is kept in the error
 * details if the fallback fails too.
 */
export class AnthropicAdapter extends AiCompletionPort {
  private readonly logger = new Logger(AnthropicAdapter.name);

  constructor(private readonly fetchImpl: FetchLike = fetch) {
    super();
  }

  async complete(
    connection: AiConnection,
    request: AiCompletionRequest,
  ): Promise<AiCompletion> {
    try {
      return await this.completeStructured(connection, request);
    } catch (error) {
      if (!structuredOutputsRefused(error)) throw error;
      this.logger.warn(
        `structured outputs refused, retrying with JSON in the text: ${error.message}`,
      );
      try {
        return await this.completeAsTextJson(connection, request);
      } catch (fallbackError) {
        // Both failed: report the fallback's failure, with the structured call's reason attached.
        if (fallbackError instanceof AiProviderError) {
          throw new AiProviderError(fallbackError.code, {
            ...fallbackError.details,
            cause: [
              fallbackError.details.cause,
              `structured outputs: ${error.details.providerMessage ?? error.message}`,
            ]
              .filter(Boolean)
              .join(' · '),
          });
        }
        throw fallbackError;
      }
    }
  }

  private async completeStructured(
    connection: AiConnection,
    request: AiCompletionRequest,
  ): Promise<AiCompletion> {
    const { url, model, headers } = this.target(connection);
    const { body } = await postJson(
      this.fetchImpl,
      url,
      headers,
      {
        model,
        max_tokens: maxTokensOf(request),
        system: request.system,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        output_config: {
          format: {
            type: 'json_schema',
            schema: structuredOutputSchema(request.output.schema),
          },
        },
      },
      request.timeoutMs,
    );
    const response = body as MessagesResponse;
    const text = (response.content ?? [])
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiProviderError('badResponse', {
        url: safeUrl(url),
        model: response.model ?? model,
        cause:
          response.stop_reason === 'max_tokens'
            ? 'the answer was cut off (max_tokens)'
            : response.stop_reason === 'refusal'
              ? 'the model declined the request'
              : 'the answer was not the requested JSON',
      });
    }
    return {
      json,
      text,
      model: response.model ?? model,
      usage: usageOf(response.usage),
    };
  }

  /** Fallback: JSON in the text, the schema in the system prompt (no tool_choice). */
  private async completeAsTextJson(
    connection: AiConnection,
    request: AiCompletionRequest,
  ): Promise<AiCompletion> {
    const { url, model, headers } = this.target(connection);
    const { body } = await postJson(
      this.fetchImpl,
      url,
      headers,
      {
        model,
        max_tokens: maxTokensOf(request),
        system: `${request.system}\n\nAnswer with exactly one JSON object and nothing else — no prose, no code fence. It must conform to this JSON Schema (${request.output.name}: ${request.output.description}):\n${JSON.stringify(plainSchema(request.output.schema))}`,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      },
      request.timeoutMs,
    );
    const response = body as MessagesResponse;
    const context = { url: safeUrl(url), model: response.model ?? model };
    const text = (response.content ?? [])
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('');
    if (text.trim() === '') {
      throw new AiProviderError('badResponse', {
        ...context,
        cause:
          response.stop_reason === 'refusal'
            ? 'the model declined the request'
            : 'the answer has no text',
      });
    }
    let json: unknown;
    try {
      json = extractJson(text);
    } catch (error) {
      throw error instanceof AiProviderError ? error.with(context) : error;
    }
    return {
      json,
      text,
      model: response.model ?? model,
      usage: usageOf(response.usage),
    };
  }

  private target(connection: AiConnection): {
    url: string;
    model: string;
    headers: Record<string, string>;
  } {
    return {
      url: joinUrl(
        connection.baseUrl || ANTHROPIC_DEFAULT_BASE_URL,
        '/v1/messages',
      ),
      model: connection.model || ANTHROPIC_DEFAULT_MODEL,
      headers: {
        'anthropic-version': ANTHROPIC_VERSION,
        ...(connection.apiKey ? { 'x-api-key': connection.apiKey } : {}),
      },
    };
  }

  /**
   * Messages with `tools` (`tool_choice` auto). The answer's `tool_use` blocks are the
   * calls; results go back as `tool_result` blocks in the next user turn. Consecutive turns of
   * the same role are merged — the API wants them alternating.
   */
  async converse(
    connection: AiConnection,
    request: AiConverseRequest,
  ): Promise<AiConverseTurn> {
    const url = joinUrl(
      connection.baseUrl || ANTHROPIC_DEFAULT_BASE_URL,
      '/v1/messages',
    );
    const model = connection.model || ANTHROPIC_DEFAULT_MODEL;
    const { body } = await postJson(
      this.fetchImpl,
      url,
      {
        'anthropic-version': ANTHROPIC_VERSION,
        ...(connection.apiKey ? { 'x-api-key': connection.apiKey } : {}),
      },
      {
        model,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: request.system,
        messages: anthropicMessages(request.messages),
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: {
                  type: 'object',
                  ...plainSchema(tool.inputSchema),
                },
              })),
              tool_choice: { type: 'auto' },
            }
          : {}),
      },
      request.timeoutMs,
    );
    const response = body as MessagesResponse & { stop_reason?: string };
    if (!Array.isArray(response.content)) {
      throw new AiProviderError('badResponse', {
        url: safeUrl(url),
        model: response.model ?? model,
        cause: 'the answer has no content',
      });
    }
    const text = response.content
      .filter(
        (block) => block.type === 'text' && typeof block.text === 'string',
      )
      .map((block) => block.text)
      .join('');
    const toolCalls = response.content
      .filter((block) => block.type === 'tool_use' && block.name)
      .map((block, index) => ({
        id: block.id ?? `toolu_${index}`,
        name: block.name ?? '',
        input: block.input ?? {},
      }));
    const stop = response.stop_reason;
    return {
      text,
      toolCalls,
      model: response.model ?? model,
      usage: usageOf(response.usage),
      stop:
        toolCalls.length > 0 || stop === 'tool_use'
          ? 'toolUse'
          : stop === 'max_tokens'
            ? 'maxTokens'
            : stop === 'end_turn' || stop === undefined
              ? 'end'
              : 'other',
    };
  }
}

function usageOf(usage: MessagesResponse['usage']): AiUsage | undefined {
  return usage &&
    typeof usage.input_tokens === 'number' &&
    typeof usage.output_tokens === 'number'
    ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
    : undefined;
}

type AnthropicBlock = Record<string, unknown>;

/** Provider-neutral turns as Anthropic messages: tool results become user `tool_result` blocks. */
export function anthropicMessages(
  messages: readonly AiChatMessage[],
): { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] {
  const out: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          ...(message.isError ? { is_error: true } : {}),
        },
      ]);
    } else if (message.role === 'assistant') {
      push('assistant', [
        ...(message.content !== ''
          ? [{ type: 'text', text: message.content }]
          : []),
        ...(message.toolCalls ?? []).map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input ?? {},
        })),
      ]);
    } else {
      push('user', [{ type: 'text', text: message.content }]);
    }
  }
  return out;
}
