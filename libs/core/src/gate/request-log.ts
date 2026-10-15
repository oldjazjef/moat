import { MoatRejection } from '../errors';
import { utf8 } from '../encoding/utf8';
import {
  isJsonObject,
  parseStrictJson,
  type JsonValue,
} from '../json/strict-json';
import { DATA_MARKER } from './external-probe';

/**
 * The gate's request log (FR-50, DT-12, conformance/http/gate-log.json): one JSON object per line
 * in the data files `logold` and `log`, written by the gate after every request. Moat Desktop
 * reads what the person fetched from the server (`php moat-gate.php log`, the data files, or
 * SFTP) and shows it; nothing here sends or stores anything.
 *
 * A line holds no path, query, header, body or address (SEC-34): the route's name, the method,
 * the status, the gate's error code, the duration and a client hash that changes every UTC day.
 */

export const LOG_FILE = 'log';
export const LOG_OLD_FILE = 'logold';
/** More than two full logs (policy MAX_LOG_BYTES) plus the marker lines. */
export const MAX_LOG_TEXT = 2 * 1_048_576 + 4096;
/** At most this many entries are kept, the newest. */
export const MAX_LOG_ENTRIES = 20_000;

export interface RequestLogEntry {
  /** Unix seconds. */
  readonly t: number;
  readonly route: string | null;
  readonly method: string;
  readonly status: number;
  /** The gate's error code; null when the upstream answered. */
  readonly error: string | null;
  readonly ms: number;
  /** 16 hex digits, the same for one client on one UTC day. */
  readonly client: string;
}

export interface RequestLog {
  /** Oldest first. */
  readonly entries: readonly RequestLogEntry[];
  /** Lines that were not a log entry (damaged, cut off, or not from a gate). */
  readonly skipped: number;
}

const ROUTE = /^[a-z][a-z0-9-]{0,62}$/;
const METHOD = /^[A-Z]{1,10}$/;
const ERROR = /^[a-z][a-z_]{0,62}$/;
const CLIENT = /^[0-9a-f]{16}$/;
const KEYS = ['client', 'error', 'method', 'ms', 'route', 'status', 't'];

function entryOf(value: JsonValue): RequestLogEntry | null {
  if (!isJsonObject(value)) return null;
  if (Object.keys(value).sort().join() !== KEYS.join()) return null;
  const { t, route, method, status, error, ms, client } = value;
  if (
    typeof t !== 'number' ||
    !Number.isSafeInteger(t) ||
    t < 0 ||
    (route !== null && (typeof route !== 'string' || !ROUTE.test(route))) ||
    typeof method !== 'string' ||
    !METHOD.test(method) ||
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    (error !== null && (typeof error !== 'string' || !ERROR.test(error))) ||
    typeof ms !== 'number' ||
    !Number.isSafeInteger(ms) ||
    ms < 0 ||
    typeof client !== 'string' ||
    !CLIENT.test(client)
  )
    return null;
  return { t, route, method, status, error, ms, client };
}

/**
 * Reads log text: the output of `php moat-gate.php log`, or the data files themselves (their
 * marker line is skipped without counting). Several texts are read in the given order; the
 * entries come back sorted by time, at most MAX_LOG_ENTRIES of the newest.
 */
export function parseRequestLog(...texts: readonly string[]): RequestLog {
  if (texts.reduce((sum, text) => sum + text.length, 0) > MAX_LOG_TEXT)
    throw new MoatRejection('too_large');
  const entries: RequestLogEntry[] = [];
  let skipped = 0;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (line.trim() === '' || line.includes(DATA_MARKER)) continue;
      let entry: RequestLogEntry | null = null;
      try {
        entry = entryOf(parseStrictJson(utf8(line)));
      } catch (error) {
        if (!(error instanceof MoatRejection)) throw error;
      }
      if (entry === null) skipped += 1;
      else entries.push(entry);
    }
  }
  entries.sort((a, b) => a.t - b.t);
  return { entries: entries.slice(-MAX_LOG_ENTRIES), skipped };
}

export interface RequestLogRouteSummary {
  /** null: requests that matched no route. */
  readonly route: string | null;
  readonly requests: number;
  /** Answers of 400 and above, the gate's and the upstream's. */
  readonly errors: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface RequestLogSummary {
  readonly requests: number;
  readonly errors: number;
  readonly clients: number;
  readonly from: number | null;
  readonly to: number | null;
  /** Error codes by how often they came, most frequent first. */
  readonly codes: readonly { readonly code: string; readonly count: number }[];
  readonly routes: readonly RequestLogRouteSummary[];
}

const percentile = (sorted: readonly number[], p: number) =>
  sorted.length === 0
    ? 0
    : (sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ??
      0);

/** Requests, error rate, latency and refusals per route (FR-51 without a Cloud, DT-12). */
export function summariseRequestLog(
  entries: readonly RequestLogEntry[],
): RequestLogSummary {
  const byRoute = new Map<string | null, RequestLogEntry[]>();
  const codes = new Map<string, number>();
  for (const entry of entries) {
    byRoute.set(entry.route, [...(byRoute.get(entry.route) ?? []), entry]);
    if (entry.error !== null)
      codes.set(entry.error, (codes.get(entry.error) ?? 0) + 1);
  }
  const routes = [...byRoute.entries()]
    .map(([route, list]) => {
      const ms = list.map((entry) => entry.ms).sort((a, b) => a - b);
      return {
        route,
        requests: list.length,
        errors: list.filter((entry) => entry.status >= 400).length,
        p50Ms: percentile(ms, 0.5),
        p95Ms: percentile(ms, 0.95),
      };
    })
    .sort((a, b) =>
      a.route === null
        ? 1
        : b.route === null
          ? -1
          : a.route.localeCompare(b.route),
    );
  return {
    requests: entries.length,
    errors: entries.filter((entry) => entry.status >= 400).length,
    clients: new Set(entries.map((entry) => entry.client)).size,
    from: entries[0]?.t ?? null,
    to: entries.at(-1)?.t ?? null,
    codes: [...codes.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    routes,
  };
}
