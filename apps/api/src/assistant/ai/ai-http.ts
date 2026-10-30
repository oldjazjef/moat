import { type AiErrorDetails, AiProviderError } from './ai-completion.port';
import { redactSecrets, safeUrl } from './redact';

export const DEFAULT_TIMEOUT_MS = 120_000;

/** `fetch` is injectable so the adapters can be tested without a network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Headers that carry no secret; every other header value is redacted from error texts. */
const PUBLIC_HEADERS = new Set(['content-type', 'anthropic-version']);

/**
 * POSTs JSON with a timeout and maps transport failures and error statuses to
 * `AiProviderError` with **redacted** details (status, the provider's own message, URL without
 * query, model, the system cause of a network error). Successful statuses return the parsed
 * body. Neither the request body nor the headers (the key) ever end up in an error.
 */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<JsonResponse> {
  const secrets = Object.entries(headers)
    .filter(([name]) => !PUBLIC_HEADERS.has(name.toLowerCase()))
    .flatMap(([, value]) => [value, value.replace(/^Bearer\s+/i, '')]);
  const model = (body as { model?: unknown } | null)?.model;
  const context: AiErrorDetails = {
    url: safeUrl(url, secrets),
    ...(typeof model === 'string' ? { model } : {}),
  };
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new AiProviderError('timeout', {
        ...context,
        cause: `no answer within ${timeoutMs} ms`,
        timeoutMs,
      });
    }
    throw new AiProviderError('network', {
      ...context,
      cause: redactSecrets(networkCause(error), secrets),
    });
  }
  const text = await response.text().catch(() => '');
  let parsed: unknown = undefined;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    throw errorFor(response.status, {
      ...context,
      ...providerError(parsed, text, secrets),
    });
  }
  if (parsed === undefined) {
    throw new AiProviderError('badResponse', {
      ...context,
      status: response.status,
      cause: 'the answer is not JSON',
      ...(text ? { providerMessage: redactSecrets(text, secrets) } : {}),
    });
  }
  return { status: response.status, body: parsed };
}

export function errorFor(
  status: number,
  details: AiErrorDetails = {},
): AiProviderError {
  const withStatus = { ...details, status };
  if (status === 401 || status === 403) {
    return new AiProviderError('invalidKey', withStatus);
  }
  if (status === 429) return new AiProviderError('rateLimited', withStatus);
  if (status === 404) return new AiProviderError('modelNotFound', withStatus);
  return new AiProviderError('providerError', withStatus);
}

/**
 * The provider's own words from an error body, redacted:
 * - OpenAI (and most compatible APIs): `{ error: { message, type, code } }`
 * - Anthropic: `{ type: 'error', error: { type, message } }`
 * - Ollama: `{ error: "model \"x\" not found" }`
 * - anything else (an HTML page from a proxy): the text itself, cut short.
 */
export function providerError(
  body: unknown,
  text: string,
  secrets: readonly string[] = [],
): Pick<AiErrorDetails, 'providerMessage' | 'providerType' | 'providerCode'> {
  const clean = (value: unknown) =>
    typeof value === 'string' && value.trim() !== ''
      ? redactSecrets(value, secrets)
      : typeof value === 'number'
        ? String(value)
        : undefined;
  const out: {
    providerMessage?: string;
    providerType?: string;
    providerCode?: string;
  } = {};
  const error =
    typeof body === 'object' && body !== null
      ? (body as { error?: unknown }).error
      : undefined;
  if (typeof error === 'string') {
    out.providerMessage = clean(error);
  } else if (typeof error === 'object' && error !== null) {
    const { message, type, code } = error as Record<string, unknown>;
    out.providerMessage = clean(message);
    out.providerType = clean(type);
    out.providerCode = clean(code);
  } else if (typeof body === 'object' && body !== null) {
    // `{ message: "…" }` / `{ detail: "…" }` (gateways, FastAPI servers)
    const { message, detail } = body as Record<string, unknown>;
    out.providerMessage = clean(message) ?? clean(detail);
  }
  if (!out.providerMessage && text.trim() !== '' && body === undefined) {
    out.providerMessage = clean(text.replace(/<[^>]*>/g, ' '));
  }
  return Object.fromEntries(
    Object.entries(out).filter(([, v]) => v !== undefined),
  );
}

/**
 * The system cause of a failed `fetch`: undici throws `TypeError('fetch failed')` with the real
 * reason in `cause` (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, a TLS code such as
 * `CERT_HAS_EXPIRED`) — sometimes one level deeper, or as an `AggregateError` (IPv4 + IPv6).
 */
export function networkCause(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const node = current as {
      code?: unknown;
      errors?: unknown;
      cause?: unknown;
      message?: unknown;
    };
    if (typeof node.code === 'string' && node.code !== '') {
      const host =
        typeof (node as { hostname?: unknown }).hostname === 'string'
          ? ` (${(node as { hostname: string }).hostname})`
          : '';
      return `${node.code}${host}`;
    }
    if (Array.isArray(node.errors) && node.errors.length > 0) {
      current = node.errors[0];
      continue;
    }
    if (!node.cause) {
      return typeof node.message === 'string' && node.message !== ''
        ? node.message
        : 'fetch failed';
    }
    current = node.cause;
  }
  return 'fetch failed';
}

/**
 * The first JSON object in a model's text answer: as is, inside a ```json fence, or between the
 * first `{` and the last `}` (models like to add a sentence around it).
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next candidate
    }
  }
  throw new AiProviderError('badResponse', {
    cause: 'no JSON in the answer',
  });
}

/** Removes a trailing slash so `${base}/chat/completions` never doubles it. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

/** JSON Schema keys some providers reject at the top level of a tool/response schema. */
export function plainSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}
