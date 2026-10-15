import { fingerprint } from '../crypto/kid';
import { fromBase64UrlLength } from '../encoding/base64url';
import { MoatRejection } from '../errors';
import {
  hasExactKeys,
  isJsonObject,
  parseStrictJson,
  type JsonValue,
} from '../json/strict-json';
import { GATE_ID } from '../storage/project';

/**
 * The gate's answer in setup mode (SEC-28, SEC-32, T-73, docs/CRYPTO.md §8,
 * conformance/http/gate-setup.json): `GET <gate file>?moat-setup` with the header
 * `X-Moat-Setup-Token` shows the gate's public identity. Moat Desktop reads it to fill in gate id
 * and box key, and to show whether its own signer is pinned on the gate.
 *
 * Nothing in the answer is trusted as it comes: the shape is exact, and the box key's fingerprint
 * is computed here from the box key — an answer whose claimed fingerprint differs is refused, so
 * what the person compares is always the fingerprint of the key that will be pinned.
 */

/** Header that carries the token; never the query (T-73). */
export const SETUP_TOKEN_HEADER = 'X-Moat-Setup-Token';
/** The query of the setup request on the gate file, exactly this. */
export const SETUP_QUERY = 'moat-setup';
/** 32 random bytes as base64url, as the gate prints it. */
export const SETUP_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** The answer is a few hundred bytes; anything larger is not from a gate. */
export const MAX_SETUP_ANSWER_BYTES = 16_384;
export const MAX_SETUP_SIGNERS = 16;

/** Key id: 16 bytes as base64url (docs/CRYPTO.md §3). */
const KID = /^[A-Za-z0-9_-]{22}$/;
/** `MOAT-` + base32 of the 16-byte key id in groups of four (SEC-32). */
const FINGERPRINT = /^MOAT(?:-[A-Z2-7]{4}){6}-[A-Z2-7]{2}$/;
const KEYS = [
  'gateId',
  'boxKey',
  'boxKeyFingerprint',
  'signers',
  'threshold',
  'mode',
] as const;

export interface GateSetupSigner {
  readonly kid: string;
  readonly fingerprint: string;
}

export interface GateSetupIdentity {
  readonly gateId: string;
  /** base64url, 32 bytes. */
  readonly boxKey: string;
  /** Computed here from `boxKey`, never taken from the answer. */
  readonly boxKeyFingerprint: string;
  readonly signers: readonly GateSetupSigner[];
  readonly threshold: number;
  /** The gate's trust mode (0, 1 or 2). */
  readonly mode: number;
}

export type SetupAnswerErrorCode = 'answer_invalid' | 'fingerprint_mismatch';

/** The message is only the code: no value from the answer (SEC-34). */
export class SetupAnswerError extends Error {
  override readonly name = 'SetupAnswerError';
  constructor(readonly code: SetupAnswerErrorCode) {
    super(code);
  }
}

const invalid = (): never => {
  throw new SetupAnswerError('answer_invalid');
};

function signerOf(value: JsonValue): GateSetupSigner {
  if (!isJsonObject(value) || !hasExactKeys(value, ['kid', 'fingerprint']))
    return invalid();
  const { kid, fingerprint: print } = value;
  if (
    typeof kid !== 'string' ||
    !KID.test(kid) ||
    typeof print !== 'string' ||
    !FINGERPRINT.test(print)
  )
    return invalid();
  return { kid, fingerprint: print };
}

const smallInt = (value: JsonValue | undefined, min: number, max: number) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

/** Reads the exact bytes of a setup answer; throws SetupAnswerError for anything else. */
export async function parseSetupAnswer(
  bytes: Uint8Array,
): Promise<GateSetupIdentity> {
  if (bytes.length > MAX_SETUP_ANSWER_BYTES) invalid();
  let value: JsonValue;
  try {
    value = parseStrictJson(bytes);
  } catch (error) {
    if (error instanceof MoatRejection) return invalid();
    throw error;
  }
  if (!isJsonObject(value) || !hasExactKeys(value, KEYS)) return invalid();
  const { gateId, boxKey, boxKeyFingerprint, signers, threshold, mode } = value;
  if (
    typeof gateId !== 'string' ||
    !GATE_ID.test(gateId) ||
    typeof boxKeyFingerprint !== 'string' ||
    !FINGERPRINT.test(boxKeyFingerprint) ||
    !Array.isArray(signers) ||
    signers.length < 1 ||
    signers.length > MAX_SETUP_SIGNERS ||
    !smallInt(threshold, 1, signers.length) ||
    !smallInt(mode, 0, 2)
  )
    return invalid();
  let boxPublicKey: Uint8Array;
  try {
    boxPublicKey = fromBase64UrlLength(boxKey, 32);
  } catch (error) {
    if (error instanceof MoatRejection) return invalid();
    throw error;
  }
  const pinned = signers.map(signerOf);
  if (new Set(pinned.map((signer) => signer.kid)).size !== pinned.length)
    invalid();
  const computed = await fingerprint('x25519', boxPublicKey);
  if (computed !== boxKeyFingerprint)
    throw new SetupAnswerError('fingerprint_mismatch');
  return {
    gateId,
    boxKey: boxKey as string,
    boxKeyFingerprint: computed,
    signers: pinned,
    threshold: threshold as number,
    mode: mode as number,
  };
}
