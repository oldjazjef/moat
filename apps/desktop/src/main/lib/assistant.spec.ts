import { createServer, request } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  assistantSettingsOf,
  mcpRequestCheck,
  type McpRequestHead,
  mcpSettingsOf,
  newMcpToken,
  normaliseBaseUrl,
  tokenMatches,
} from './assistant';
import { startMcpListener } from './mcp-listener';

describe('assistant settings (T-108)', () => {
  it('takes https and loopback http only', () => {
    expect(normaliseBaseUrl('')).toEqual({ status: 'ok', url: '' });
    expect(normaliseBaseUrl('https://api.example.com/v1/')).toEqual({
      status: 'ok',
      url: 'https://api.example.com/v1',
    });
    expect(normaliseBaseUrl('http://localhost:11434/v1').status).toBe('ok');
    for (const bad of [
      'http://api.example.com',
      'https://user:pw@api.example.com',
      'https://api.example.com/?key=1',
      'file:///etc/passwd',
      'nonsense',
    ])
      expect(normaliseBaseUrl(bad).status).toBe('refused');
  });

  it('drops a damaged entry', () => {
    expect(
      assistantSettingsOf({
        kind: 'anthropic',
        baseUrl: '',
        model: 'claude-sonnet-5-5',
        secret: 'Y2lwaGVy',
        keyHint: '…abcd',
      }),
    ).not.toBeNull();
    expect(assistantSettingsOf({ kind: 'other' })).toBeNull();
    expect(
      assistantSettingsOf({
        kind: 'anthropic',
        baseUrl: 'http://evil.example',
        model: '',
        secret: null,
        keyHint: null,
      }),
    ).toBeNull();
  });

  it('is off by default and keeps only well-formed tokens', () => {
    expect(mcpSettingsOf(undefined).enabled).toBe(false);
    const { record } = newMcpToken('Claude', new Date(0));
    const settings = mcpSettingsOf({
      enabled: true,
      port: 50_000,
      tokens: [record, { id: 'x', name: 'y', hash: 'z', createdAt: 'n' }],
    });
    expect(settings).toMatchObject({ enabled: true, port: 50_000 });
    expect(settings.tokens).toEqual([record]);
    expect(mcpSettingsOf({ port: 80 }).port).not.toBe(80);
  });
});

describe('MCP request check (T-109)', () => {
  const { token, record } = newMcpToken('Claude', new Date(0));
  const head: McpRequestHead = {
    method: 'POST',
    path: '/mcp',
    host: '127.0.0.1:47719',
    origin: undefined,
    authorization: `Bearer ${token}`,
    contentType: 'application/json',
  };

  it('keeps the token only as a hash', () => {
    expect(JSON.stringify(record)).not.toContain(token);
    expect(tokenMatches(token, [record])).toBe(true);
    const other = token.endsWith('A') ? 'B' : 'A';
    expect(tokenMatches(`${token.slice(0, -1)}${other}`, [record])).toBe(false);
  });

  it('takes exactly the right request', () => {
    expect(mcpRequestCheck(head, 47719, [record])).toEqual({ status: 'ok' });
    const refused = (change: Partial<McpRequestHead>) =>
      mcpRequestCheck({ ...head, ...change }, 47719, [record]);
    expect(refused({ path: '/other' })).toMatchObject({ code: 404 });
    expect(refused({ host: 'evil.example:47719' })).toMatchObject({
      code: 403,
    });
    expect(refused({ origin: 'https://evil.example' })).toMatchObject({
      code: 403,
    });
    expect(refused({ method: 'GET' })).toMatchObject({ code: 405 });
    expect(refused({ authorization: undefined })).toMatchObject({ code: 401 });
    expect(refused({ contentType: 'text/plain' })).toMatchObject({ code: 415 });
    expect(mcpRequestCheck(head, 47719, [])).toMatchObject({ code: 401 });
  });

  it('serves JSON-RPC on loopback through the check', async () => {
    const port = await freePort();
    const server = await startMcpListener({
      port,
      tokens: () => [record],
      handle: (message) =>
        Promise.resolve({
          kind: 'message',
          body: { jsonrpc: '2.0', id: 1, result: { echo: message } },
        }),
    });
    try {
      const ok = await post(
        port,
        { authorization: `Bearer ${token}` },
        '{"a":1}',
      );
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toMatchObject({ result: { echo: { a: 1 } } });
      expect(ok.cors).toBeUndefined();
      expect((await post(port, {}, '{}')).status).toBe(401);
      expect(
        (
          await post(
            port,
            {
              authorization: `Bearer ${token}`,
              origin: 'https://evil.example',
            },
            '{}',
          )
        ).status,
      ).toBe(403);
      expect(
        (await post(port, { authorization: `Bearer ${token}` }, '{')).status,
      ).toBe(400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function post(
  port: number,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string; cors: string | undefined }> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            cors: response.headers['access-control-allow-origin'] as
              string | undefined,
          }),
        );
      },
    );
    call.on('error', reject);
    call.end(body);
  });
}
