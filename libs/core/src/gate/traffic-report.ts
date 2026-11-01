import { utf8 } from '../encoding/utf8';
import { MoatRejection } from '../errors';
import {
  isJsonObject,
  parseStrictJson,
  type JsonValue,
} from '../json/strict-json';
import type { RequestLogEntry } from './request-log';

/**
 * The traffic report (FR-50, FR-51, T-110): what a gate tells Moat Cloud about its traffic, when
 * the local policy names a report address. Built from the gate's own request log, it carries
 * **sums only** — per route and complete UTC hour: requests, status classes, the gate's error
 * codes and the duration (sum and maximum). No client hash, no single request, no path, no
 * address. The Cloud shows it as "reported by the gate": a report proves nothing, whoever holds
 * the address can send numbers, and nothing in it ever changes what a gate does.
 *
 * Wire format (JSON, `POST` to the report address):
 * `{"v":1,"gateId":"…","hours":[{"hour":…,"route":…|null,"requests":…,"s2":…,"s3":…,"s4":…,
 * "s5":…,"errors":{"code":n,…},"msTotal":…,"msMax":…}]}` — each bucket's status classes add up
 * to its requests, and its error counts to at most that.
 */

export const REPORT_VERSION = 1;
export const HOUR = 3600;
/** A first report (or one after a long silence) looks back at most this far. */
export const REPORT_LOOKBACK_HOURS = 24;
/** The oldest hour the Cloud takes, relative to its clock. */
export const REPORT_MAX_AGE_HOURS = 24 * 30;
export const MAX_REPORT_BUCKETS = 500;
export const MAX_REPORT_ERROR_CODES = 20;
export const MAX_REPORT_BYTES = 128 * 1024;
const MAX_COUNT = 1_000_000_000;

export interface TrafficBucket {
  /** Unix seconds of the hour's start (a multiple of 3600). */
  readonly hour: number;
  /** null: requests that matched no route. */
  readonly route: string | null;
  readonly requests: number;
  readonly s2: number;
  readonly s3: number;
  readonly s4: number;
  readonly s5: number;
  /** The gate's error codes, each with its count; sorted by code. */
  readonly errors: Readonly<Record<string, number>>;
  readonly msTotal: number;
  readonly msMax: number;
}

export interface TrafficReport {
  readonly v: 1;
  readonly gateId: string;
  /** Sorted by hour, then route (null last). */
  readonly hours: readonly TrafficBucket[];
}

const GATE_ID = /^[A-Za-z0-9_-]{22}$/;
const ROUTE = /^[a-z][a-z0-9-]{0,62}$/;
const ERROR = /^[a-z][a-z_]{0,62}$/;
const BUCKET_KEYS = [
  'errors',
  'hour',
  'msMax',
  'msTotal',
  'requests',
  'route',
  's2',
  's3',
  's4',
  's5',
].join();

const compareBuckets = (a: TrafficBucket, b: TrafficBucket) =>
  a.hour - b.hour ||
  (a.route === b.route
    ? 0
    : a.route === null
      ? 1
      : b.route === null
        ? -1
        : a.route < b.route
          ? -1
          : 1);

/**
 * What the gate sends now: the complete hours from `sentUntil` (exclusive start of the first hour
 * not yet sent; null = never sent) up to the hour `now` falls in, at most REPORT_LOOKBACK_HOURS
 * back. `until` is the next `sentUntil` once the Cloud took it. `report` is null when no hour is
 * complete yet; an hour without requests is simply absent, so an empty `hours` is a valid report
 * that says "nothing happened".
 */
export function buildTrafficReport(
  gateId: string,
  entries: readonly RequestLogEntry[],
  sentUntil: number | null,
  now: number,
): { readonly report: TrafficReport | null; readonly until: number } {
  const current = Math.floor(now / HOUR) * HOUR;
  const floor = current - REPORT_LOOKBACK_HOURS * HOUR;
  const from =
    sentUntil === null || sentUntil < floor || sentUntil > current
      ? floor
      : sentUntil;
  if (from >= current) return { report: null, until: from };
  const buckets = new Map<string, Mutable>();
  for (const entry of entries) {
    if (entry.t < from || entry.t >= current || entry.status < 200) continue;
    const hour = Math.floor(entry.t / HOUR) * HOUR;
    const key = `${hour}/${entry.route ?? ''}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        hour,
        route: entry.route,
        requests: 0,
        s2: 0,
        s3: 0,
        s4: 0,
        s5: 0,
        errors: {},
        msTotal: 0,
        msMax: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.requests += 1;
    const status = Math.floor(entry.status / 100);
    if (status === 2) bucket.s2 += 1;
    else if (status === 3) bucket.s3 += 1;
    else if (status === 4) bucket.s4 += 1;
    else bucket.s5 += 1;
    if (entry.error !== null)
      bucket.errors[entry.error] = (bucket.errors[entry.error] ?? 0) + 1;
    bucket.msTotal += entry.ms;
    bucket.msMax = Math.max(bucket.msMax, entry.ms);
  }
  const hours = [...buckets.values()]
    .map((bucket) => ({ ...bucket, errors: topErrors(bucket.errors) }))
    .sort(compareBuckets)
    .slice(-MAX_REPORT_BUCKETS);
  return {
    report: { v: REPORT_VERSION, gateId, hours },
    until: current,
  };
}

type Mutable = {
  -readonly [K in keyof TrafficBucket]: K extends 'errors'
    ? Record<string, number>
    : TrafficBucket[K];
};

/** The MAX_REPORT_ERROR_CODES most frequent codes (ties by code), sorted by code. */
function topErrors(errors: Record<string, number>): Record<string, number> {
  const kept = Object.entries(errors)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
    .slice(0, MAX_REPORT_ERROR_CODES)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(kept);
}

export type TrafficReportRefusal =
  'too_large' | 'report_invalid' | 'report_stale';

/**
 * Reads a report as the Cloud receives it: strict JSON, exact keys, every number a safe count,
 * the sums consistent, hours on the hour, not in the future and not older than
 * REPORT_MAX_AGE_HOURS, each (hour, route) once. Anything else is refused whole.
 */
export function parseTrafficReport(
  bytes: Uint8Array,
  now: number,
):
  | { readonly ok: true; readonly report: TrafficReport }
  | { readonly ok: false; readonly code: TrafficReportRefusal } {
  if (bytes.length > MAX_REPORT_BYTES) return { ok: false, code: 'too_large' };
  let value: JsonValue;
  try {
    value = parseStrictJson(bytes);
  } catch (error) {
    if (error instanceof MoatRejection)
      return { ok: false, code: 'report_invalid' };
    throw error;
  }
  if (
    !isJsonObject(value) ||
    Object.keys(value).sort().join() !== 'gateId,hours,v' ||
    value['v'] !== REPORT_VERSION ||
    typeof value['gateId'] !== 'string' ||
    !GATE_ID.test(value['gateId']) ||
    !Array.isArray(value['hours']) ||
    value['hours'].length > MAX_REPORT_BUCKETS
  )
    return { ok: false, code: 'report_invalid' };
  const current = Math.floor(now / HOUR) * HOUR;
  const oldest = current - REPORT_MAX_AGE_HOURS * HOUR;
  const seen = new Set<string>();
  const hours: TrafficBucket[] = [];
  for (const item of value['hours']) {
    const bucket = bucketOf(item);
    if (bucket === null) return { ok: false, code: 'report_invalid' };
    // The hour must be complete by the Cloud's clock; a gate a little ahead is not refused.
    if (bucket.hour > current) return { ok: false, code: 'report_invalid' };
    if (bucket.hour < oldest) return { ok: false, code: 'report_stale' };
    const key = `${bucket.hour}/${bucket.route ?? ''}`;
    if (seen.has(key)) return { ok: false, code: 'report_invalid' };
    seen.add(key);
    hours.push(bucket);
  }
  return {
    ok: true,
    report: {
      v: REPORT_VERSION,
      gateId: value['gateId'],
      hours: hours.sort(compareBuckets),
    },
  };
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAX_COUNT;

function bucketOf(value: JsonValue): TrafficBucket | null {
  if (!isJsonObject(value) || Object.keys(value).sort().join() !== BUCKET_KEYS)
    return null;
  const { hour, route, requests, s2, s3, s4, s5, errors, msTotal, msMax } =
    value;
  if (
    typeof hour !== 'number' ||
    !Number.isSafeInteger(hour) ||
    hour < 0 ||
    hour % HOUR !== 0 ||
    !(route === null || (typeof route === 'string' && ROUTE.test(route))) ||
    !isCount(requests) ||
    requests === 0 ||
    !isCount(s2) ||
    !isCount(s3) ||
    !isCount(s4) ||
    !isCount(s5) ||
    s2 + s3 + s4 + s5 !== requests ||
    typeof msTotal !== 'number' ||
    !Number.isSafeInteger(msTotal) ||
    msTotal < 0 ||
    !isCount(msMax) ||
    msMax > msTotal ||
    !isJsonObject(errors)
  )
    return null;
  const codes = Object.entries(errors);
  if (codes.length > MAX_REPORT_ERROR_CODES) return null;
  let errorSum = 0;
  for (const [code, count] of codes) {
    if (!ERROR.test(code) || !isCount(count) || count === 0) return null;
    errorSum += count;
  }
  if (errorSum > requests) return null;
  return {
    hour,
    route,
    requests,
    s2,
    s3,
    s4,
    s5,
    errors: Object.fromEntries(codes.sort(([a], [b]) => (a < b ? -1 : 1))),
    msTotal,
    msMax,
  };
}

/** The report as the gate sends it: compact JSON in the key order above. */
export function encodeTrafficReport(report: TrafficReport): Uint8Array {
  return utf8(JSON.stringify(report));
}
