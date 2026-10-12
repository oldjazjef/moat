import { canonicalJsonBytes } from '../canonical/jcs';
import {
  fromBase64Url,
  fromBase64UrlLength,
  toBase64Url,
} from '../encoding/base64url';
import { concatBytes, utf8 } from '../encoding/utf8';
import { reject } from '../errors';
import { keyId } from '../crypto/kid';
import { sodium } from '../crypto/sodium';
import {
  hasExactKeys,
  isJsonObject,
  parseStrictJson,
  type JsonValue,
} from '../json/strict-json';

/** docs/CRYPTO.md §4. */
export const MAX_ENVELOPE_BYTES = 1024 * 1024;
export const MAX_SIGNATURES = 16;
const BUNDLE_DOMAIN = 'moat:bundle:v1\n';

export interface BundlePayload {
  readonly type: 'moat.bundle';
  readonly v: 1;
  readonly gateId: string;
  readonly version: number;
  readonly issuedAt: number;
  readonly expiresAt: number | null;
  readonly config: { [key: string]: JsonValue };
  readonly secrets: { [key: string]: JsonValue };
}

export interface Ed25519Signer {
  readonly alg: 'ed25519';
  /** 64-byte libsodium secret key (seed ‖ public key). */
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

export interface PinnedSigner {
  readonly kid: string;
  readonly alg: 'ed25519';
  readonly publicKey: Uint8Array;
}

/** What the gate has pinned locally (trust.json, docs/CRYPTO.md §8) plus its own state. */
export interface VerificationContext {
  readonly gateId: string;
  readonly signers: readonly PinnedSigner[];
  readonly threshold: number;
  /** Highest version accepted so far; 0 before the first bundle. */
  readonly currentVersion: number;
  /** Seconds since the epoch — passed in, the core has no clock. */
  readonly now: number;
  /** SEC-05: expiry is opt-in; when false `expiresAt` is ignored. */
  readonly expiryEnabled: boolean;
}

export interface VerifiedBundle {
  readonly payload: BundlePayload;
  readonly payloadBytes: Uint8Array;
}

function signedMessage(payloadBytes: Uint8Array): Uint8Array {
  return concatBytes(utf8(BUNDLE_DOMAIN), payloadBytes);
}

/** Builds the JCS payload bytes and the envelope signed by every given signer. */
export async function signBundle(
  payload: BundlePayload,
  signers: readonly Ed25519Signer[],
): Promise<string> {
  const na = await sodium();
  const payloadBytes = canonicalJsonBytes(payload as unknown as JsonValue);
  const message = signedMessage(payloadBytes);
  const sigs = [];
  for (const signer of signers) {
    sigs.push({
      kid: await keyId('ed25519', signer.publicKey),
      alg: signer.alg,
      sig: toBase64Url(na.crypto_sign_detached(message, signer.secretKey)),
    });
  }
  return JSON.stringify({
    moat: 'bundle',
    v: 1,
    payload: toBase64Url(payloadBytes),
    sigs,
  });
}

/**
 * Verifies an envelope in the binding order of docs/CRYPTO.md §4.3, steps 1–8: size, envelope,
 * payload decoding, signatures over the exact bytes, then — only then — JSON, gate id, version
 * and expiry. Schema and policy (steps 9–10) follow on the returned payload. Throws
 * MoatRejection with the failing check's code.
 */
export async function verifyBundle(
  envelopeBytes: Uint8Array,
  context: VerificationContext,
): Promise<VerifiedBundle> {
  // 1. Size.
  if (envelopeBytes.length > MAX_ENVELOPE_BYTES) reject('too_large');

  // 2. Envelope: exactly these keys, known type and version.
  let envelope: JsonValue;
  try {
    envelope = parseStrictJson(envelopeBytes);
  } catch {
    reject('envelope_invalid');
  }
  if (
    !isJsonObject(envelope) ||
    !hasExactKeys(envelope, ['moat', 'v', 'payload', 'sigs']) ||
    envelope['moat'] !== 'bundle' ||
    envelope['v'] !== 1 ||
    typeof envelope['payload'] !== 'string' ||
    !Array.isArray(envelope['sigs']) ||
    envelope['sigs'].length === 0 ||
    envelope['sigs'].length > MAX_SIGNATURES
  ) {
    reject('envelope_invalid');
  }
  const entries = envelope['sigs'];
  for (const entry of entries) {
    if (
      !isJsonObject(entry) ||
      !hasExactKeys(entry, ['kid', 'alg', 'sig']) ||
      typeof entry['kid'] !== 'string' ||
      typeof entry['alg'] !== 'string' ||
      typeof entry['sig'] !== 'string'
    ) {
      reject('envelope_invalid');
    }
  }

  // 3. Payload bytes — not parsed yet.
  let payloadBytes: Uint8Array;
  try {
    payloadBytes = fromBase64Url(envelope['payload']);
  } catch {
    reject('payload_encoding');
  }

  // 4. Signatures over "moat:bundle:v1\n" ‖ payloadBytes. Unknown key ids are ignored (they may
  //    belong to another gate's signer); a known key id with a wrong algorithm or signature
  //    rejects the bundle. Each key id counts once.
  const na = await sodium();
  const message = signedMessage(payloadBytes);
  const valid = new Set<string>();
  for (const entry of entries as { kid: string; alg: string; sig: string }[]) {
    const signer = context.signers.find((pinned) => pinned.kid === entry.kid);
    if (signer === undefined) continue;
    if (entry.alg !== signer.alg) reject('signature_invalid');
    let signature: Uint8Array;
    try {
      signature = fromBase64UrlLength(entry.sig, 64);
    } catch {
      reject('signature_invalid');
    }
    if (!na.crypto_sign_verify_detached(signature, message, signer.publicKey)) {
      reject('signature_invalid');
    }
    valid.add(signer.kid);
  }
  if (valid.size < Math.max(1, context.threshold)) reject('threshold_not_met');

  // 5. Now the payload is authentic: parse and check its shape.
  let payload: JsonValue;
  try {
    payload = parseStrictJson(payloadBytes);
  } catch {
    reject('payload_invalid');
  }
  if (!isBundlePayload(payload)) reject('payload_invalid');

  // 6. Bound to this gate (SEC-07).
  if (payload.gateId !== context.gateId) reject('gate_mismatch');

  // 7. Monotonic (SEC-04).
  if (payload.version <= context.currentVersion) reject('version_not_newer');

  // 8. Optional expiry (SEC-05).
  if (
    context.expiryEnabled &&
    payload.expiresAt !== null &&
    payload.expiresAt <= context.now
  ) {
    reject('expired');
  }

  return { payload, payloadBytes };
}

const PAYLOAD_KEYS = [
  'type',
  'v',
  'gateId',
  'version',
  'issuedAt',
  'expiresAt',
  'config',
  'secrets',
] as const;

function isBundlePayload(value: JsonValue): value is JsonValue & BundlePayload {
  return (
    isJsonObject(value) &&
    hasExactKeys(value, PAYLOAD_KEYS) &&
    value['type'] === 'moat.bundle' &&
    value['v'] === 1 &&
    typeof value['gateId'] === 'string' &&
    typeof value['version'] === 'number' &&
    value['version'] >= 1 &&
    typeof value['issuedAt'] === 'number' &&
    value['issuedAt'] >= 0 &&
    (value['expiresAt'] === null ||
      (typeof value['expiresAt'] === 'number' && value['expiresAt'] >= 0)) &&
    isJsonObject(value['config']) &&
    isJsonObject(value['secrets'])
  );
}
