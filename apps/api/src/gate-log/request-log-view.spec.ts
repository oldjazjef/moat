import { describe, expect, it } from 'vitest';
import { MAX_LOG_TEXT } from '@moat/core';
import { RECENT_ENTRIES, requestLogView } from './request-log-view';

const MARKER = '<?php http_response_code(404); exit; __halt_compiler();';
const line = (t: number, status = 200) =>
  JSON.stringify({
    t,
    route: 'newsletter',
    method: 'POST',
    status,
    error: status === 200 ? null : 'rate_limited',
    ms: t % 50,
    client: '0123456789abcdef',
  });

describe('requestLogView (FR-50, DT-12)', () => {
  it('summarises both files and lists the newest entries first', () => {
    const old = `${MARKER}\n${Array.from({ length: 150 }, (_, i) => line(i + 1)).join('\n')}\n`;
    const current = `${MARKER}\n${Array.from({ length: 100 }, (_, i) => line(i + 151, 429)).join('\n')}\nnot json\n`;
    const result = requestLogView([current, old]);
    if (result.status !== 'read') throw new Error(result.status);
    expect(result.log).toMatchObject({
      requests: 250,
      errors: 100,
      clients: 1,
      from: 1,
      to: 250,
      skipped: 1,
      codes: [{ code: 'rate_limited', count: 100 }],
    });
    expect(result.log.recent).toHaveLength(RECENT_ENTRIES);
    expect(result.log.recent[0]?.t).toBe(250);
  });

  it('says so when nothing in the files is a log entry', () => {
    expect(requestLogView(['hello\n'])).toEqual({
      status: 'refused',
      code: 'no_entries',
    });
  });

  it('refuses more than two full logs', () => {
    expect(requestLogView(['x'.repeat(MAX_LOG_TEXT + 1)])).toEqual({
      status: 'refused',
      code: 'too_large',
    });
  });
});
