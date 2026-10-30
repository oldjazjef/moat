import { Injectable } from '@nestjs/common';
import {
  AssistantTools,
  inputSchemaOf,
  ToolError,
} from '../tools/assistant-tools';

/** Protocol versions this server speaks; the newest is offered when the client asks another. */
export const MCP_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

const MAX_RESULT_CHARS = 100_000;

type JsonRpcId = string | number;

export type McpAnswer =
  /** A notification or a response from the client: nothing to send back (HTTP 202). */
  | { readonly kind: 'none' }
  | { readonly kind: 'message'; readonly body: Record<string, unknown> };

/**
 * Moat Desktop's MCP server (Streamable HTTP, JSON answers only, no sessions): `initialize`,
 * `ping`, `tools/list`, `tools/call`. The tools are the assistant's, so an MCP client can read
 * and propose but never write: a proposal waits for «Ausführen» in Moat Desktop (T-109). The
 * main process authenticates the request (token, Host, no Origin) before it gets here.
 */
@Injectable()
export class McpServer {
  constructor(private readonly tools: AssistantTools) {}

  async handle(message: unknown, version: string): Promise<McpAnswer> {
    if (Array.isArray(message))
      return error(null, -32600, 'Batches are not supported');
    if (typeof message !== 'object' || message === null)
      return error(null, -32600, 'Invalid request');
    const record = message as Record<string, unknown>;
    const id = record['id'];
    const method = record['method'];
    if (record['jsonrpc'] !== '2.0')
      return error(validId(id), -32600, 'Invalid request');
    // A response or notification from the client needs no answer.
    if (typeof method !== 'string' || id === undefined) return { kind: 'none' };
    if (!isId(id)) return error(null, -32600, 'Invalid request');
    const params =
      typeof record['params'] === 'object' && record['params'] !== null
        ? (record['params'] as Record<string, unknown>)
        : {};

    switch (method) {
      case 'initialize': {
        const asked = params['protocolVersion'];
        const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(
          asked as (typeof MCP_PROTOCOL_VERSIONS)[number],
        )
          ? (asked as string)
          : MCP_PROTOCOL_VERSIONS[0];
        return result(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'moat-desktop', version },
          instructions:
            'Moat Desktop: read projects and moat.yaml, and propose moat.yaml changes. Proposals are applied only by the person in Moat Desktop («Assistent» → «Ausführen»). Signing, sealing, pinning, deploying and keys are not available here.',
        });
      }
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, {
          tools: this.tools.all.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: inputSchemaOf(tool),
            annotations: {
              readOnlyHint: tool.effect === 'read',
              destructiveHint: false,
              openWorldHint: false,
            },
          })),
        });
      case 'tools/call': {
        const name = params['name'];
        if (typeof name !== 'string' || this.tools.byName(name) === null)
          return error(id, -32602, 'Unknown tool');
        try {
          const value = await this.tools.call(name, params['arguments'], {
            source: 'mcp',
            conversationId: null,
          });
          return result(id, toolResult(value, false));
        } catch (caught) {
          if (caught instanceof ToolError)
            return result(
              id,
              toolResult({ error: caught.code, detail: caught.detail }, true),
            );
          return result(id, toolResult({ error: 'failed' }, true));
        }
      }
      default:
        return error(id, -32601, 'Method not found');
    }
  }
}

function toolResult(value: unknown, isError: boolean): Record<string, unknown> {
  const text = JSON.stringify(value);
  return {
    content: [
      {
        type: 'text',
        text:
          text.length <= MAX_RESULT_CHARS
            ? text
            : `${text.slice(0, MAX_RESULT_CHARS)}…[cut]`,
      },
    ],
    isError,
  };
}

function isId(id: unknown): id is JsonRpcId {
  return (
    (typeof id === 'string' && id.length <= 200) ||
    (typeof id === 'number' && Number.isFinite(id))
  );
}

function validId(id: unknown): JsonRpcId | null {
  return isId(id) ? id : null;
}

function result(id: JsonRpcId, value: Record<string, unknown>): McpAnswer {
  return { kind: 'message', body: { jsonrpc: '2.0', id, result: value } };
}

function error(id: JsonRpcId | null, code: number, message: string): McpAnswer {
  return {
    kind: 'message',
    body: { jsonrpc: '2.0', id, error: { code, message } },
  };
}
