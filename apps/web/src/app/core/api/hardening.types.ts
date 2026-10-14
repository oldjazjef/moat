import type { GateFailure } from './recipe.types';

/**
 * `POST /api/projects/:id/hardening-check` (DT-07) — a mirror of apps/api/src/gate-test
 * (application/hardening-check.handler.ts) and libs/core (gate/external-probe.ts). The web app
 * imports neither; keep them in step.
 */
export const HARDENING_RESULTS = [
  'reachable',
  'blocked',
  'not_gate',
  'failed',
] as const;
export type HardeningResult = (typeof HARDENING_RESULTS)[number];

export interface HardeningCheckReport {
  readonly result: HardeningResult;
  /** Data files (or `/` for the folder listing) that came back readable; never their content. */
  readonly reachable: readonly string[];
  /** Why the gate itself did not answer; null when it did. */
  readonly reason: GateFailure | null;
}

/** 422 of the endpoint: nothing was sent. */
export const HARDENING_REFUSALS = [
  'url_invalid',
  'folder_invalid',
  'not_confirmed',
  'busy',
] as const;

/** `moat-data-<32 hex>`, as `php moat-gate.php install` printed it (libs/core DATA_FOLDER). */
export const DATA_FOLDER = /^moat-data-[0-9a-f]{32}$/;
