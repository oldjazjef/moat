/**
 * `GET|POST /api/projects/:id/history` and `POST …/history/verify` (DT-03, «Verlauf») — a mirror
 * of libs/core (storage/history.ts) and apps/api (application/history.service.ts). The web app
 * imports neither; keep them in step.
 */
export const HISTORY_KINDS = [
  'history_started',
  'bundle_signed',
  'secret_sealed',
  'deploy',
  'config_edited',
  'database_pushed',
  'database_pulled',
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export const DEPLOY_TARGET_KINDS = ['zip', 'folder', 'sftp', 'git'] as const;

export interface HistoryEntryView {
  readonly seq: number;
  readonly at: string;
  readonly kind: HistoryKind;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly hash: string;
}

export interface HistoryView {
  readonly enabled: boolean;
  /** Oldest first. */
  readonly entries: readonly HistoryEntryView[];
}

/** `history.breaks.<reason>`: where «Prüfen» found the chain broken. */
export const HISTORY_BREAKS = [
  'sequence',
  'chain',
  'hash',
  'details',
  'anchor',
] as const;

export type HistoryCheck =
  | { readonly status: 'intact'; readonly entries: number }
  | {
      readonly status: 'broken';
      readonly entries: number;
      /** The first row that does not fit; null: the tail is missing (anchor). */
      readonly seq: number | null;
      readonly reason: (typeof HISTORY_BREAKS)[number];
    };
