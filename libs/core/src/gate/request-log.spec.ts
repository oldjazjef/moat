import { describe, expect, it } from 'vitest';
import { MoatRejection } from '../errors';
import {
  MAX_LOG_TEXT,
  parseRequestLog,
  summariseRequestLog,
  type RequestLogEntry,
} from './request-log';

const MARKER = '<?php http_response_code(404); exit; __halt_compiler();';
const line = (entry: Partial<RequestLogEntry>) =>
  JSON.stringify({
    t: 1_760_000_000,
    route: 'newsletter',
    method: 'POST',
    status: 200,
    error: null,
    ms: 120,
    client: '0123456789abcdef',
    ...entry,
  });

describe('parseRequestLog (FR-50, DT-12)', () => {
  it('reads the data files and the output of `log`, oldest first', () => {
    const old = `${MARKER}\n${line({ t: 10 })}\n${line({ t: 20, route: null, status: 404, error: 'not_found' })}\n`;
    const current = `${MARKER}\n${line({ t: 30, ms: 5 })}\n`;
    const log = parseRequestLog(current, old);
    expect(log.skipped).toBe(0);
    expect(log.entries.map((entry) => entry.t)).toEqual([10, 20, 30]);
    expect(log.entries[1]).toMatchObject({ route: null, error: 'not_found' });
  });

  it('skips lines that are no entry, a cut-off last line included', () => {
    const text = [
      line({}),
      line({}).slice(0, 30),
      JSON.stringify({ ...JSON.parse(line({})), path: '/x' }),
      line({ client: '127.0.0.1' }),
      line({ route: 'Bad Route' }),
      line({ status: 99 }),
      line({ ms: -1 }),
      line({ method: 'post' }),
      '{"t":1,"t":2}',
      '[]',
    ].join('\n');
    const log = parseRequestLog(text);
    expect(log.entries).toHaveLength(1);
    expect(log.skipped).toBe(9);
  });

  it('refuses more text than two full logs', () => {
    expect(() => parseRequestLog('x'.repeat(MAX_LOG_TEXT + 1))).toThrow(
      MoatRejection,
    );
  });
});

describe('summariseRequestLog', () => {
  it('counts requests, errors, clients and latency per route', () => {
    const { entries } = parseRequestLog(
      [
        line({ t: 1, ms: 100 }),
        line({ t: 2, ms: 300, client: 'fedcba9876543210' }),
        line({ t: 3, status: 429, error: 'rate_limited', ms: 1 }),
        line({
          t: 4,
          route: null,
          method: 'GET',
          status: 404,
          error: 'not_found',
          ms: 0,
        }),
        line({ t: 5, route: 'contact', status: 502, ms: 50 }),
      ].join('\n'),
    );
    const summary = summariseRequestLog(entries);
    expect(summary).toMatchObject({
      requests: 5,
      errors: 3,
      clients: 2,
      from: 1,
      to: 5,
      codes: [
        { code: 'not_found', count: 1 },
        { code: 'rate_limited', count: 1 },
      ],
    });
    expect(summary.routes).toEqual([
      { route: 'contact', requests: 1, errors: 1, p50Ms: 50, p95Ms: 50 },
      { route: 'newsletter', requests: 3, errors: 1, p50Ms: 100, p95Ms: 300 },
      { route: null, requests: 1, errors: 1, p50Ms: 0, p95Ms: 0 },
    ]);
  });

  it('is empty for no entries', () => {
    expect(summariseRequestLog([])).toMatchObject({
      requests: 0,
      from: null,
      routes: [],
    });
  });
});
