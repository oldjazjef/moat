import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The AI provider and the MCP server of Moat Desktop's assistant, as config.json keeps them.
 * Pure: the windows and the listener (main.ts, ai-window.ts, mcp-listener.ts) use these.
 */

export const AI_KINDS = ['anthropic', 'openai_compatible'] as const;
export type AiKind = (typeof AI_KINDS)[number];

export interface AssistantSettings {
  readonly kind: AiKind;
  /** '' = the provider's default; else https, or http only to this machine (a local model). */
  readonly baseUrl: string;
  /** '' = the provider's default. */
  readonly model: string;
  /** The token as `safeStorage` ciphertext (base64, DT-04); null = none (a local model). */
  readonly secret: string | null;
  /** The token's last four characters, to recognise it; never more. */
  readonly keyHint: string | null;
}

export interface McpToken {
  /** 16 random bytes, base64url: what revoking names. */
  readonly id: string;
  readonly name: string;
  /** SHA-256 (hex) of the token; the token itself is shown once and kept nowhere. */
  readonly hash: string;
  readonly createdAt: string;
}

export interface McpSettings {
  /** Off by default: nothing listens until the person switches it on. */
  readonly enabled: boolean;
  readonly port: number;
  readonly tokens: readonly McpToken[];
}

export const DEFAULT_MCP_PORT = 47_719;
export const MAX_MCP_TOKENS = 10;
export const MAX_KEY_LENGTH = 400;
export const MAX_MODEL_LENGTH = 120;
export const MAX_BASE_URL_LENGTH = 300;
export const MAX_TOKEN_NAME_LENGTH = 60;
export const MCP_TOKEN_PREFIX = 'moatmcp_';
const TOKEN = /^moatmcp_[A-Za-z0-9_-]{43}$/;
const TOKEN_ID = /^[A-Za-z0-9_-]{22}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MODEL = /^[A-Za-z0-9._:/@-]{1,120}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export const DEFAULT_MCP: McpSettings = {
  enabled: false,
  port: DEFAULT_MCP_PORT,
  tokens: [],
};

/**
 * The provider address as stored, or why it is refused: https only, http only to this machine
 * (Ollama, LM Studio), no user/password, query or fragment; '' is the provider's default.
 */
export function normaliseBaseUrl(
  value: string,
): { status: 'ok'; url: string } | { status: 'refused' } {
  const trimmed = value.trim();
  if (trimmed === '') return { status: 'ok', url: '' };
  if (trimmed.length > MAX_BASE_URL_LENGTH) return { status: 'refused' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { status: 'refused' };
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
    )
  )
    return { status: 'refused' };
  return { status: 'ok', url: url.href.replace(/\/+$/, '') };
}

export function isModel(value: string): boolean {
  return value === '' || MODEL.test(value);
}

export function keyHintOf(key: string): string {
  return key.length < 8 ? '…' : `…${key.slice(-4)}`;
}

export function assistantSettingsOf(value: unknown): AssistantSettings | null {
  if (!isRecord(value)) return null;
  const { kind, baseUrl, model, secret, keyHint } = value;
  if (
    !AI_KINDS.includes(kind as AiKind) ||
    typeof baseUrl !== 'string' ||
    normaliseBaseUrl(baseUrl).status !== 'ok' ||
    typeof model !== 'string' ||
    !isModel(model) ||
    !(secret === null || (typeof secret === 'string' && secret !== '')) ||
    !(
      keyHint === null ||
      (typeof keyHint === 'string' && /^…[\s\S]{0,4}$/.test(keyHint))
    )
  )
    return null;
  return {
    kind: kind as AiKind,
    baseUrl,
    model,
    secret: secret as string | null,
    keyHint: secret === null ? null : (keyHint as string | null),
  };
}

export function mcpSettingsOf(value: unknown): McpSettings {
  if (!isRecord(value)) return DEFAULT_MCP;
  const tokens: McpToken[] = [];
  if (Array.isArray(value['tokens']))
    for (const entry of value['tokens']) {
      if (
        isRecord(entry) &&
        typeof entry['id'] === 'string' &&
        TOKEN_ID.test(entry['id']) &&
        typeof entry['name'] === 'string' &&
        isTokenName(entry['name']) &&
        typeof entry['hash'] === 'string' &&
        HEX64.test(entry['hash']) &&
        typeof entry['createdAt'] === 'string' &&
        !Number.isNaN(Date.parse(entry['createdAt']))
      )
        tokens.push({
          id: entry['id'],
          name: entry['name'],
          hash: entry['hash'],
          createdAt: entry['createdAt'],
        });
    }
  return {
    enabled: value['enabled'] === true,
    port: isPort(value['port']) ? value['port'] : DEFAULT_MCP_PORT,
    tokens: tokens.slice(0, MAX_MCP_TOKENS),
  };
}

export function isPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1024 &&
    value <= 65_535
  );
}

export function isTokenName(value: string): boolean {
  return (
    value.trim() !== '' &&
    value.length <= MAX_TOKEN_NAME_LENGTH &&
    // No control characters: the name is shown in the page and in the list.
    ![...value].some((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

/** A new MCP token: the text (shown once) and what config.json keeps of it. */
export function newMcpToken(
  name: string,
  now: Date,
): { token: string; record: McpToken } {
  const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    token,
    record: {
      id: randomBytes(16).toString('base64url'),
      name: name.trim(),
      hash: tokenHash(token),
      createdAt: now.toISOString(),
    },
  };
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The token a request presents is one of the stored ones (constant-time per entry). */
export function tokenMatches(
  token: string,
  tokens: readonly McpToken[],
): boolean {
  if (!TOKEN.test(token)) return false;
  const presented = Buffer.from(tokenHash(token), 'hex');
  let found = false;
  for (const entry of tokens)
    if (timingSafeEqual(presented, Buffer.from(entry.hash, 'hex')))
      found = true;
  return found;
}

export interface McpRequestHead {
  readonly method: string;
  readonly path: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
}

/**
 * Whether the MCP listener takes a request (T-109), else the HTTP status to answer with:
 * exactly POST /mcp, a Host naming this port on loopback (DNS rebinding), no Origin (no web
 * page may talk to it, and a browser cannot send this request without one), JSON, a stored token.
 */
export function mcpRequestCheck(
  head: McpRequestHead,
  port: number,
  tokens: readonly McpToken[],
): { status: 'ok' } | { status: 'refused'; code: 401 | 403 | 404 | 405 | 415 } {
  if (head.path !== '/mcp') return { status: 'refused', code: 404 };
  const host = (head.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
    return { status: 'refused', code: 403 };
  if (head.origin !== undefined) return { status: 'refused', code: 403 };
  if (head.method !== 'POST') return { status: 'refused', code: 405 };
  const auth = head.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tokenMatches(token, tokens)) return { status: 'refused', code: 401 };
  const type = (head.contentType ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') return { status: 'refused', code: 415 };
  return { status: 'ok' };
}

/** The snippets the settings page shows for the person's MCP client. */
export function mcpEndpoint(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
