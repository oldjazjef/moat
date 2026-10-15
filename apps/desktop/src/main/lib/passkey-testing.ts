import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';

/**
 * TEST ONLY (specs and the Electron end-to-end script): builds what an authenticator returns for
 * `navigator.credentials.create` — a CBOR attestation object with a COSE key — so the strict
 * parser can be tried against valid and hostile input. Never imported by the app itself.
 */

export type Cbor =
  | number
  | string
  | Uint8Array
  | Cbor[]
  | Map<number | string, Cbor>
  | { raw: Uint8Array };

function head(major: number, value: number): Uint8Array {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value < 0x100) return Uint8Array.of((major << 5) | 24, value);
  if (value < 0x10000)
    return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  return Uint8Array.of(
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export function encodeCbor(value: Cbor): Uint8Array {
  if (typeof value === 'number')
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (Array.isArray(value))
    return concat(head(4, value.length), ...value.map(encodeCbor));
  if (value instanceof Map)
    return concat(
      head(5, value.size),
      ...[...value].flatMap(([key, item]) => [
        encodeCbor(key),
        encodeCbor(item),
      ]),
    );
  return value.raw;
}

export const raw = (bytes: Uint8Array): { raw: Uint8Array } => ({ raw: bytes });

export const sha256 = (data: string | Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

/** A fresh P-256 key as x and y (32 bytes each). */
export function p256Coordinates(): { x: Uint8Array; y: Uint8Array } {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    x: new Uint8Array(Buffer.from(jwk.x ?? '', 'base64url')),
    y: new Uint8Array(Buffer.from(jwk.y ?? '', 'base64url')),
  };
}

export interface AttestationOptions {
  readonly rpId?: string;
  readonly origin?: string;
  readonly challenge?: Uint8Array;
  readonly clientType?: string;
  readonly flags?: number;
  readonly credentialId?: Uint8Array;
  readonly cose?: Cbor;
  readonly x?: Uint8Array;
  readonly y?: Uint8Array;
  /** Appended after the COSE key. */
  readonly trailing?: Uint8Array;
  /** Replaces the whole attestation object bytes. */
  readonly attestationObject?: Uint8Array;
  readonly clientDataJSON?: Uint8Array;
  readonly fmt?: string;
}

export function coseKey(x: Uint8Array, y: Uint8Array): Map<number, Cbor> {
  return new Map<number, Cbor>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, x],
    [-3, y],
  ]);
}

/** What the window reports for a good ceremony; options break one thing at a time. */
export function attestation(
  challenge: Uint8Array,
  options: AttestationOptions = {},
): {
  attestationObject: Uint8Array;
  clientDataJSON: Uint8Array;
  credentialId: Uint8Array;
  x: Uint8Array;
  y: Uint8Array;
} {
  const coordinates =
    options.x !== undefined && options.y !== undefined
      ? { x: options.x, y: options.y }
      : p256Coordinates();
  const credentialId = options.credentialId ?? randomBytes(32);
  const authData = concat(
    sha256(options.rpId ?? 'passkey.moat.invalid'),
    Uint8Array.of(options.flags ?? 0x45), // UP + UV + AT
    new Uint8Array(4),
    new Uint8Array(16),
    Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
    credentialId,
    encodeCbor(options.cose ?? coseKey(coordinates.x, coordinates.y)),
    options.trailing ?? new Uint8Array(),
  );
  const clientDataJSON =
    options.clientDataJSON ??
    new TextEncoder().encode(
      JSON.stringify({
        type: options.clientType ?? 'webauthn.create',
        challenge: Buffer.from(options.challenge ?? challenge).toString(
          'base64url',
        ),
        origin: options.origin ?? 'https://passkey.moat.invalid',
        crossOrigin: false,
      }),
    );
  return {
    attestationObject:
      options.attestationObject ??
      encodeCbor(
        new Map<string, Cbor>([
          ['fmt', options.fmt ?? 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]),
      ),
    clientDataJSON,
    credentialId,
    ...coordinates,
  };
}
