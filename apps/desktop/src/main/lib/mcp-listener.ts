import { createServer, type Server } from 'node:http';
import { mcpRequestCheck, type McpToken } from './assistant';

/** A JSON-RPC message is small; anything bigger is refused before it is parsed. */
export const MAX_MCP_BODY = 1024 * 1024;

export type McpHandler = (
  message: unknown,
) => Promise<
  | { readonly kind: 'none' }
  | { readonly kind: 'message'; readonly body: Record<string, unknown> }
>;

/**
 * Moat Desktop's MCP endpoint (T-109): plain HTTP on 127.0.0.1 only, `POST /mcp` with a bearer
 * token from the settings page, JSON answers, no CORS headers ever. Each request is checked by
 * mcpRequestCheck before its body is read. `tokens` is asked per request, so a revoked token
 * stops working at once.
 */
export function startMcpListener(options: {
  port: number;
  tokens: () => readonly McpToken[];
  handle: McpHandler;
}): Promise<Server> {
  const server = createServer((request, response) => {
    const refuse = (code: number) => {
      response.writeHead(code, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
      });
      response.end();
    };
    const check = mcpRequestCheck(
      {
        method: request.method ?? '',
        path: (request.url ?? '').split('?')[0] ?? '',
        host: request.headers.host,
        origin: request.headers.origin,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
      },
      options.port,
      options.tokens(),
    );
    if (check.status === 'refused') {
      request.resume();
      refuse(check.code);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MCP_BODY) {
        tooLarge = true;
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', () => {
      if (!response.headersSent) refuse(400);
    });
    request.on('end', () => {
      if (tooLarge) return refuse(413);
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          }),
        );
        return;
      }
      options.handle(message).then(
        (answer) => {
          if (answer.kind === 'none') return refuse(202);
          response.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          response.end(JSON.stringify(answer.body));
        },
        () => refuse(500),
      );
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 180_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
