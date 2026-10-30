import type { Server } from 'node:http';
import {
  app,
  type BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
} from 'electron';
import { IPC, type McpStatus, type McpTokenResult } from '../shared/bridge';
import { registerAiDialogIpc, showAiDialog } from './ai-window';
import type { RunningApi } from './api-host';
import { AI_MESSAGES } from './lib/ai-messages';
import { AiSettingsSession } from './lib/ai-settings';
import {
  isPort,
  isTokenName,
  MAX_MCP_TOKENS,
  mcpEndpoint,
  newMcpToken,
} from './lib/assistant';
import { readConfig, updateConfig } from './lib/config';
import { startMcpListener } from './lib/mcp-listener';
import { pageLocale } from './lib/messages';

interface Keychain {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(sealed: Buffer): string;
}

/**
 * The assistant's main-process half (T-108, T-109): the provider window, the connection the API
 * opens per call, and the MCP listener. The page reaches it through IPC with booleans, a port,
 * a token name and a token id only.
 */
export function registerAssistant(deps: {
  readonly api: RunningApi;
  readonly appDir: string;
  readonly keychain: Keychain;
  readonly fromApp: (event: IpcMainInvokeEvent) => boolean;
  readonly window: () => BrowserWindow | null;
}): void {
  const userData = app.getPath('userData');
  const { api, keychain } = deps;

  api.setAssistantConnection({
    summary: () => {
      const stored = readConfig(userData).assistant;
      return stored === null
        ? null
        : {
            kind: stored.kind,
            baseUrl: stored.baseUrl,
            model: stored.model,
            hasKey: stored.secret !== null,
          };
    },
    open: () => {
      const stored = readConfig(userData).assistant;
      if (stored === null) return Promise.resolve(null);
      let apiKey: string | undefined;
      if (stored.secret !== null) {
        if (!keychain.isEncryptionAvailable()) return Promise.resolve(null);
        try {
          apiKey = keychain.decryptString(Buffer.from(stored.secret, 'base64'));
        } catch {
          return Promise.resolve(null);
        }
      }
      return Promise.resolve({
        kind: stored.kind,
        baseUrl: stored.baseUrl,
        model: stored.model,
        ...(apiKey === undefined ? {} : { apiKey }),
      });
    },
  });

  registerAiDialogIpc();
  ipcMain.handle(IPC.aiOpen, async (event, locale: unknown): Promise<void> => {
    const parent = deps.window();
    if (!deps.fromApp(event) || parent === null) return;
    const texts =
      AI_MESSAGES[
        pageLocale(typeof locale === 'string' ? locale : '', app.getLocale())
      ];
    await showAiDialog({
      parent,
      appDir: deps.appDir,
      title: texts.title,
      session: new AiSettingsSession({
        texts,
        keychain: {
          available: keychain.isEncryptionAvailable(),
          seal: (secret) => keychain.encryptString(secret).toString('base64'),
        },
        stored: () => readConfig(userData).assistant,
        save: (assistant) => updateConfig(userData, { assistant }),
      }),
    });
  });

  // --- MCP ---
  let server: Server | null = null;
  const status = (): McpStatus => {
    const mcp = readConfig(userData).mcp;
    return {
      enabled: mcp.enabled,
      port: mcp.port,
      endpoint: mcpEndpoint(mcp.port),
      running: server !== null,
      tokens: mcp.tokens.map(({ id, name, createdAt }) => ({
        id,
        name,
        createdAt,
      })),
    };
  };
  const stop = async () => {
    const closing = server;
    server = null;
    if (closing !== null)
      await new Promise<void>((resolve) => {
        closing.close(() => resolve());
        closing.closeAllConnections();
      });
  };
  const sync = async () => {
    await stop();
    const mcp = readConfig(userData).mcp;
    if (!mcp.enabled) return;
    try {
      server = await startMcpListener({
        port: mcp.port,
        tokens: () => readConfig(userData).mcp.tokens,
        handle: (message) => api.handleMcp(message, app.getVersion()),
      });
    } catch {
      // Port in use or refused: shown as `running: false`.
      console.error('[desktop] the MCP listener could not start');
      server = null;
    }
  };
  app.on('before-quit', () => {
    void stop();
  });
  void sync();

  ipcMain.handle(IPC.mcpStatus, (event): McpStatus | null =>
    deps.fromApp(event) ? status() : null,
  );
  ipcMain.handle(
    IPC.mcpSetEnabled,
    async (event, on: unknown): Promise<McpStatus | null> => {
      if (!deps.fromApp(event) || typeof on !== 'boolean') return null;
      const mcp = readConfig(userData).mcp;
      updateConfig(userData, { mcp: { ...mcp, enabled: on } });
      await sync();
      return status();
    },
  );
  ipcMain.handle(
    IPC.mcpSetPort,
    async (event, port: unknown): Promise<McpStatus | null> => {
      if (!deps.fromApp(event) || !isPort(port)) return null;
      const mcp = readConfig(userData).mcp;
      updateConfig(userData, { mcp: { ...mcp, port } });
      await sync();
      return status();
    },
  );
  ipcMain.handle(
    IPC.mcpTokenCreate,
    (event, name: unknown): McpTokenResult | null => {
      if (!deps.fromApp(event)) return null;
      if (typeof name !== 'string' || !isTokenName(name))
        return { status: 'refused', code: 'name_invalid' };
      const mcp = readConfig(userData).mcp;
      if (mcp.tokens.length >= MAX_MCP_TOKENS)
        return { status: 'refused', code: 'too_many' };
      const { token, record } = newMcpToken(name, new Date());
      updateConfig(userData, {
        mcp: { ...mcp, tokens: [...mcp.tokens, record] },
      });
      return { status: 'created', token, mcp: status() };
    },
  );
  ipcMain.handle(IPC.mcpTokenRevoke, (event, id: unknown): McpStatus | null => {
    if (!deps.fromApp(event) || typeof id !== 'string') return null;
    const mcp = readConfig(userData).mcp;
    updateConfig(userData, {
      mcp: { ...mcp, tokens: mcp.tokens.filter((token) => token.id !== id) },
    });
    return status();
  });
}
