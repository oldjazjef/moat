import { Command, Query } from '@nestjs/cqrs';
import type { GatePlanErrorCode } from '@moat/core';

export interface GateInput {
  readonly name: string;
  readonly gateId: string;
  readonly boxKey: string;
}

/** What the person compares with the gate's own output before it is pinned (SEC-32). */
export interface GatePreview {
  readonly name: string;
  readonly gateId: string;
  readonly boxKeyId: string;
  readonly boxKeyFingerprint: string;
}

export type GateRefusal =
  | GatePlanErrorCode
  /** The project has a gate of that name already (409). */
  | 'gate_exists'
  /** `fingerprint` is not the one of this box key: nothing written. */
  | 'fingerprint_mismatch'
  | 'not_writable';

export type CheckGateResult =
  | { readonly status: 'ready'; readonly preview: GatePreview }
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly code: GateRefusal };

export type AddGateResult =
  | { readonly status: 'saved' }
  | { readonly status: 'not_found' }
  | { readonly status: 'refused'; readonly code: GateRefusal };

/** The gate as it would be pinned, with its fingerprint; writes nothing. */
export class CheckGateQuery extends Query<CheckGateResult> {
  constructor(
    readonly id: string,
    readonly gate: GateInput,
  ) {
    super();
  }
}

/**
 * Pins a gate in the project (`gates/<name>.json`), the same file `moat gate add` writes — only
 * when `fingerprint` is the one the person confirmed (from CheckGateQuery), so the file holds the
 * key that was compared. Public keys only: a gate's private keys never leave it (SEC-30).
 */
export class AddGateCommand extends Command<AddGateResult> {
  constructor(
    readonly id: string,
    readonly gate: GateInput,
    readonly fingerprint: string,
  ) {
    super();
  }
}
