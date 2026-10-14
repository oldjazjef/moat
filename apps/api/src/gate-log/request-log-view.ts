import {
  MoatRejection,
  parseRequestLog,
  summariseRequestLog,
  type RequestLogEntry,
  type RequestLogSummary,
} from '@moat/core';

/** The newest entries the page lists; the summary counts them all. */
export const RECENT_ENTRIES = 200;

/** What Moat Desktop shows of a gate's request log (FR-50, DT-12): no path, never a file name. */
export interface RequestLogView extends RequestLogSummary {
  /** Newest first, at most RECENT_ENTRIES. */
  readonly recent: readonly RequestLogEntry[];
  /** Lines that were no log entry. */
  readonly skipped: number;
}

export type RequestLogViewResult =
  | { readonly status: 'read'; readonly log: RequestLogView }
  | { readonly status: 'refused'; readonly code: 'too_large' | 'no_entries' };

/**
 * Reads the text the main process took from the files the person chose (`log.php`, `logold.php`,
 * or what `php moat-gate.php log` printed) with core parseRequestLog — in-process, never HTTP.
 */
export function requestLogView(texts: readonly string[]): RequestLogViewResult {
  let parsed;
  try {
    parsed = parseRequestLog(...texts);
  } catch (error) {
    if (error instanceof MoatRejection)
      return { status: 'refused', code: 'too_large' };
    throw error;
  }
  if (parsed.entries.length === 0)
    return { status: 'refused', code: 'no_entries' };
  return {
    status: 'read',
    log: {
      ...summariseRequestLog(parsed.entries),
      recent: parsed.entries.slice(-RECENT_ENTRIES).reverse(),
      skipped: parsed.skipped,
    },
  };
}
