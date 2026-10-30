import type { AiConnection, AiConverseRequest } from './ai-completion.port';
import { AiProviderError } from './ai-completion.port';
import type { FetchLike } from './ai-http';
import { AnthropicAdapter, anthropicMessages } from './anthropic.adapter';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';

/** A recording `fetch` double (as in ai-adapters.spec.ts). */
function fakeFetch(...answers: Response[]) {
  const calls: {
    url: string;
    body: Record<string, unknown>;
    init: RequestInit;
  }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const next = answers.shift();
    if (!next) throw new Error('no answer queued');
    return next;
  };
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A conversation with one finished tool round trip. */
const request: AiConverseRequest = {
  system: 'You are the assistant.',
  tools: [
    {
      name: 'list_positions',
      description: 'Positions at 31.12.',
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { projectId: { type: 'string' } },
        required: ['projectId'],
      },
    },
  ],
  messages: [
    { role: 'user', content: 'Warum fehlt der Kurs für DOT?' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'call_1', name: 'list_positions', input: { projectId: 'p1' } },
      ],
    },
    {
      role: 'tool',
      toolCallId: 'call_1',
      name: 'list_positions',
      content: '{"positions":[]}',
    },
  ],
};

describe('OpenAiCompatibleAdapter.converse', () => {
  const connection: AiConnection = {
    kind: 'openai_compatible',
    baseUrl: 'http://localhost:11435/v1',
    model: 'fake',
    apiKey: 'sk-test-9999',
  };

  it('sends tools as functions and the round trip as tool_calls + role tool', async () => {
    const { fetchImpl, calls } = fakeFetch(
      json(200, {
        model: 'fake',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_2',
                  type: 'function',
                  function: {
                    name: 'list_rates',
                    arguments: '{"projectId":"p1","asset":"DOT"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 7 },
      }),
    );
    const turn = await new OpenAiCompatibleAdapter(fetchImpl).converse(
      connection,
      request,
    );
    expect(turn).toEqual({
      text: '',
      toolCalls: [
        {
          id: 'call_2',
          name: 'list_rates',
          input: { projectId: 'p1', asset: 'DOT' },
        },
      ],
      model: 'fake',
      usage: { inputTokens: 50, outputTokens: 7 },
      stop: 'toolUse',
    });
    const body = calls[0]?.body as {
      tools: {
        type: string;
        function: { name: string; parameters: unknown };
      }[];
      tool_choice: string;
      messages: Record<string, unknown>[];
    };
    expect(calls[0]?.url).toBe('http://localhost:11435/v1/chat/completions');
    expect(body.tool_choice).toBe('auto');
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: {
        name: 'list_positions',
        description: 'Positions at 31.12.',
        parameters: {
          type: 'object',
          properties: { projectId: { type: 'string' } },
          required: ['projectId'],
        },
      },
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are the assistant.' },
      { role: 'user', content: 'Warum fehlt der Kurs für DOT?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'list_positions',
              arguments: '{"projectId":"p1"}',
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"positions":[]}' },
    ]);
  });

  it('returns the text of a final answer and keeps bad arguments for the tool layer', async () => {
    const { fetchImpl } = fakeFetch(
      json(200, {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: 'DOT hat keinen Kurs.',
              tool_calls: [
                { function: { name: 'navigate', arguments: '{not json' } },
              ],
            },
          },
        ],
      }),
    );
    const turn = await new OpenAiCompatibleAdapter(fetchImpl).converse(
      connection,
      request,
    );
    expect(turn.text).toBe('DOT hat keinen Kurs.');
    expect(turn.toolCalls).toEqual([
      { id: 'call_0', name: 'navigate', input: { invalidJson: '{not json' } },
    ]);
  });

  it('maps provider errors to codes, without the key', async () => {
    const { fetchImpl } = fakeFetch(
      json(401, {
        error: {
          message: 'Incorrect API key sk-test-9999',
          code: 'invalid_api_key',
        },
      }),
    );
    const error = await new OpenAiCompatibleAdapter(fetchImpl)
      .converse(connection, request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).code).toBe('invalidKey');
    expect(JSON.stringify((error as AiProviderError).details)).not.toContain(
      'sk-test-9999',
    );
  });
});

describe('AnthropicAdapter.converse', () => {
  const connection: AiConnection = {
    kind: 'anthropic',
    baseUrl: '',
    model: '',
    apiKey: 'sk-ant-test',
  };

  it('sends tools with input_schema and tool results as user tool_result blocks', async () => {
    const { fetchImpl, calls } = fakeFetch(
      json(200, {
        model: 'claude-sonnet-5-5',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Ich schaue nach.' },
          {
            type: 'tool_use',
            id: 'toolu_9',
            name: 'list_rates',
            input: { projectId: 'p1', asset: 'DOT' },
          },
        ],
        usage: { input_tokens: 80, output_tokens: 12 },
      }),
    );
    const turn = await new AnthropicAdapter(fetchImpl).converse(
      connection,
      request,
    );
    expect(turn).toEqual({
      text: 'Ich schaue nach.',
      toolCalls: [
        {
          id: 'toolu_9',
          name: 'list_rates',
          input: { projectId: 'p1', asset: 'DOT' },
        },
      ],
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 80, outputTokens: 12 },
      stop: 'toolUse',
    });
    const body = calls[0]?.body as {
      tools: { name: string; input_schema: Record<string, unknown> }[];
      tool_choice: unknown;
      messages: unknown[];
      system: string;
    };
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.system).toBe('You are the assistant.');
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.tools[0]?.input_schema).toEqual({
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    });
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Warum fehlt der Kurs für DOT?' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'list_positions',
            input: { projectId: 'p1' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: '{"positions":[]}',
          },
        ],
      },
    ]);
  });

  it('merges consecutive turns of one role (several tool results, then the next question)', () => {
    const merged = anthropicMessages([
      { role: 'user', content: 'a' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 't1', name: 'x', input: {} },
          { id: 't2', name: 'y', input: {} },
        ],
      },
      { role: 'tool', toolCallId: 't1', name: 'x', content: '1' },
      {
        role: 'tool',
        toolCallId: 't2',
        name: 'y',
        content: '2',
        isError: true,
      },
      { role: 'user', content: '[App] Ausgeführt' },
      { role: 'user', content: 'b' },
    ]);
    expect(merged.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(merged[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '1' },
      { type: 'tool_result', tool_use_id: 't2', content: '2', is_error: true },
      { type: 'text', text: '[App] Ausgeführt' },
      { type: 'text', text: 'b' },
    ]);
  });
});
