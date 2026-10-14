import type { RequestLogResult, RequestLogView } from '../../shared/bridge';
import { readImportFile } from './import';

/** The API's in-process answer (apps/api/src/gate-log/request-log-view.ts). */
export type RequestLogApiResult =
  | { readonly status: 'read'; readonly log: RequestLogView }
  | { readonly status: 'refused'; readonly code: 'too_large' | 'no_entries' };

/** `log.php` and `logold.php`: one file is at most 1 MiB of lines plus its marker line. */
export const MAX_LOG_FILE_BYTES = 1_048_576 + 4096;
/** Both data files; more is no gate's log. */
export const MAX_LOG_FILES = 2;

/**
 * The text of the log files the person chose in the main process's dialog (DT-12): regular files
 * only, never through a link, each within MAX_LOG_FILE_BYTES. What the text holds is decided in
 * core (parseRequestLog); nothing here parses it.
 */
export function readLogFiles(
  paths: readonly string[],
):
  | { readonly texts: string[] }
  | { readonly refused: 'unreadable' | 'too_large' } {
  if (paths.length === 0 || paths.length > MAX_LOG_FILES)
    return { refused: 'unreadable' };
  const texts: string[] = [];
  for (const path of paths) {
    const bytes = readImportFile(path, MAX_LOG_FILE_BYTES);
    if (bytes === null) return { refused: 'unreadable' };
    if (bytes === 'too_large') return { refused: 'too_large' };
    try {
      texts.push(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return { refused: 'unreadable' };
    }
  }
  return { texts };
}

/** What the page learns: the summary and the newest lines, never a path. */
export function logOutcome(result: RequestLogApiResult): RequestLogResult {
  return result.status === 'read'
    ? { status: 'read', log: structuredClone(result.log) as RequestLogView }
    : { status: 'refused', code: result.code };
}
