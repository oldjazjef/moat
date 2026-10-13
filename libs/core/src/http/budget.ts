import { z } from 'zod';
import { periodEnd } from './rate-limit';

/**
 * Budgets for AI APIs (FR-31, SEC-45, T-07): tokens and cost per calendar day or month (UTC),
 * counted from the usage the upstream reports in its answer. Before a request is forwarded, its
 * `reserve` is added to every budget it counts against (refused once a limit is reached, the
 * reservations of requests in flight included); after the answer, the reservation is replaced by
 * the answer's usage — or kept when the answer cannot be counted, since the provider bills it all
 * the same. So a budget can be overshot only by what answers use beyond their reservation.
 *
 * Where an answer reports its usage is a closed list of formats (SEC-20: config is data, never a
 * path or an expression). Every gate reads them alike (conformance/vectors/http/budget.json).
 */

export const USAGE_FORMATS = ['openai', 'anthropic', 'gemini'] as const;
export type UsageFormat = (typeof USAGE_FORMATS)[number];

/** Token counts above this in one answer are not believed (and keep the cost math in range). */
export const MAX_USAGE_TOKENS = 1_000_000_000;
export const MAX_BUDGET_TOKENS = 1_000_000_000_000;
/** Amounts are decimal strings with at most 6 places, counted in millionths ("micros"). */
export const MICROS = 1_000_000;
export const MAX_AMOUNT_MICROS = 1_000_000_000 * MICROS;
export const MAX_PRICE_MICROS = 1_000 * MICROS;

const AMOUNT = /^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,6})?$/;

/** "2.50" → 2_500_000; null for anything that is not a plain decimal amount. */
export function parseAmount(text: string): number | null {
  if (!AMOUNT.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  return Number(whole) * MICROS + Number(fraction.padEnd(6, '0'));
}

const amount = (max: number, min = 0) =>
  z.string().refine((value) => {
    const micros = parseAmount(value);
    return micros !== null && micros >= min && micros <= max;
  }, 'a decimal amount such as "20.00" (at most 6 places)');

/**
 * Cost in the upstream's currency: `limit` per period, prices per million input and output
 * tokens as the provider lists them.
 */
export const costSchema = z.strictObject({
  limit: amount(MAX_AMOUNT_MICROS, 1),
  inputPerMillion: amount(MAX_PRICE_MICROS),
  outputPerMillion: amount(MAX_PRICE_MICROS),
});

/**
 * Tokens reserved for each request before it is forwarded, and charged in full when its answer
 * cannot be counted (a stream, a timeout, an answer too large or without usage): what one request
 * may use at most, e.g. the `max_tokens` the website sends.
 */
export const reserveSchema = z.int().min(1).max(MAX_USAGE_TOKENS);

export const budgetSchema = z
  .strictObject({
    usage: z.enum(USAGE_FORMATS),
    period: z.enum(['day', 'month']),
    reserve: reserveSchema,
    tokens: z.int().min(1).max(MAX_BUDGET_TOKENS).optional(),
    cost: costSchema.optional(),
  })
  .refine(
    (budget) => budget.tokens !== undefined || budget.cost !== undefined,
    'a budget needs `tokens`, `cost` or both',
  );
export type Budget = z.infer<typeof budgetSchema>;

/**
 * A period's spending never goes above these (SEC-27: a store line stays bounded, whatever the
 * answers report); they lie far beyond every limit, so a capped budget stays exhausted.
 */
export const MAX_SPENT_TOKENS = 1_000_000_000_000_000;
export const MAX_SPENT_MICROS = 100_000_000_000_000_000;

/** What a request adds to a budget: tokens and micros. */
export interface Charge {
  tokens: number;
  micros: number;
}

/** Tokens one answer used, split as providers bill them. */
export interface Usage {
  input: number;
  output: number;
}

/** One period's spending: `tokens` and `micros` so far, until `resetAt` (unix seconds). */
export interface Spent {
  resetAt: number;
  tokens: number;
  micros: number;
}

/** Answers nested deeper than this are not read (every gate's JSON decoder has a depth limit). */
export const MAX_USAGE_DEPTH = 64;

/**
 * True when `text` nests at most MAX_USAGE_DEPTH arrays and objects and every `\u` escape for a
 * surrogate is half of a pair: what PHP's json_decode() accepts beyond JSON.parse(). A linear scan,
 * so a deep answer cannot exhaust the stack.
 */
function decodable(text: string): boolean {
  let depth = 0;
  let inString = false;
  let high = false; // the last escape was a high surrogate, a low one must follow at once
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!inString) {
      if (char === '"') inString = true;
      else if (char === '[' || char === '{') {
        if (++depth > MAX_USAGE_DEPTH) return false;
      } else if (char === ']' || char === '}') depth--;
      continue;
    }
    if (char === '\\' && text[i + 1] === 'u') {
      const unit = parseInt(text.slice(i + 2, i + 6), 16);
      const isHigh = unit >= 0xd800 && unit <= 0xdbff;
      const isLow = unit >= 0xdc00 && unit <= 0xdfff;
      if (high !== isLow) return false;
      high = isHigh;
      i += 5;
      continue;
    }
    if (high) return false;
    if (char === '\\') i++;
    else if (char === '"') inString = false;
  }
  return !high;
}

/**
 * The usage an answer reports, from its body text, or null when it does not say (fail closed:
 * the gate answers `upstream_usage_invalid`). `text` is the body decoded as strict UTF-8 (a gate
 * treats a body that is not valid UTF-8 as null). The body must be valid JSON (RFC 8259, no lone
 * surrogate, at most MAX_USAGE_DEPTH levels); the rest of it is not checked, so floats and
 * negative numbers elsewhere in the answer are fine. Every counted field must be an integer from 0
 * to MAX_USAGE_TOKENS (`100.0` and `1e2` are 100); an optional one may also be absent or null
 * (= 0). Of a duplicated key the last one counts.
 *
 * - `openai`: `usage.input_tokens`/`output_tokens` (Responses API) or
 *   `usage.prompt_tokens`/`completion_tokens` (Chat Completions); reasoning tokens are inside.
 * - `anthropic`: `usage.input_tokens` + `output_tokens`; cache writes and reads
 *   (`cache_creation_input_tokens`, `cache_read_input_tokens`) count as input.
 * - `gemini`: `usageMetadata.promptTokenCount` (+ `toolUsePromptTokenCount`) as input,
 *   `candidatesTokenCount` + `thoughtsTokenCount` as output (absent = 0).
 */
export function readUsage(format: UsageFormat, text: string): Usage | null {
  if (!decodable(text)) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  type Obj = Record<string, unknown>;
  const object = (value: unknown): Obj | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Obj)
      : null;
  const root = object(body);
  if (root === null) return null;
  const count = (from: Obj, key: string, optional = false): number | null => {
    // An optional field may be absent or null (some providers send null for "none").
    if (!Object.hasOwn(from, key) || (optional && from[key] === null))
      return optional ? 0 : null;
    const value = from[key];
    return typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= MAX_USAGE_TOKENS
      ? value + 0 // -0 → 0
      : null;
  };
  const sum = (...parts: (number | null)[]) =>
    parts.some((part) => part === null)
      ? null
      : parts.reduce<number>((total, part) => total + (part ?? 0), 0);
  const usage =
    format === 'gemini' ? object(root['usageMetadata']) : object(root['usage']);
  if (usage === null) return null;
  let input: number | null;
  let output: number | null;
  if (format === 'openai') {
    const responses = Object.hasOwn(usage, 'input_tokens');
    input = count(usage, responses ? 'input_tokens' : 'prompt_tokens');
    output = count(usage, responses ? 'output_tokens' : 'completion_tokens');
  } else if (format === 'anthropic') {
    input = sum(
      count(usage, 'input_tokens'),
      count(usage, 'cache_creation_input_tokens', true),
      count(usage, 'cache_read_input_tokens', true),
    );
    output = count(usage, 'output_tokens');
  } else {
    input = sum(
      count(usage, 'promptTokenCount'),
      count(usage, 'toolUsePromptTokenCount', true),
    );
    output = sum(
      count(usage, 'candidatesTokenCount', true),
      count(usage, 'thoughtsTokenCount', true),
    );
  }
  return input === null || output === null ? null : { input, output };
}

/** What one answer costs: its tokens, and its price in micros rounded up (0 without `cost`). */
export function chargeOf(usage: Usage, budget: Pick<Budget, 'cost'>): Charge {
  if (budget.cost === undefined)
    return { tokens: usage.input + usage.output, micros: 0 };
  const price = (text: string) => BigInt(parseAmount(text) ?? 0);
  const total =
    BigInt(usage.input) * price(budget.cost.inputPerMillion) +
    BigInt(usage.output) * price(budget.cost.outputPerMillion);
  const million = BigInt(MICROS);
  return {
    tokens: usage.input + usage.output,
    micros: Number((total + million - 1n) / million),
  };
}

/**
 * What is reserved for one request before forwarding: `reserve` tokens, priced at the higher of
 * the two prices (as if every token were the dearer kind).
 */
export function reservationOf(
  budget: Pick<Budget, 'reserve' | 'cost'>,
): Charge {
  if (budget.cost === undefined) return { tokens: budget.reserve, micros: 0 };
  const input = parseAmount(budget.cost.inputPerMillion) ?? 0;
  const output = parseAmount(budget.cost.outputPerMillion) ?? 0;
  const higher =
    input > output ? budget.cost.inputPerMillion : budget.cost.outputPerMillion;
  return chargeOf(
    { input: budget.reserve, output: 0 },
    {
      cost: { ...budget.cost, inputPerMillion: higher },
    },
  );
}

/**
 * How a forwarded request ends, for its budgets: the usage its answer reports; `uncountable` when
 * the request reached the upstream but its usage cannot be read (the reservation stays charged);
 * `not_charged` when the upstream answered with an error or was never reached (released).
 */
export type BudgetAnswer = Usage | 'uncountable' | 'not_charged';

/** What an answer finally costs a budget. */
export function answerCharge(
  answer: BudgetAnswer,
  budget: Pick<Budget, 'reserve' | 'cost'>,
): Charge {
  if (answer === 'uncountable') return reservationOf(budget);
  if (answer === 'not_charged') return { tokens: 0, micros: 0 };
  return chargeOf(answer, budget);
}

/** The spending at `now`: a past period counts as nothing spent. */
export function current(spent: Spent | null, now: number): Spent | null {
  return spent === null || now >= spent.resetAt ? null : spent;
}

/**
 * Before forwarding: refused (seconds until the period ends) once the period's tokens or cost
 * — reservations of requests in flight included — have reached a limit, otherwise null.
 */
export function budgetRefusal(
  spent: Spent | null,
  budget: Pick<Budget, 'tokens' | 'cost'>,
  now: number,
): number | null {
  const live = current(spent, now);
  if (live === null) return null;
  const tokensOut = budget.tokens !== undefined && live.tokens >= budget.tokens;
  const costOut =
    budget.cost !== undefined &&
    live.micros >= (parseAmount(budget.cost.limit) ?? 0);
  return tokensOut || costOut ? live.resetAt - now : null;
}

/** The spending with this charge added, in the period that holds `now` (capped). */
export function addCharge(
  spent: Spent | null,
  period: Budget['period'],
  charge: Charge,
  now: number,
): Spent {
  const live = current(spent, now) ?? {
    resetAt: periodEnd(period, now),
    tokens: 0,
    micros: 0,
  };
  return {
    resetAt: live.resetAt,
    tokens: Math.min(MAX_SPENT_TOKENS, live.tokens + charge.tokens),
    micros: Math.min(MAX_SPENT_MICROS, live.micros + charge.micros),
  };
}

/**
 * After the answer: the reservation made in the period ending `resetAt` is replaced by what the
 * answer costs. A period that has ended since is left alone (its spending no longer counts).
 */
export function settle(
  spent: Spent | null,
  resetAt: number,
  reserved: Charge,
  charge: Charge,
  now: number,
): Spent | null {
  const live = current(spent, now);
  if (live === null || live.resetAt !== resetAt) return live;
  // The reservation comes off (never below 0), then the charge goes on (capped).
  const replace = (value: number, minus: number, plus: number, max: number) =>
    Math.min(max, Math.max(0, value - minus) + plus);
  return {
    resetAt,
    tokens: replace(
      live.tokens,
      reserved.tokens,
      charge.tokens,
      MAX_SPENT_TOKENS,
    ),
    micros: replace(
      live.micros,
      reserved.micros,
      charge.micros,
      MAX_SPENT_MICROS,
    ),
  };
}
