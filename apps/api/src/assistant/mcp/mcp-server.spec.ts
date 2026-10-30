import { describe, expect, it } from 'vitest';
import { assistantSetup, PROJECT } from '../testing/assistant-fixture';

const rpc = (id: number, method: string, params: unknown = {}) => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
});

describe('McpServer (T-109)', () => {
  it('initializes with the asked version or the newest', async () => {
    const { mcp } = assistantSetup();
    const asked = await mcp.handle(
      rpc(1, 'initialize', { protocolVersion: '2025-03-26' }),
      '1.2.3',
    );
    expect(asked).toMatchObject({
      kind: 'message',
      body: {
        id: 1,
        result: {
          protocolVersion: '2025-03-26',
          serverInfo: { name: 'moat-desktop', version: '1.2.3' },
        },
      },
    });
    const other = await mcp.handle(
      rpc(2, 'initialize', { protocolVersion: '1999-01-01' }),
      '1.2.3',
    );
    expect(other).toMatchObject({
      body: { result: { protocolVersion: '2025-06-18' } },
    });
  });

  it('answers notifications with nothing and refuses batches', async () => {
    const { mcp } = assistantSetup();
    expect(
      await mcp.handle(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        'v',
      ),
    ).toEqual({ kind: 'none' });
    expect(await mcp.handle([rpc(1, 'ping')], 'v')).toMatchObject({
      body: { error: { code: -32600 } },
    });
    expect(await mcp.handle(rpc(3, 'resources/list'), 'v')).toMatchObject({
      body: { error: { code: -32601 } },
    });
  });

  it('lists the tools with read-only hints', async () => {
    const { mcp } = assistantSetup();
    const answer = await mcp.handle(rpc(1, 'tools/list'), 'v');
    if (answer.kind !== 'message') throw new Error('no answer');
    const tools = (
      answer.body['result'] as {
        tools: {
          name: string;
          annotations: { readOnlyHint: boolean };
          inputSchema: { type: string };
        }[];
      }
    ).tools;
    expect(
      tools.find((tool) => tool.name === 'get_config')?.annotations
        .readOnlyHint,
    ).toBe(true);
    expect(
      tools.find((tool) => tool.name === 'propose_config_edit')?.annotations
        .readOnlyHint,
    ).toBe(false);
    expect(tools.every((tool) => tool.inputSchema.type === 'object')).toBe(
      true,
    );
  });

  it('a proposal through MCP writes nothing', async () => {
    const setup = assistantSetup();
    const answer = await setup.mcp.handle(
      rpc(1, 'tools/call', {
        name: 'propose_config_edit',
        arguments: {
          projectId: PROJECT,
          edit: { op: 'addEnvironment', environment: 'staging' },
          reason: 'staging',
        },
      }),
      'v',
    );
    expect(answer).toMatchObject({ body: { result: { isError: false } } });
    expect(setup.files.writes).toBe(0);
    expect(setup.store.list()[0]).toMatchObject({
      source: 'mcp',
      status: 'pending',
    });
  });

  it('reports a bad call as a tool error', async () => {
    const { mcp } = assistantSetup();
    expect(
      await mcp.handle(
        rpc(1, 'tools/call', {
          name: 'get_config',
          arguments: { projectId: 'x' },
        }),
        'v',
      ),
    ).toMatchObject({ body: { result: { isError: true } } });
    expect(
      await mcp.handle(rpc(2, 'tools/call', { name: 'sign_bundle' }), 'v'),
    ).toMatchObject({ body: { error: { code: -32602 } } });
  });
});
