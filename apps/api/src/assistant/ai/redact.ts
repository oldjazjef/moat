import type { AiErrorDetails } from './ai-completion.port';

/** Longest text an error detail may carry (a provider's HTML error page is cut). */
export const MAX_DETAIL_LENGTH = 500;

const REDACTED = '[redacted]';

/**
 * Removes anything that looks like a credential from a text that leaves the API (error body,
 * log line): the given secret values verbatim, `Bearer …`, `sk-…`-style keys and
 * `x-api-key: …` / `api_key=…` / `authorization: …` pairs. Then collapses whitespace and cuts
 * to 500 characters. Cheap and deliberately over-eager — a detail is for a human, not a parser.
 */
export function redactSecrets(
  text: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret?.trim();
    if (!value || value.length < 4) continue;
    out = out.split(value).join(REDACTED);
  }
  out = out
    .replace(/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_*.-]{6,}/g, `$1-${REDACTED}`)
    .replace(
      /\b(x-api-key|api[_-]?key|access[_-]?token|authorization|token|secret)(["']?\s*[:=]\s*["']?)([^\s"',;&}]+)/gi,
      `$1$2${REDACTED}`,
    )
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > MAX_DETAIL_LENGTH
    ? `${out.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : out;
}

/** Every text field of the details redacted again (the gate knows the actual key). */
export function redactDetails(
  details: AiErrorDetails,
  secrets: readonly (string | undefined)[] = [],
): AiErrorDetails {
  const clean = (value: string | undefined) =>
    value === undefined ? undefined : redactSecrets(value, secrets);
  return withoutUndefined({
    status: details.status,
    providerMessage: clean(details.providerMessage),
    providerType: clean(details.providerType),
    providerCode: clean(details.providerCode),
    url: details.url === undefined ? undefined : safeUrl(details.url, secrets),
    model: clean(details.model),
    cause: clean(details.cause),
    timeoutMs: details.timeoutMs,
  });
}

/** `scheme://host[:port]/path` — no user info, query or fragment (a key may hide there). */
export function safeUrl(
  url: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  try {
    const parsed = new URL(url);
    return redactSecrets(
      `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
      secrets,
    );
  } catch {
    return redactSecrets(url.split(/[?#]/)[0] ?? '', secrets);
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}
