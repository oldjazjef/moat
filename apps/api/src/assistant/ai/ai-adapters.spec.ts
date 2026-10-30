import {
  type AiCompletionRequest,
  type AiConnection,
  AiProviderError,
} from './ai-completion.port';
import { extractJson, type FetchLike } from './ai-http';
import { AnthropicAdapter, structuredOutputSchema } from './anthropic.adapter';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';
import { ProviderSwitchingAiCompletion } from './provider-switching.adapter';
import { redactSecrets, safeUrl } from './redact';

/** A recording `fetch` double: answers queued responses in order, never touches the network. */
function fakeFetch(...answers: (Response | Error)[]) {
  const calls: {
    url: string;
    init: RequestInit;
    body: Record<string, unknown>;
  }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const next = answers.shift();
    if (!next) throw new Error('no answer queued');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const request: AiCompletionRequest = {
  system: 'You write mappings.',
  messages: [{ role: 'user', content: '{"fileName":"x.csv"}' }],
  output: {
    name: 'mapping_spec',
    description: 'A mapping',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { name: { type: 'string' } },
    },
  },
};

const openAi: AiConnection = {
  kind: 'openai_compatible',
  baseUrl: 'http://localhost:11434/v1/',
  model: 'llama3.1',
  apiKey: 'sk-test-1234',
};

describe('OpenAiCompatibleAdapter', () => {
  it('asks for json_schema output and parses the answer + usage', async () => {
    const { fetchImpl, calls } = fakeFetch(
      json(200, {
        model: 'llama3.1',
        choices: [{ message: { content: '{"name":"Kraken"}' } }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      }),
    );
    const answer = await new OpenAiCompatibleAdapter(fetchImpl).complete(
      openAi,
      request,
    );
    expect(answer).toMatchObject({
      json: { name: 'Kraken' },
      model: 'llama3.1',
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(
      (call?.init.headers as Record<string, string>)['authorization'],
    ).toBe('Bearer sk-test-1234');
    expect(call?.body['response_format']).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'mapping_spec', schema: { type: 'object' } },
    });
    // `$schema` is dropped: some servers reject it.
    expect(
      JSON.stringify(call?.body['response_format']).includes('$schema'),
    ).toBe(false);
    expect((call?.body['messages'] as { role: string }[])[0]?.role).toBe(
      'system',
    );
  });

  it('falls back to plain JSON in the text when json_schema is refused', async () => {
    const { fetchImpl, calls } = fakeFetch(
      json(400, { error: { message: 'response_format not supported' } }),
      json(200, {
        choices: [
          {
            message: {
              content: 'Here it is:\n```json\n{"name":"Fallback"}\n```',
            },
          },
        ],
      }),
    );
    const answer = await new OpenAiCompatibleAdapter(fetchImpl).complete(
      { ...openAi, apiKey: undefined },
      request,
    );
    expect(answer.json).toEqual({ name: 'Fallback' });
    expect(answer.usage).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body['response_format']).toBeUndefined();
    const system = (calls[1]?.body['messages'] as { content: string }[])[0];
    expect(system?.content).toContain('JSON Schema');
    // No key configured → no Authorization header (local Ollama).
    expect(
      (calls[0]?.init.headers as Record<string, string>)['authorization'],
    ).toBeUndefined();
  });

  it('uses the OpenAI defaults when base URL and model are empty', async () => {
    const { fetchImpl, calls } = fakeFetch(
      json(200, { choices: [{ message: { content: '{}' } }] }),
    );
    await new OpenAiCompatibleAdapter(fetchImpl).complete(
      { kind: 'openai_compatible', baseUrl: '', model: '' },
      request,
    );
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]?.body['model']).toBeTruthy();
  });

  it.each([
    [401, 'invalidKey'],
    [403, 'invalidKey'],
    [429, 'rateLimited'],
    [404, 'modelNotFound'],
    [500, 'providerError'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { fetchImpl } = fakeFetch(json(status, { error: 'nope' }));
    await expect(
      new OpenAiCompatibleAdapter(fetchImpl).complete(openAi, request),
    ).rejects.toMatchObject({ code, status });
  });

  it('maps a refused connection to network and an abort to timeout', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    await expect(
      new OpenAiCompatibleAdapter(fakeFetch(refused).fetchImpl).complete(
        openAi,
        request,
      ),
    ).rejects.toMatchObject({ code: 'network' });
    const timeout = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
    });
    await expect(
      new OpenAiCompatibleAdapter(fakeFetch(timeout).fetchImpl).complete(
        openAi,
        request,
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('never puts the key into an error message', async () => {
    const { fetchImpl } = fakeFetch(
      json(401, { error: { message: 'bad key' } }),
    );
    const error = await new OpenAiCompatibleAdapter(fetchImpl)
      .complete(openAi, request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(String((error as Error).message)).not.toContain('sk-test-1234');
  });

  it('rejects an answer without JSON as badResponse', async () => {
    const { fetchImpl } = fakeFetch(
      json(200, { choices: [{ message: { content: 'I cannot help.' } }] }),
    );
    await expect(
      new OpenAiCompatibleAdapter(fetchImpl).complete(openAi, request),
    ).rejects.toMatchObject({ code: 'badResponse' });
  });
});

describe('AnthropicAdapter', () => {
  const anthropic: AiConnection = {
    kind: 'anthropic',
    baseUrl: '',
    model: '',
    apiKey: 'sk-ant-test-9876',
  };

  it('asks for structured outputs (output_config.format) and parses the JSON text', async () => {
    const { fetchImpl, calls } = fakeFetch(
      json(200, {
        model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: '{"name":"Bitfinex"}' }],
        usage: { input_tokens: 900, output_tokens: 200 },
      }),
    );
    const answer = await new AnthropicAdapter(fetchImpl).complete(
      anthropic,
      request,
    );
    expect(answer).toMatchObject({
      json: { name: 'Bitfinex' },
      text: '{"name":"Bitfinex"}',
      usage: { inputTokens: 900, outputTokens: 200 },
    });
    const [call] = calls;
    expect(call?.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test-9876');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(call?.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      system: 'You write mappings.',
      output_config: {
        format: {
          type: 'json_schema',
          schema: { properties: { name: {} }, additionalProperties: false },
        },
      },
    });
    // Regression: Claude Sonnet 5.5 / Opus 5.5 answer forced tool use with a 400.
    expect(call?.body).not.toHaveProperty('tool_choice');
    expect(call?.body['max_tokens']).toBeGreaterThanOrEqual(2048);
  });

  it('falls back to JSON in the text (never forced tool use) when structured outputs are refused', async () => {
    const { fetchImpl, calls } = fakeFetch(
      json(400, {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'output_config.format.schema: unsupported construct',
        },
      }),
      json(200, {
        content: [{ type: 'text', text: '```json\n{"name":"Kraken"}\n```' }],
      }),
    );
    const answer = await new AnthropicAdapter(fetchImpl).complete(
      anthropic,
      request,
    );
    expect(answer.json).toEqual({ name: 'Kraken' });
    // Regression (07.10.2026): the old fallback forced a tool, which Sonnet 5.5 refuses with 400.
    for (const call of calls) {
      expect(call.body).not.toHaveProperty('tool_choice');
      expect(call.body).not.toHaveProperty('tools');
    }
    expect(calls[1]?.body).not.toHaveProperty('output_config');
    expect(String(calls[1]?.body['system'])).toContain('JSON Schema');
  });

  it('keeps the structured refusal in the details when the fallback fails too', async () => {
    const { fetchImpl } = fakeFetch(
      json(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'schema too complex' },
      }),
      json(200, { content: [{ type: 'text', text: 'not json' }] }),
    );
    const error = await new AnthropicAdapter(fetchImpl)
      .complete(anthropic, request)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'badResponse' });
    expect(
      String((error as { details: { cause?: string } }).details.cause),
    ).toContain('schema too complex');
  });

  it('does not fall back on 401/429/5xx', async () => {
    const { fetchImpl, calls } = fakeFetch(
      json(429, { type: 'error', error: { message: 'rate limited' } }),
    );
    await expect(
      new AnthropicAdapter(fetchImpl).complete(anthropic, request),
    ).rejects.toMatchObject({ code: 'rateLimited' });
    expect(calls).toHaveLength(1);
  });

  it('fails with badResponse when the answer is not JSON', async () => {
    const { fetchImpl } = fakeFetch(
      json(200, {
        content: [{ type: 'text', text: 'no' }],
        stop_reason: 'end_turn',
      }),
    );
    await expect(
      new AnthropicAdapter(fetchImpl).complete(anthropic, request),
    ).rejects.toMatchObject({ code: 'badResponse' });
  });

  it('maps 401 to invalidKey', async () => {
    const { fetchImpl } = fakeFetch(
      json(401, { type: 'error', error: { message: 'invalid x-api-key' } }),
    );
    await expect(
      new AnthropicAdapter(fetchImpl).complete(anthropic, request),
    ).rejects.toMatchObject({ code: 'invalidKey' });
  });
});

describe('ProviderSwitchingAiCompletion', () => {
  it('routes by provider kind', async () => {
    const { fetchImpl, calls } = fakeFetch(
      json(200, {
        content: [{ type: 'text', text: '{}' }],
      }),
      json(200, { choices: [{ message: { content: '{}' } }] }),
    );
    const port = new ProviderSwitchingAiCompletion(fetchImpl);
    await port.complete({ kind: 'anthropic', baseUrl: '', model: '' }, request);
    await port.complete(openAi, request);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.anthropic.com/v1/messages',
      'http://localhost:11434/v1/chat/completions',
    ]);
  });
});

describe('structuredOutputSchema', () => {
  it('drops unsupported constraints and closes every object', () => {
    expect(
      structuredOutputSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          count: { type: 'integer', minimum: 0 },
          at: { type: 'string', format: 'date-time' },
          odd: { type: 'string', format: 'regex' },
          items: {
            type: 'array',
            minItems: 1,
            items: { type: 'object', properties: { a: { enum: ['x'] } } },
          },
        },
        additionalProperties: true,
      }),
    ).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
        at: { type: 'string', format: 'date-time' },
        odd: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { a: { enum: ['x'] } },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    });
  });
});

describe('extractJson', () => {
  it('reads bare, fenced and surrounded JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Answer: {"a":3} — done')).toEqual({ a: 3 });
    expect(() => extractJson('nothing')).toThrow(AiProviderError);
  });
});

describe('error details (user rule: "genaue Fehlerinfos")', () => {
  const fail = (
    adapter: OpenAiCompatibleAdapter | AnthropicAdapter,
    connection: AiConnection,
    req: AiCompletionRequest = request,
  ): Promise<AiProviderError> =>
    adapter.complete(connection, req).then(
      () => {
        throw new Error('expected the call to fail');
      },
      (e: unknown) => e as AiProviderError,
    );

  it('reads an OpenAI error body: status, message, type, code, URL, model', async () => {
    const { fetchImpl } = fakeFetch(
      json(401, {
        error: {
          message: 'Incorrect API key provided: sk-test-1234. See the docs.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_api_key',
        },
      }),
    );
    const error = await fail(new OpenAiCompatibleAdapter(fetchImpl), {
      ...openAi,
      baseUrl: 'https://api.openai.com/v1?api_key=sk-test-1234',
    });
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error.code).toBe('invalidKey');
    expect(error.details).toMatchObject({
      status: 401,
      providerType: 'invalid_request_error',
      providerCode: 'invalid_api_key',
      model: 'llama3.1',
    });
    expect(error.details.providerMessage).toContain(
      'Incorrect API key provided',
    );
    // The query (where a key could hide) is never part of the URL shown.
    expect(error.details.url).toBe('https://api.openai.com/v1');
    expect(JSON.stringify(error.details)).not.toContain('sk-test-1234');
    expect(error.message).not.toContain('sk-test-1234');
  });

  it('reads an Anthropic error body', async () => {
    const { fetchImpl } = fakeFetch(
      json(404, {
        type: 'error',
        error: { type: 'not_found_error', message: 'model: claude-nope' },
      }),
    );
    const error = await fail(new AnthropicAdapter(fetchImpl), {
      kind: 'anthropic',
      baseUrl: '',
      model: 'claude-nope',
      apiKey: 'sk-ant-test-9876',
    });
    expect(error.code).toBe('modelNotFound');
    expect(error.details).toEqual({
      status: 404,
      providerType: 'not_found_error',
      providerMessage: 'model: claude-nope',
      url: 'https://api.anthropic.com/v1/messages',
      model: 'claude-nope',
    });
  });

  it('reads an Ollama error body (a plain string)', async () => {
    const { fetchImpl } = fakeFetch(
      json(404, { error: 'model "llama9" not found, try pulling it first' }),
    );
    const error = await fail(new OpenAiCompatibleAdapter(fetchImpl), {
      kind: 'openai_compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama9',
    });
    expect(error.details).toMatchObject({
      status: 404,
      providerMessage: 'model "llama9" not found, try pulling it first',
      url: 'http://localhost:11434/v1/chat/completions',
      model: 'llama9',
    });
  });

  it('keeps a non-JSON error page short and without tags', async () => {
    const { fetchImpl } = fakeFetch(
      new Response(
        `<html><body><h1>502 Bad Gateway</h1>${'x'.repeat(2000)}</body></html>`,
        { status: 502 },
      ),
    );
    const error = await fail(new OpenAiCompatibleAdapter(fetchImpl), openAi);
    expect(error.code).toBe('providerError');
    expect(error.details.status).toBe(502);
    expect(error.details.providerMessage?.startsWith('502 Bad Gateway')).toBe(
      true,
    );
    expect(error.details.providerMessage?.length).toBeLessThanOrEqual(500);
  });

  it('names the system cause of a network failure and the timeout', async () => {
    const adapterFailing = (error: Error) =>
      new OpenAiCompatibleAdapter(fakeFetch(error).fetchImpl);
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new AggregateError([]), {
        errors: [{ code: 'ECONNREFUSED' }],
      }),
    });
    expect((await fail(adapterFailing(refused), openAi)).details).toMatchObject(
      {
        cause: 'ECONNREFUSED',
        url: 'http://localhost:11434/v1/chat/completions',
      },
    );
    const unknownHost = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND', hostname: 'api.nowhere.example' },
    });
    expect(
      (await fail(adapterFailing(unknownHost), openAi)).details.cause,
    ).toBe('ENOTFOUND (api.nowhere.example)');
    const tls = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'CERT_HAS_EXPIRED' },
    });
    expect((await fail(adapterFailing(tls), openAi)).details.cause).toBe(
      'CERT_HAS_EXPIRED',
    );
    const timeout = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
    });
    const timedOut = await fail(adapterFailing(timeout), openAi, {
      ...request,
      timeoutMs: 1234,
    });
    expect(timedOut.code).toBe('timeout');
    expect(timedOut.details.timeoutMs).toBe(1234);
  });

  it('names the reason of an unusable answer', async () => {
    const { fetchImpl } = fakeFetch(
      json(200, { model: 'm1', choices: [{ message: { content: 'nope' } }] }),
    );
    const error = await fail(new OpenAiCompatibleAdapter(fetchImpl), openAi);
    expect(error.code).toBe('badResponse');
    expect(error.details).toMatchObject({
      cause: 'no JSON in the answer',
      model: 'm1',
      url: 'http://localhost:11434/v1/chat/completions',
    });
  });
});

describe('redactSecrets', () => {
  it('removes the key, Bearer tokens, sk- keys and key=value pairs', () => {
    const text = redactSecrets(
      'key my-secret-value; Authorization: Bearer abc.def; sk-ant-api03-XYZ123456 x-api-key: k-123 api_key=zzz9',
      ['my-secret-value'],
    );
    expect(text).not.toMatch(/my-secret-value|abc\.def|XYZ123456|k-123|zzz9/);
    expect(text).toContain('[redacted]');
  });

  it('cuts long texts to 500 characters and keeps URLs without query', () => {
    expect(redactSecrets('a'.repeat(900))).toHaveLength(500);
    expect(safeUrl('https://user:pw@host.example:8443/v1/x?key=1#f')).toBe(
      'https://host.example:8443/v1/x',
    );
  });
});
