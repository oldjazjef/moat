import type { HistoryAnchor, HistoryRow } from '@moat/core';

/** append() found that seq taken (another write came first); nothing was written. */
export class HistoryConflictError extends Error {
  override readonly name = 'HistoryConflictError';
}

/**
 * A project's local history (DT-03, «Verlauf»): one SQLite database per project in the API's data
 * folder, opt-in, append-only. The rows are made and checked by core (chainHistory,
 * verifyHistory); the store only keeps them, plus the anchor (the last row's seq and hash) in a
 * place of its own.
 */
export abstract class HistoryStorePort {
  /** Whether the project has a history (it was switched on). */
  abstract enabled(projectId: string): boolean;
  /** Creates the database (migrated) when it does not exist yet. */
  abstract enable(projectId: string): Promise<void>;
  /** Every row, in seq order (at most MAX_HISTORY_ROWS, the newest kept). */
  abstract list(projectId: string): Promise<HistoryRow[]>;
  /** The last row as remembered outside the database; null before the first row. */
  abstract anchor(projectId: string): HistoryAnchor | null;
  /** Appends the row and moves the anchor to it. Throws HistoryConflictError for a taken seq. */
  abstract append(projectId: string, row: HistoryRow): Promise<void>;
}

/** More rows than a page shows; the history keeps every row, the list only the newest. */
export const MAX_HISTORY_ROWS = 100_000;
