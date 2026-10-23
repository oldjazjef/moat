import { toBase64Url } from '../encoding/base64url';
import { utf8 } from '../encoding/utf8';
import { sodium } from './sodium';
import { isPasskeyPoint, parseEcdsaDer, subtle } from './webauthn';

/**
 * Reads the result of `navigator.credentials.create` for a new passkey (trust mode 2,
 * docs/CRYPTO.md §7.1): the 65-byte P-256 point and the credential id, and nothing else is
 * taken from it. Pure and strict: a small CBOR subset only (no tags, floats, indefinite lengths
 * or non-minimal encodings), exact sizes, the whole input consumed. The attestation statement is
 * parsed but never trusted or used — Moat pins a key the person compares by fingerprint, it does
 * not rely on an authenticator's attestation (a "none" attestation is what is asked for).
 */

export type CborValue =
  | number
  | string
  | Uint8Array
  | readonly CborValue[]
  | ReadonlyMap<number | string, CborValue>;

export const MAX_ATTESTATION_BYTES = 16 * 1024;
export const MAX_CLIENT_DATA_BYTES = 2048;
const MAX_DEPTH = 6;
const MAX_ITEMS = 256;

export type PasskeyEnrollmentCode =
  | 'attestation_malformed'
  | 'client_data_invalid'
  | 'challenge_mismatch'
  | 'origin_mismatch'
  | 'rp_mismatch'
  | 'user_verification_missing'
  | 'credential_missing'
  | 'key_unsupported'
  | 'point_invalid';

export class PasskeyEnrollmentError extends Error {
  override readonly name = 'PasskeyEnrollmentError';
  constructor(readonly code: PasskeyEnrollmentCode) {
    super(code);
  }
}

const fail = (code: PasskeyEnrollmentCode): never => {
  throw new PasskeyEnrollmentError(code);
};

/**
 * One CBOR item (RFC 8949) of the subset WebAuthn uses: unsigned and negative integers (up to
 * 2^53), byte and text strings, arrays and maps with integer or text keys. Anything else, and
 * trailing bytes, is `attestation_malformed`.
 */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const reader = new Reader(bytes);
  const value = reader.item(0);
  if (!reader.done) fail('attestation_malformed');
  return value;
}

/** Like decodeCbor, but for a prefix: the value and the number of bytes it took. */
export function decodeCborPrefix(bytes: Uint8Array): {
  value: CborValue;
  length: number;
} {
  const reader = new Reader(bytes);
  const value = reader.item(0);
  return { value, length: reader.position };
}

class Reader {
  position = 0;
  private items = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.position === this.bytes.length;
  }

  item(depth: number): CborValue {
    if (depth > MAX_DEPTH || ++this.items > MAX_ITEMS)
      return fail('attestation_malformed');
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 0x1f;
    if (major === 6 || major === 7) return fail('attestation_malformed');
    const argument = this.argument(info);
    switch (major) {
      case 0:
        return argument;
      case 1:
        return -1 - argument;
      case 2:
        return this.take(argument);
      case 3:
        return this.text(argument);
      case 4: {
        if (argument > MAX_ITEMS) return fail('attestation_malformed');
        const list: CborValue[] = [];
        for (let index = 0; index < argument; index++)
          list.push(this.item(depth + 1));
        return list;
      }
      default: {
        if (argument > MAX_ITEMS) return fail('attestation_malformed');
        const map = new Map<number | string, CborValue>();
        for (let index = 0; index < argument; index++) {
          const key = this.item(depth + 1);
          if (typeof key !== 'number' && typeof key !== 'string')
            return fail('attestation_malformed');
          if (map.has(key)) return fail('attestation_malformed');
          map.set(key, this.item(depth + 1));
        }
        return map;
      }
    }
  }

  private byte(): number {
    const value = this.bytes[this.position];
    if (value === undefined) return fail('attestation_malformed');
    this.position += 1;
    return value;
  }

  /** The argument in its shortest form only; indefinite lengths and 64-bit values are refused. */
  private argument(info: number): number {
    if (info < 24) return info;
    let value: number;
    let minimum: number;
    switch (info) {
      case 24:
        value = this.byte();
        minimum = 24;
        break;
      case 25:
        value = this.read(2, () => this.view.getUint16(this.position));
        minimum = 0x100;
        break;
      case 26:
        value = this.read(4, () => this.view.getUint32(this.position));
        minimum = 0x10000;
        break;
      case 27: {
        const big = this.read(8, () => this.view.getBigUint64(this.position));
        if (big > BigInt(Number.MAX_SAFE_INTEGER))
          return fail('attestation_malformed');
        value = Number(big);
        minimum = 0x100000000;
        break;
      }
      default:
        return fail('attestation_malformed');
    }
    if (value < minimum) return fail('attestation_malformed');
    return value;
  }

  private read<T>(size: number, get: () => T): T {
    if (this.position + size > this.bytes.length)
      return fail('attestation_malformed');
    const value = get();
    this.position += size;
    return value;
  }

  private take(length: number): Uint8Array {
    if (length > this.bytes.length - this.position)
      return fail('attestation_malformed');
    const slice = this.bytes.slice(this.position, this.position + length);
    this.position += length;
    return slice;
  }

  private text(length: number): string {
    const raw = this.take(length);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      return fail('attestation_malformed');
    }
  }
}

const isMap = (
  value: CborValue | undefined,
): value is ReadonlyMap<number | string, CborValue> => value instanceof Map;
const isBytes = (value: CborValue | undefined): value is Uint8Array =>
  value instanceof Uint8Array;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;
const FLAG_ED = 0x80;

export interface ParsedAuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly flags: number;
  readonly credentialId: Uint8Array;
  /** The credential public key as a COSE_Key map (not yet checked). */
  readonly cose: ReadonlyMap<number | string, CborValue>;
}

/** `{ fmt, attStmt, authData }` of the attestation object, `authData` taken apart. */
export function parseAttestationObject(
  attestationObject: Uint8Array,
): ParsedAuthenticatorData {
  if (
    attestationObject.length < 1 ||
    attestationObject.length > MAX_ATTESTATION_BYTES
  )
    return fail('attestation_malformed');
  const object = decodeCbor(attestationObject);
  if (!isMap(object) || object.size !== 3) return fail('attestation_malformed');
  const fmt = object.get('fmt');
  const statement = object.get('attStmt');
  const authData = object.get('authData');
  if (typeof fmt !== 'string' || !isMap(statement) || !isBytes(authData))
    return fail('attestation_malformed');
  return parseAuthenticatorData(authData);
}

export function parseAuthenticatorData(
  authData: Uint8Array,
): ParsedAuthenticatorData {
  // rpIdHash (32) ‖ flags (1) ‖ signCount (4) ‖ aaguid (16) ‖ credIdLen (2) ‖ credId ‖ COSE key
  if (authData.length < 37 + 18) return fail('attestation_malformed');
  const flags = authData[32] ?? 0;
  if ((flags & FLAG_AT) === 0) return fail('credential_missing');
  const idLength = ((authData[53] ?? 0) << 8) | (authData[54] ?? 0);
  // WebAuthn level 3: a credential id has 16 to 1023 bytes.
  if (idLength < 16 || idLength > 1023) return fail('credential_missing');
  const keyStart = 55 + idLength;
  if (authData.length <= keyStart) return fail('attestation_malformed');
  const credentialId = authData.slice(55, keyStart);
  const { value, length } = decodeCborPrefix(authData.subarray(keyStart));
  if (!isMap(value)) return fail('attestation_malformed');
  const rest = authData.subarray(keyStart + length);
  if ((flags & FLAG_ED) !== 0) {
    // Extension outputs: one map, exactly.
    const extensions = decodeCbor(rest);
    if (!isMap(extensions)) return fail('attestation_malformed');
  } else if (rest.length !== 0) {
    return fail('attestation_malformed');
  }
  return {
    rpIdHash: authData.slice(0, 32),
    flags,
    credentialId,
    cose: value,
  };
}

/**
 * The COSE_Key of an ES256 credential: exactly `{1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256),
 * -2: x (32 bytes), -3: y (32 bytes)}`. Returns the uncompressed point `0x04 ‖ x ‖ y`.
 */
export function pointOfCoseKey(
  cose: ReadonlyMap<number | string, CborValue>,
): Uint8Array {
  const x = cose.get(-2);
  const y = cose.get(-3);
  if (
    cose.size !== 5 ||
    cose.get(1) !== 2 ||
    cose.get(3) !== -7 ||
    cose.get(-1) !== 1 ||
    !isBytes(x) ||
    !isBytes(y)
  )
    return fail('key_unsupported');
  if (x.length !== 32 || y.length !== 32) return fail('key_unsupported');
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(x, 1);
  point.set(y, 33);
  return point;
}

/** Whether the point is on the P-256 curve (Web Crypto refuses anything else). */
export async function isOnCurve(point: Uint8Array): Promise<boolean> {
  try {
    await subtle().importKey(
      'raw',
      new Uint8Array(point),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return true;
  } catch {
    return false;
  }
}

const sha256 = async (data: Uint8Array | string): Promise<Uint8Array> =>
  (await sodium()).crypto_hash_sha256(
    typeof data === 'string' ? utf8(data) : data,
  );

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++)
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

export interface EnrollmentInput {
  readonly attestationObject: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  /** The challenge the main process made for this ceremony (32 random bytes). */
  readonly challenge: Uint8Array;
  readonly rpId: string;
  readonly origin: string;
}

export interface EnrolledPasskey {
  readonly credentialId: Uint8Array;
  /** 0x04 ‖ X ‖ Y, on the curve. */
  readonly point: Uint8Array;
}

/**
 * Checks what the window reports about a new passkey before it is stored: `clientDataJSON` is a
 * `webauthn.create` for exactly this challenge and origin, the authenticator data is for this
 * rpId with user presence and verification, and the key is an ES256 point on the curve. Throws
 * PasskeyEnrollmentError otherwise; stores nothing itself.
 */
export async function verifyEnrollment(
  input: EnrollmentInput,
): Promise<EnrolledPasskey> {
  if (
    input.clientDataJSON.length < 1 ||
    input.clientDataJSON.length > MAX_CLIENT_DATA_BYTES
  )
    return fail('client_data_invalid');
  let client: unknown;
  try {
    client = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(input.clientDataJSON),
    );
  } catch {
    return fail('client_data_invalid');
  }
  if (typeof client !== 'object' || client === null || Array.isArray(client))
    return fail('client_data_invalid');
  const record = client as Record<string, unknown>;
  if (record['type'] !== 'webauthn.create') return fail('client_data_invalid');
  if (record['challenge'] !== toBase64Url(input.challenge))
    return fail('challenge_mismatch');
  if (
    record['origin'] !== input.origin ||
    (Object.hasOwn(record, 'crossOrigin') && record['crossOrigin'] !== false)
  )
    return fail('origin_mismatch');

  const data = parseAttestationObject(input.attestationObject);
  if (!equal(data.rpIdHash, await sha256(input.rpId)))
    return fail('rp_mismatch');
  if ((data.flags & FLAG_UP) === 0 || (data.flags & FLAG_UV) === 0)
    return fail('user_verification_missing');
  const point = pointOfCoseKey(data.cose);
  if (!(await isOnCurve(point))) return fail('point_invalid');
  return { credentialId: data.credentialId, point };
}

// ── Sign-in with a passkey (Moat Cloud accounts, SEC-51) ───────────────────────────────────

export type PasskeyAssertionCode =
  | 'assertion_malformed'
  | 'client_data_invalid'
  | 'challenge_mismatch'
  | 'origin_mismatch'
  | 'rp_mismatch'
  | 'user_verification_missing'
  | 'signature_invalid';

export class PasskeyAssertionError extends Error {
  override readonly name = 'PasskeyAssertionError';
  constructor(readonly code: PasskeyAssertionCode) {
    super(code);
  }
}

const refuse = (code: PasskeyAssertionCode): never => {
  throw new PasskeyAssertionError(code);
};

export const MAX_ASSERTION_AUTHENTICATOR_DATA = 1024;
export const MAX_ASSERTION_SIGNATURE = 80;

export interface AssertionInput {
  /** The stored credential public key: 0x04 ‖ X ‖ Y. */
  readonly point: Uint8Array;
  /** The challenge the server made for this sign-in (32 random bytes). */
  readonly challenge: Uint8Array;
  readonly rpId: string;
  readonly origin: string;
  readonly authenticatorData: Uint8Array;
  readonly clientDataJSON: Uint8Array;
  /** The DER signature of the assertion response. */
  readonly signature: Uint8Array;
}

export interface VerifiedAssertion {
  /** The authenticator's counter (0 when it keeps none). */
  readonly signCount: number;
}

/**
 * Checks what `navigator.credentials.get` returned for a sign-in: `clientDataJSON` is a
 * `webauthn.get` for exactly this challenge and origin, the authenticator data is for this rpId
 * with user presence **and** verification, and the ECDSA signature over `authenticatorData ‖
 * SHA-256(clientDataJSON)` verifies with the stored key. Throws PasskeyAssertionError otherwise.
 * The counter policy (a counter that did not rise) is the caller's: it knows the stored value.
 */
export async function verifyAssertion(
  input: AssertionInput,
): Promise<VerifiedAssertion> {
  if (
    input.authenticatorData.length < 37 ||
    input.authenticatorData.length > MAX_ASSERTION_AUTHENTICATOR_DATA ||
    input.signature.length < 8 ||
    input.signature.length > MAX_ASSERTION_SIGNATURE
  )
    return refuse('assertion_malformed');
  if (
    input.clientDataJSON.length < 1 ||
    input.clientDataJSON.length > MAX_CLIENT_DATA_BYTES
  )
    return refuse('client_data_invalid');
  let client: unknown;
  try {
    client = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(input.clientDataJSON),
    );
  } catch {
    return refuse('client_data_invalid');
  }
  if (typeof client !== 'object' || client === null || Array.isArray(client))
    return refuse('client_data_invalid');
  const record = client as Record<string, unknown>;
  if (record['type'] !== 'webauthn.get') return refuse('client_data_invalid');
  if (record['challenge'] !== toBase64Url(input.challenge))
    return refuse('challenge_mismatch');
  if (
    record['origin'] !== input.origin ||
    (Object.hasOwn(record, 'crossOrigin') && record['crossOrigin'] !== false)
  )
    return refuse('origin_mismatch');

  const data = input.authenticatorData;
  if (!equal(data.subarray(0, 32), await sha256(input.rpId)))
    return refuse('rp_mismatch');
  const flags = data[32] ?? 0;
  if ((flags & FLAG_UP) === 0 || (flags & FLAG_UV) === 0)
    return refuse('user_verification_missing');

  const rs = parseEcdsaDer(input.signature);
  if (rs === null || !isPasskeyPoint(input.point))
    return refuse('signature_invalid');
  const signed = new Uint8Array(data.length + 32);
  signed.set(data, 0);
  signed.set(await sha256(input.clientDataJSON), data.length);
  let valid = false;
  try {
    const key = await subtle().importKey(
      'raw',
      new Uint8Array(input.point),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    valid = await subtle().verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new Uint8Array(rs),
      signed,
    );
  } catch {
    valid = false; // a point off the curve, or no Web Crypto: closed
  }
  if (!valid) return refuse('signature_invalid');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { signCount: view.getUint32(33, false) };
}
