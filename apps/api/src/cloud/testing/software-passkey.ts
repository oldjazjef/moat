import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * TEST ONLY: a software authenticator for account passkeys. It produces what
 * `navigator.credentials.create` and `.get` return (a CBOR attestation object with a COSE key,
 * and a signed assertion), so the server's checks can be tried against good and hostile input.
 * Never imported by the app itself.
 */

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, value: number): Uint8Array {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value < 0x100) return Uint8Array.of((major << 5) | 24, value);
  return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
}

const concat = (...parts: Uint8Array[]): Uint8Array => Buffer.concat(parts);

function encode(value: Cbor): Uint8Array {
  if (typeof value === 'number')
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  return concat(
    head(5, value.size),
    ...[...value].flatMap(([key, item]) => [encode(key), encode(item)]),
  );
}

const sha256 = (data: string | Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(data).digest());

export const b64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64url');

export interface SoftwarePasskeyOptions {
  readonly rpId: string;
  readonly origin: string;
}

/** One credential on one imaginary device. */
export class SoftwarePasskey {
  readonly credentialId = new Uint8Array(randomBytes(32));
  private readonly privateKey: KeyObject;
  readonly x: Uint8Array;
  readonly y: Uint8Array;
  signCount = 0;

  constructor(private readonly options: SoftwarePasskeyOptions) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' });
    this.x = new Uint8Array(Buffer.from(jwk.x ?? '', 'base64url'));
    this.y = new Uint8Array(Buffer.from(jwk.y ?? '', 'base64url'));
  }

  /** What `credentials.create` hands back for a challenge. */
  create(
    challenge: Uint8Array,
    patch: { clientType?: string; flags?: number; rpId?: string } = {},
  ): { attestationObject: string; clientDataJSON: string } {
    const cose = new Map<number, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, this.x],
      [-3, this.y],
    ]);
    const authData = concat(
      sha256(patch.rpId ?? this.options.rpId),
      Uint8Array.of(patch.flags ?? 0x45), // UP + UV + AT
      new Uint8Array(4),
      new Uint8Array(16),
      Uint8Array.of(
        this.credentialId.length >> 8,
        this.credentialId.length & 0xff,
      ),
      this.credentialId,
      encode(cose),
    );
    return {
      attestationObject: b64(
        encode(
          new Map<string, Cbor>([
            ['fmt', 'none'],
            ['attStmt', new Map()],
            ['authData', authData],
          ]),
        ),
      ),
      clientDataJSON: b64(
        new TextEncoder().encode(
          JSON.stringify({
            type: patch.clientType ?? 'webauthn.create',
            challenge: b64(challenge),
            origin: this.options.origin,
            crossOrigin: false,
          }),
        ),
      ),
    };
  }

  /** What `credentials.get` hands back for a challenge. */
  get(
    challenge: Uint8Array,
    patch: {
      clientType?: string;
      flags?: number;
      origin?: string;
      rpId?: string;
      signCount?: number;
      /** Sign with another key: a stolen credential id without the key. */
      forged?: boolean;
    } = {},
  ): {
    credentialId: string;
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
  } {
    this.signCount = patch.signCount ?? this.signCount + 1;
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, this.signCount, false);
    const authenticatorData = concat(
      sha256(patch.rpId ?? this.options.rpId),
      Uint8Array.of(patch.flags ?? 0x05), // UP + UV
      counter,
    );
    const clientDataJSON = new TextEncoder().encode(
      JSON.stringify({
        type: patch.clientType ?? 'webauthn.get',
        challenge: b64(challenge),
        origin: patch.origin ?? this.options.origin,
        crossOrigin: false,
      }),
    );
    const key =
      patch.forged === true
        ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
        : this.privateKey;
    const signature = createSign('SHA256')
      .update(concat(authenticatorData, sha256(clientDataJSON)))
      .sign(key); // DER, as the browser returns it
    return {
      credentialId: b64(this.credentialId),
      authenticatorData: b64(authenticatorData),
      clientDataJSON: b64(clientDataJSON),
      signature: b64(new Uint8Array(signature)),
    };
  }
}
