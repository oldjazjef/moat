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
import {
  extractJson,
  type FetchLike,
  joinUrl,
  plainSchema,
  postJson,
} from './ai-http';
import { safeUrl } from './redact';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-4.1-mini';

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Any OpenAI-compatible Chat Completions API: OpenAI, Mistral, Groq, OpenRouter, a local Ollama
 * (`http://localhost:11434/v1`) or LM Studio. Asks for structured output with
 * `response_format: { type: 'json_schema' }` first; a server that rejects it (400/422 — older
 * Ollama builds, some gateways) is asked again without, with the schema in the instructions,
 * and the JSON is taken from the text.
 */
export class OpenAiCompatibleAdapter extends AiCompletionPort {
  constructor(private readonly fetchImpl: FetchLike = fetch) {
    super();
  }

  async complete(
    connection: AiConnection,
    request: AiCompletionRequest,
  ): Promise<AiCompletion> {
    const url = joinUrl(
      connection.baseUrl || OPENAI_DEFAULT_BASE_URL,
      '/chat/completions',
    );
    const headers: Record<string, string> = connection.apiKey
      ? { authorization: `Bearer ${connection.apiKey}` }
      : {};
    const model = connection.model || OPENAI_DEFAULT_MODEL;
    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const base = {
      model,
      temperature: 0,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    };

    let body: ChatResponse;
    try {
      body = (
        await postJson(
          this.fetchImpl,
          url,
          headers,
          {
            ...base,
            messages: [
              { role: 'system', content: request.system },
              ...messages,
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: request.output.name,
                description: request.output.description,
                schema: plainSchema(request.output.schema),
                strict: false,
              },
            },
          },
          request.timeoutMs,
        )
      ).body as ChatResponse;
    } catch (error) {
      if (
        !(error instanceof AiProviderError) ||
        error.code !== 'providerError' ||
        (error.status !== 400 && error.status !== 422)
      ) {
        throw error;
      }
      // Fallback: plain JSON in the text.
      body = (
        await postJson(
          this.fetchImpl,
          url,
          headers,
          {
            ...base,
            messages: [
              {
                role: 'system',
                content: `${request.system}\n\nAnswer with exactly one JSON object and nothing else. It must conform to this JSON Schema (${request.output.name}: ${request.output.description}):\n${JSON.stringify(plainSchema(request.output.schema))}`,
              },
              ...messages,
            ],
          },
          request.timeoutMs,
        )
      ).body as ChatResponse;
    }

    const context = { url: safeUrl(url), model: body.model ?? model };
    const text = body.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim() === '') {
      throw new AiProviderError('badResponse', {
        ...context,
        cause: 'the answer has no message content',
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
      model: body.model ?? model,
      usage: usageOf(body.usage),
    };
  }

  /**
   * Chat Completions with `tools` (`type: function`) and `tool_choice: auto`; the
   * answer's `tool_calls` carry the arguments as a JSON string. Tool results go back as
   * `role: tool` messages with their `tool_call_id`.
   */
  async converse(
    connection: AiConnection,
    request: AiConverseRequest,
  ): Promise<AiConverseTurn> {
    const url = joinUrl(
      connection.baseUrl || OPENAI_DEFAULT_BASE_URL,
      '/chat/completions',
    );
    const headers: Record<string, string> = connection.apiKey
      ? { authorization: `Bearer ${connection.apiKey}` }
      : {};
    const model = connection.model || OPENAI_DEFAULT_MODEL;
    const { body } = await postJson(
      this.fetchImpl,
      url,
      headers,
      {
        model,
        temperature: 0,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        messages: [
          { role: 'system', content: request.system },
          ...request.messages.map(openAiMessage),
        ],
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: plainSchema(tool.inputSchema),
                },
              })),
              tool_choice: 'auto',
            }
          : {}),
      },
      request.timeoutMs,
    );
    const response = body as ToolChatResponse;
    const choice = response.choices?.[0];
    const message = choice?.message;
    if (!message) {
      throw new AiProviderError('badResponse', {
        url: safeUrl(url),
        model: response.model ?? model,
        cause: 'the answer has no message',
      });
    }
    const toolCalls = (message.tool_calls ?? [])
      .filter((call) => typeof call.function?.name === 'string')
      .map((call, index) => ({
        id: call.id || `call_${index}`,
        name: call.function?.name ?? '',
        input: parseArguments(call.function?.arguments),
      }));
    const finish = choice?.finish_reason;
    return {
      text: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      model: response.model ?? model,
      usage: usageOf(response.usage),
      stop:
        toolCalls.length > 0 || finish === 'tool_calls'
          ? 'toolUse'
          : finish === 'length'
            ? 'maxTokens'
            : finish === 'stop' || finish === undefined || finish === null
              ? 'end'
              : 'other',
    };
  }
}

interface ToolChatResponse {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: {
        id?: string;
        function?: { name?: string; arguments?: string | object };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function usageOf(usage: ChatResponse['usage']): AiUsage | undefined {
  return usage &&
    typeof usage.prompt_tokens === 'number' &&
    typeof usage.completion_tokens === 'number'
    ? {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
      }
    : undefined;
}

/** A provider-neutral turn as an OpenAI chat message. */
function openAiMessage(message: AiChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content === '' ? null : message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

/**
 * The arguments of a tool call: a JSON string (OpenAI), sometimes already an object (some
 * gateways). Unparseable text is passed on as is so the tool layer reports it to the model.
 */
function parseArguments(raw: string | object | undefined): unknown {
  if (raw === undefined || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { invalidJson: raw.slice(0, 500) };
  }
}
