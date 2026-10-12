/**
 * The closed list of reasons a bundle, a sealed secret, a config, a request path, a key file or an
 * encoded value is rejected. The same
 * codes are used by every gate and by the conformance vectors (conformance/vectors/crypto/), so
 * a case says exactly which check must fail.
 */
export const REJECTION_CODES = [
  'too_large',
  'envelope_invalid',
  'payload_encoding',
  'signature_invalid',
  'threshold_not_met',
  'payload_invalid',
  'gate_mismatch',
  'version_not_newer',
  'expired',
  'secret_invalid',
  'encoding_invalid',
  'json_invalid',
  'config_invalid',
  'policy_invalid',
  'policy_violation',
  'path_invalid',
  'origin_forbidden',
  'preflight_rejected',
  'keyfile_invalid',
  'keyfile_locked',
] as const;

export type RejectionCode = (typeof REJECTION_CODES)[number];

/** Thrown for every rejection. The message never contains input values (SEC-34). */
export class MoatRejection extends Error {
  override readonly name = 'MoatRejection';

  constructor(readonly code: RejectionCode) {
    super(code);
  }
}

export function reject(code: RejectionCode): never {
  throw new MoatRejection(code);
}
