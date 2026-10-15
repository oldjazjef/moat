/**
 * Vectors for trust mode 2, passkeys (docs/CRYPTO.md §7, §8, §11): `crypto/webauthn.json` (bundle
 * envelopes with WebAuthn ES256 entries, verified in the order of §7.3) and `crypto/trust.json`
 * (trust files of the three modes). Every key is TEST ONLY, derived from a public label; the
 * signatures are deterministic (RFC 6979), so `pnpm vectors` produces no diff.
 *
 * Each rejecting case is built so that exactly one check of §7.3 fails: everything else in the
 * assertion is signed correctly by the pinned key.
 */
import {
  assembleEnvelope,
  bundlePayloadBytes,
  type BundlePayload,
  type SignatureEntry,
} from '../src/bundle/bundle';
import { keyId } from '../src/crypto/kid';
import { sodium } from '../src/crypto/sodium';
import { encodeEcdsaDer, WEBAUTHN_ALG } from '../src/crypto/webauthn';
import { toBase64Url } from '../src/encoding/base64url';
import { concatBytes, utf8 } from '../src/encoding/utf8';
import type { JsonValue } from '../src/json/strict-json';
import {
  P256_ORDER,
  publicPoint,
  scalarFrom,
  signDeterministic,
  toBigInt,
  toBytes32,
} from './p256-test-signer';

type Json = JsonValue;
type Expect = { ok: true; [key: string]: Json } | { ok: false; error: string };

const NOTICE =
  'TEST ONLY — every key in this file is derived from a public label. Never use it anywhere else.';
const NOW = 1791792000;
const CURRENT_VERSION = 41;

interface Passkey {
  readonly name: string;
  readonly scalar: bigint;
  readonly point: Uint8Array;
  readonly kid: string;
  readonly rpId: string;
  readonly origins: string[];
}

async function seed(label: string, length = 32): Promise<Uint8Array> {
  const na = await sodium();
  return na.crypto_generichash(length, utf8(`moat:test-only:${label}`), null);
}

async function passkey(
  name: string,
  rpId: string,
  origins: string[],
): Promise<Passkey> {
  const scalar = scalarFrom(await seed(`passkey-${name}`));
  const point = publicPoint(scalar);
  return {
    name,
    scalar,
    point,
    kid: await keyId(WEBAUTHN_ALG, point),
    rpId,
    origins,
  };
}

/** What the test authenticator is told to do wrong, if anything. */
interface Options {
  rpId?: string;
  flags?: number;
  tail?: Uint8Array;
  authenticatorData?: Uint8Array;
  type?: string;
  origin?: string;
  challenge?: string;
  /** Raw JSON text for the `crossOrigin` member; null leaves it out. */
  crossOrigin?: string | null;
  /** Raw JSON members appended to clientDataJSON, e.g. `"x":1`. */
  extra?: string;
  clientDataText?: string;
  clientDataBytes?: Uint8Array;
  /** Pad clientDataJSON with an extra string member to exactly this many bytes. */
  clientDataLength?: number;
  /** Sign another key's data: the key, or other bytes than the ones sent. */
  signWith?: Passkey;
  signOver?: { authenticatorData: Uint8Array; clientData: Uint8Array };
  sigTransform?: (der: Uint8Array) => Uint8Array;
  sigLength?: number;
}

export async function buildWebauthnVectors(): Promise<Record<string, Json>> {
  const na = await sodium();
  const sha = (bytes: Uint8Array): Uint8Array => na.crypto_hash_sha256(bytes);
  const gateId = toBase64Url(await seed('gate-id-1', 16));
  const otherGateId = toBase64Url(await seed('gate-id-2', 16));

  const ed = na.crypto_sign_seed_keypair(await seed('signer-a'));
  const edKid = await keyId('ed25519', ed.publicKey);

  const p1 = await passkey('1', 'moat.example.org', ['app://moat']);
  const p2 = await passkey('2', 'moat.example.org', [
    'app://moat',
    'https://moat.example.org',
  ]);
  const p3 = await passkey('3', 'other.example.net', [
    'https://other.example.net:8443',
  ]);

  const payload = (overrides: Partial<BundlePayload> = {}): BundlePayload => ({
    type: 'moat.bundle',
    v: 1,
    gateId,
    version: 42,
    issuedAt: NOW - 60,
    expiresAt: null,
    config: {
      version: 1,
      routes: { contact: { upstream: 'hubspot', path: '/contact' } },
    },
    secrets: {},
    ...overrides,
  });
  const messageOf = (payloadBytes: Uint8Array): Uint8Array =>
    concatBytes(utf8('moat:bundle:v1\n'), payloadBytes);
  const challengeOf = (payloadBytes: Uint8Array): string =>
    toBase64Url(sha(messageOf(payloadBytes)));

  /** The entry a passkey returns for these payload bytes, with the given faults. */
  const entry = (
    key: Passkey,
    payloadBytes: Uint8Array,
    options: Options = {},
  ): Record<string, Json> => {
    const authenticatorData =
      options.authenticatorData ??
      concatBytes(
        sha(utf8(options.rpId ?? key.rpId)),
        new Uint8Array([options.flags ?? 0x05]),
        new Uint8Array([0, 0, 0, 7]),
        options.tail ?? new Uint8Array(0),
      );
    const members = (pad: string): string =>
      options.clientDataText ??
      `{"type":${JSON.stringify(options.type ?? 'webauthn.get')},"challenge":${JSON.stringify(
        options.challenge ?? challengeOf(payloadBytes),
      )},"origin":${JSON.stringify(options.origin ?? key.origins[0])}${
        options.crossOrigin === null
          ? ''
          : `,"crossOrigin":${options.crossOrigin ?? 'false'}`
      }${options.extra === undefined ? '' : `,${options.extra}`}${pad}}`;
    let clientData: Uint8Array;
    if (options.clientDataBytes !== undefined) {
      clientData = options.clientDataBytes;
    } else if (options.clientDataLength !== undefined) {
      const base = utf8(members(',"pad":""')).length;
      clientData = utf8(
        members(`,"pad":"${'x'.repeat(options.clientDataLength - base)}"`),
      );
    } else {
      clientData = utf8(members(''));
    }
    const signed = options.signOver ?? { authenticatorData, clientData };
    const rs = signDeterministic(
      na,
      (options.signWith ?? key).scalar,
      concatBytes(signed.authenticatorData, sha(signed.clientData)),
    );
    let der = encodeEcdsaDer(rs);
    if (options.sigTransform !== undefined) der = options.sigTransform(der);
    if (options.sigLength !== undefined) {
      der = concatBytes(der, new Uint8Array(options.sigLength - der.length));
    }
    return {
      kid: key.kid,
      alg: WEBAUTHN_ALG,
      sig: toBase64Url(der),
      authenticatorData: toBase64Url(authenticatorData),
      clientDataJSON: toBase64Url(clientData),
    };
  };

  const envelopeOf = (
    payloadBytes: Uint8Array,
    entries: Record<string, Json>[],
  ): string =>
    assembleEnvelope(payloadBytes, entries as unknown as SignatureEntry[]);

  interface Context {
    gateId: string;
    pinned: string[];
    threshold: number;
    currentVersion: number;
    now: number;
    expiryEnabled: boolean;
  }
  const context = (overrides: Partial<Context> = {}): Context => ({
    gateId,
    pinned: ['p1'],
    threshold: 1,
    currentVersion: CURRENT_VERSION,
    now: NOW,
    expiryEnabled: true,
    ...overrides,
  });
  const ok: Expect = { ok: true, gateId, version: 42 };
  const fail = (error: string): Expect => ({ ok: false, error });

  const bytes = bundlePayloadBytes(payload());
  const other = bundlePayloadBytes(payload({ version: 43 }));
  const single = (
    options: Options = {},
    key: Passkey = p1,
    payloadBytes: Uint8Array = bytes,
  ): string => envelopeOf(payloadBytes, [entry(key, payloadBytes, options)]);
  const mutated = (
    change: (item: Record<string, Json>) => void,
    key: Passkey = p1,
  ): string => {
    const item = entry(key, bytes);
    change(item);
    return envelopeOf(bytes, [item]);
  };
  /** The same signature with s replaced by n − s (the "other" S; both are valid ECDSA). */
  const otherS = (key: Passkey, options: Options = {}): string => {
    const item = entry(key, bytes, options);
    const der = Uint8Array.from(
      Buffer.from(
        String(item['sig']).replaceAll('-', '+').replaceAll('_', '/'),
        'base64',
      ),
    );
    const rLength = der[3] ?? 0;
    const rBytes = der.subarray(4, 4 + rLength);
    const sBytes = der.subarray(6 + rLength);
    const r = toBytes32(toBigInt(rBytes));
    const s = toBytes32(P256_ORDER - toBigInt(sBytes));
    item['sig'] = toBase64Url(encodeEcdsaDer(concatBytes(r, s)));
    return envelopeOf(bytes, [item]);
  };
  const rsOf = (key: Passkey, options: Options = {}): Uint8Array => {
    // The r ‖ s the key produced for this assertion, to rebuild malformed encodings from it.
    const item = entry(key, bytes, options);
    const text = Buffer.from(
      String(item['sig']).replaceAll('-', '+').replaceAll('_', '/'),
      'base64',
    );
    const rLength = text[3] ?? 0;
    return concatBytes(
      toBytes32(toBigInt(text.subarray(4, 4 + rLength))),
      toBytes32(toBigInt(text.subarray(6 + rLength))),
    );
  };
  const rs1 = rsOf(p1);
  const withSig = (der: Uint8Array): string =>
    mutated((item) => {
      item['sig'] = toBase64Url(der);
    });
  const good = encodeEcdsaDer(rs1);
  const derInt = (value: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < 31 && value[start] === 0) start++;
    const body = value.subarray(start);
    return concatBytes(
      new Uint8Array([0x02, body.length + ((body[0] ?? 0) >= 0x80 ? 1 : 0)]),
      (body[0] ?? 0) >= 0x80 ? new Uint8Array([0]) : new Uint8Array(0),
      body,
    );
  };
  const sequence = (...parts: Uint8Array[]): Uint8Array => {
    const body = concatBytes(...parts);
    return concatBytes(new Uint8Array([0x30, body.length]), body);
  };
  const r1 = rs1.subarray(0, 32);
  const s1 = rs1.subarray(32);
  const zero = new Uint8Array(32);

  const ed25519Entry = (): Record<string, Json> => ({
    kid: edKid,
    alg: 'ed25519',
    sig: toBase64Url(na.crypto_sign_detached(messageOf(bytes), ed.privateKey)),
  });

  const cases: {
    name: string;
    envelope: string;
    context: Context;
    expect: Expect;
  }[] = [
    // --- accepted
    {
      name: 'valid: one passkey',
      envelope: single(),
      context: context(),
      expect: ok,
    },
    {
      name: 'valid: the other S of the same signature (low-S is not required)',
      envelope: otherS(p1),
      context: context(),
      expect: ok,
    },
    {
      name: 'valid: backup flags BE and BS set next to UP and UV',
      envelope: single({ flags: 0x1d }),
      context: context(),
      expect: ok,
    },
    {
      name: 'valid: extension data after the counter is covered by the signature, not parsed',
      envelope: single({
        flags: 0x85,
        tail: new Uint8Array([0xa1, 0x61, 0x78, 0x01]),
      }),
      context: context(),
      expect: ok,
    },
    {
      name: 'valid: clientDataJSON with more members than the gate reads',
      envelope: single({
        extra:
          '"topOrigin":"https://moat.example.org","other_keys_can_be_added_here":"do not compare clientDataJSON against a template"',
      }),
      context: context(),
      expect: ok,
    },
    {
      name: 'valid: crossOrigin absent',
      envelope: single({ crossOrigin: null }),
      context: context(),
      expect: ok,
    },
    {
      name: 'valid: the second pinned origin of a passkey with two origins',
      envelope: single({ origin: 'https://moat.example.org' }, p2),
      context: context({ pinned: ['p2'] }),
      expect: ok,
    },
    {
      name: 'valid: a passkey on another rpId with a port in its origin',
      envelope: single({}, p3),
      context: context({ pinned: ['p3'] }),
      expect: ok,
    },
    {
      name: 'valid: authenticatorData of exactly 1024 bytes',
      envelope: single({ flags: 0x85, tail: new Uint8Array(1024 - 37) }),
      context: context(),
      expect: ok,
    },
    {
      name: 'valid: clientDataJSON of exactly 2048 bytes',
      envelope: single({ clientDataLength: 2048 }),
      context: context(),
      expect: ok,
    },
    {
      name: 'valid: 2 of 2, both passkeys signed',
      envelope: envelopeOf(bytes, [
        entry(p1, bytes),
        entry(p2, bytes, { origin: 'https://moat.example.org' }),
      ]),
      context: context({ pinned: ['p1', 'p2'], threshold: 2 }),
      expect: ok,
    },
    {
      name: 'valid: 2 of 3 with the third pinned passkey not signing',
      envelope: envelopeOf(bytes, [entry(p2, bytes), entry(p1, bytes)]),
      context: context({ pinned: ['p1', 'p2', 'p3'], threshold: 2 }),
      expect: ok,
    },
    {
      name: 'valid: a kid that is not pinned next to a valid passkey is ignored',
      envelope: envelopeOf(bytes, [entry(p3, bytes), entry(p1, bytes)]),
      context: context(),
      expect: ok,
    },

    // --- threshold
    {
      name: '2 of 2 required, only one passkey signed',
      envelope: single(),
      context: context({ pinned: ['p1', 'p2'], threshold: 2 }),
      expect: fail('threshold_not_met'),
    },
    {
      name: '2 of 2 required, the same passkey twice counts once',
      envelope: envelopeOf(bytes, [entry(p1, bytes), entry(p1, bytes)]),
      context: context({ pinned: ['p1', 'p2'], threshold: 2 }),
      expect: fail('threshold_not_met'),
    },
    {
      name: 'kid not pinned',
      envelope: single({}, p3),
      context: context(),
      expect: fail('threshold_not_met'),
    },
    {
      name: '2 of 2 required, the second passkey signs wrongly',
      envelope: envelopeOf(bytes, [
        entry(p1, bytes),
        entry(p2, bytes, { origin: 'https://evil.example' }),
      ]),
      context: context({ pinned: ['p1', 'p2'], threshold: 2 }),
      expect: fail('signature_invalid'),
    },

    // --- 7.3 step 1: kid and alg
    {
      name: 'ed25519 entry under the kid of a passkey signer',
      envelope: envelopeOf(bytes, [{ ...ed25519Entry(), kid: p1.kid }]),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'webauthn-es256 entry under the kid of an ed25519 signer',
      envelope: envelopeOf(bytes, [{ ...entry(p1, bytes), kid: edKid }]),
      context: context({ pinned: ['a'] }),
      expect: fail('signature_invalid'),
    },
    {
      name: 'valid ed25519 entry against an ed25519 signer still works next to passkey entries',
      envelope: envelopeOf(bytes, [ed25519Entry()]),
      context: context({ pinned: ['a'] }),
      expect: ok,
    },

    // --- envelope shape of an entry
    {
      name: 'webauthn entry without authenticatorData',
      envelope: mutated((item) => delete item['authenticatorData']),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'webauthn entry without clientDataJSON',
      envelope: mutated((item) => delete item['clientDataJSON']),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'webauthn entry with an extra key',
      envelope: mutated((item) => (item['userHandle'] = 'AA')),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'webauthn entry with a non-string authenticatorData',
      envelope: mutated((item) => (item['authenticatorData'] = 37)),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'ed25519 entry with passkey members',
      envelope: envelopeOf(bytes, [
        { ...ed25519Entry(), authenticatorData: 'AA', clientDataJSON: 'AA' },
      ]),
      context: context({ pinned: ['a'] }),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'webauthn entry for a kid that is not pinned is still shape-checked',
      envelope: mutated((item) => delete item['authenticatorData'], p3),
      context: context(),
      expect: fail('envelope_invalid'),
    },

    // --- 7.3 step 2: encoding and sizes
    {
      name: 'sig with base64 padding',
      envelope: mutated((item) => (item['sig'] = `${String(item['sig'])}=`)),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'authenticatorData in the standard base64 alphabet',
      envelope: mutated(
        (item) =>
          (item['authenticatorData'] =
            `+${String(item['authenticatorData']).slice(1)}`),
      ),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'authenticatorData of 36 bytes',
      envelope: single({
        authenticatorData: concatBytes(
          sha(utf8(p1.rpId)),
          new Uint8Array([0x05, 0, 0, 0]),
        ),
      }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'authenticatorData of 1025 bytes',
      envelope: single({ flags: 0x85, tail: new Uint8Array(1025 - 37) }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'clientDataJSON of 2049 bytes',
      envelope: single({ clientDataLength: 2049 }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'empty clientDataJSON',
      envelope: single({ clientDataBytes: new Uint8Array(0) }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'sig of 81 bytes',
      envelope: single({ sigLength: 81 }),
      context: context(),
      expect: fail('signature_invalid'),
    },

    // --- 7.3 step 3: clientDataJSON
    {
      name: 'wrong challenge: the challenge of another bundle',
      envelope: single({ challenge: challengeOf(other) }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'wrong challenge: SHA-256 of the payload without the domain prefix',
      envelope: single({ challenge: toBase64Url(sha(bytes)) }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'wrong challenge: the right bytes in padded base64',
      envelope: single({ challenge: `${challengeOf(bytes)}=` }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'wrong challenge: the right bytes in the standard alphabet',
      envelope: single({
        challenge:
          challengeOf(bytes).replaceAll('-', '+').replaceAll('_', '/') + 'x',
      }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'a signed assertion replayed on another payload',
      envelope: envelopeOf(other, [entry(p1, bytes)]),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'wrong type: webauthn.create',
      envelope: single({ type: 'webauthn.create' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'wrong type: different case',
      envelope: single({ type: 'WebAuthn.get' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'origin not pinned',
      envelope: single({ origin: 'https://evil.example' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'origin of the other passkey signer is not pinned for this one',
      envelope: single({ origin: 'https://moat.example.org' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'origin with a trailing slash',
      envelope: single({ origin: 'app://moat/' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'origin in upper case',
      envelope: single({ origin: 'APP://MOAT' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'origin missing',
      envelope: single({
        clientDataText: `{"type":"webauthn.get","challenge":"${challengeOf(bytes)}","crossOrigin":false}`,
      }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'crossOrigin true',
      envelope: single({ crossOrigin: 'true' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'crossOrigin as a string',
      envelope: single({ crossOrigin: '"false"' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'crossOrigin null',
      envelope: single({ crossOrigin: 'null' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'clientDataJSON is not JSON',
      envelope: single({ clientDataText: 'webauthn.get' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'clientDataJSON is an array',
      envelope: single({ clientDataText: '[]' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'clientDataJSON with a float member (strict JSON)',
      envelope: single({ extra: '"x":1.5' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'clientDataJSON with a byte order mark',
      envelope: single({
        clientDataBytes: concatBytes(
          new Uint8Array([0xef, 0xbb, 0xbf]),
          utf8(
            `{"type":"webauthn.get","challenge":"${challengeOf(bytes)}","origin":"app://moat"}`,
          ),
        ),
      }),
      context: context(),
      expect: fail('signature_invalid'),
    },

    // --- 7.3 step 4: authenticatorData
    {
      name: 'rpIdHash of another rpId',
      envelope: single({ rpId: 'evil.example' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'rpIdHash of the rpId in upper case',
      envelope: single({ rpId: 'MOAT.EXAMPLE.ORG' }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'user presence flag missing',
      envelope: single({ flags: 0x04 }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'user verification flag missing',
      envelope: single({ flags: 0x01 }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'no flags set',
      envelope: single({ flags: 0x00 }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'only the backup flags set',
      envelope: single({ flags: 0x18 }),
      context: context(),
      expect: fail('signature_invalid'),
    },

    // --- 7.3 step 5: DER
    {
      name: 'DER with a byte after the sequence',
      envelope: withSig(concatBytes(good, new Uint8Array([0]))),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'DER with a long-form sequence length',
      envelope: withSig(
        concatBytes(
          new Uint8Array([0x30, 0x81, good[1] ?? 0]),
          good.subarray(2),
        ),
      ),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'DER with a non-minimal integer',
      envelope: withSig(
        sequence(new Uint8Array([0x02, 0x02, 0x00, 0x01]), derInt(s1)),
      ),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'DER with a negative r',
      envelope: withSig(
        sequence(
          concatBytes(new Uint8Array([0x02, 32, 0x80]), r1.subarray(1)),
          derInt(s1),
        ),
      ),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'DER with r = 0',
      envelope: withSig(sequence(derInt(zero), derInt(s1))),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'DER with s = 0',
      envelope: withSig(sequence(derInt(r1), derInt(zero))),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'DER with s equal to the group order',
      envelope: withSig(sequence(derInt(r1), derInt(toBytes32(P256_ORDER)))),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'DER truncated by one byte',
      envelope: withSig(good.subarray(0, good.length - 1)),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'raw r ‖ s instead of DER',
      envelope: withSig(rs1),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'empty signature',
      envelope: withSig(new Uint8Array(0)),
      context: context(),
      expect: fail('signature_invalid'),
    },

    // --- 7.3 step 6: the signature itself
    {
      name: 'signature over another clientDataJSON',
      envelope: single({
        signOver: {
          authenticatorData: concatBytes(
            sha(utf8(p1.rpId)),
            new Uint8Array([0x05, 0, 0, 0, 7]),
          ),
          clientData: utf8('{"type":"webauthn.get"}'),
        },
      }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'signature over authenticatorData with other flags',
      envelope: single({
        signOver: {
          authenticatorData: concatBytes(
            sha(utf8(p1.rpId)),
            new Uint8Array([0x45, 0, 0, 0, 7]),
          ),
          clientData: utf8(
            `{"type":"webauthn.get","challenge":"${challengeOf(bytes)}","origin":"app://moat","crossOrigin":false}`,
          ),
        },
      }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'signature of another passkey under the pinned kid',
      envelope: single({ signWith: p3 }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'signature with one flipped bit in s',
      envelope: mutated((item) => {
        const der = Uint8Array.from(
          Buffer.from(
            String(item['sig']).replaceAll('-', '+').replaceAll('_', '/'),
            'base64',
          ),
        );
        der[der.length - 1] = (der[der.length - 1] ?? 0) ^ 1;
        item['sig'] = toBase64Url(der);
      }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'a signed assertion for another gate passes step 4 and stops at the gate id',
      envelope: single(
        {},
        p1,
        bundlePayloadBytes(payload({ gateId: otherGateId })),
      ),
      context: context(),
      expect: fail('gate_mismatch'),
    },
    {
      name: 'a signed assertion for an old version stops at the version',
      envelope: single(
        {},
        p1,
        bundlePayloadBytes(payload({ version: CURRENT_VERSION })),
      ),
      context: context(),
      expect: fail('version_not_newer'),
    },
  ];

  const signerInfo = (key: Passkey): Json => ({
    name: key.name === '1' ? 'p1' : key.name === '2' ? 'p2' : 'p3',
    alg: WEBAUTHN_ALG,
    publicKey: toBase64Url(key.point),
    kid: key.kid,
    rpId: key.rpId,
    origins: key.origins,
    privateKey: toBase64Url(toBytes32(key.scalar)),
  });

  const webauthn: Json = {
    description:
      'Bundle envelopes with WebAuthn ES256 entries, verified in the order of docs/CRYPTO.md §7.3 against the pinned signers listed here (`pinned` names them). Each rejecting case fails exactly one check; all other fields are signed correctly. `signers` also holds one Ed25519 signer for the cross-algorithm cases. A passkey signer pins `rpId` and `origins` (§7.1).',
    notice: NOTICE,
    signers: [
      {
        name: 'a',
        alg: 'ed25519',
        publicKey: toBase64Url(ed.publicKey),
        kid: edKid,
      },
      signerInfo(p1),
      signerInfo(p2),
      signerInfo(p3),
    ],
    cases: cases as unknown as Json,
  };

  return {
    'crypto/webauthn.json': webauthn,
    'crypto/trust.json': await trustVectors({ gateId, ed, edKid, p1, p2, p3 }),
  };
}

// ---------------------------------------------------------------------------------------------
// trust.json (docs/CRYPTO.md §7.1, §8)

async function trustVectors(keys: {
  gateId: string;
  ed: { publicKey: Uint8Array };
  edKid: string;
  p1: Passkey;
  p2: Passkey;
  p3: Passkey;
}): Promise<Json> {
  const na = await sodium();
  const { gateId, p1, p2, p3 } = keys;
  const second = na.crypto_sign_seed_keypair(await seed('signer-b'));
  const secondKid = await keyId('ed25519', second.publicKey);
  const edSigner = (publicKey: Uint8Array, kid: string): Json => ({
    kid,
    alg: 'ed25519',
    pk: toBase64Url(publicKey),
  });
  const pkSigner = (
    key: Passkey,
    overrides: Record<string, Json> = {},
  ): Json => ({
    kid: key.kid,
    alg: WEBAUTHN_ALG,
    pk: toBase64Url(key.point),
    rpId: key.rpId,
    origins: key.origins,
    ...overrides,
  });
  const ed1 = edSigner(keys.ed.publicKey, keys.edKid);
  const ed2 = edSigner(second.publicKey, secondKid);

  const file = (overrides: Record<string, Json>): string =>
    JSON.stringify({
      v: 1,
      gateId,
      mode: 2,
      threshold: 1,
      signers: [pkSigner(p1)],
      cloud: null,
      ...overrides,
    });
  const mode2 = (signer: Json): string => file({ signers: [signer] });
  const longName = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(61)}`;
  const reKeyed = async (point: Uint8Array): Promise<Json> => ({
    kid: await keyId(WEBAUTHN_ALG, point),
    alg: WEBAUTHN_ALG,
    pk: toBase64Url(point),
    rpId: p1.rpId,
    origins: p1.origins,
  });

  type Case = { name: string; trust: string; expect: Expect };
  const valid = (
    name: string,
    trust: string,
    mode: number,
    threshold: number,
    kids: string[],
  ): Case => ({ name, trust, expect: { ok: true, mode, threshold, kids } });
  const invalid = (name: string, trust: string): Case => ({
    name,
    trust,
    expect: { ok: false, error: 'trust_invalid' },
  });

  const cases: Case[] = [
    valid(
      'mode 1: one Ed25519 signer',
      file({ mode: 1, signers: [ed1] }),
      1,
      1,
      [keys.edKid],
    ),
    valid(
      'mode 0: one Ed25519 signer',
      file({ mode: 0, signers: [ed1] }),
      0,
      1,
      [keys.edKid],
    ),
    valid(
      'mode 1: 2 of 2 Ed25519 signers',
      file({ mode: 1, threshold: 2, signers: [ed1, ed2] }),
      1,
      2,
      [keys.edKid, secondKid],
    ),
    valid('mode 2: one passkey', file({}), 2, 1, [p1.kid]),
    valid(
      'mode 2: 2 of 2 passkeys',
      file({ threshold: 2, signers: [pkSigner(p1), pkSigner(p2)] }),
      2,
      2,
      [p1.kid, p2.kid],
    ),
    valid(
      'mode 2: a passkey with two origins and a port',
      file({
        signers: [
          pkSigner(p3, {
            origins: ['https://other.example.net:8443', 'app://moat'],
          }),
        ],
      }),
      2,
      1,
      [p3.kid],
    ),
    valid(
      'mode 2: eight origins',
      mode2(
        pkSigner(p1, {
          origins: [
            'app://a',
            'app://b',
            'app://c',
            'app://d',
            'app://e',
            'app://f',
            'app://g',
            'app://h',
          ],
        }),
      ),
      2,
      1,
      [p1.kid],
    ),
    valid(
      'mode 2: rpId of 253 characters',
      mode2(pkSigner(p1, { rpId: longName })),
      2,
      1,
      [p1.kid],
    ),

    invalid('mode 2 with an Ed25519 signer', file({ signers: [ed1] })),
    invalid(
      'mode 1 with a passkey signer',
      file({ mode: 1, signers: [pkSigner(p1)] }),
    ),
    invalid(
      'mode 0 with a passkey signer',
      file({ mode: 0, signers: [pkSigner(p1)] }),
    ),
    invalid(
      'mode 2 mixing a passkey and an Ed25519 signer',
      file({ threshold: 1, signers: [pkSigner(p1), ed1] }),
    ),
    invalid(
      'mode 1 mixing an Ed25519 signer and a passkey',
      file({ mode: 1, signers: [ed1, pkSigner(p1)] }),
    ),
    invalid('mode 3', file({ mode: 3 })),
    invalid('format version 2', file({ v: 2 })),
    invalid(
      'another gate id',
      file({ gateId: toBase64Url(new Uint8Array(16)) }),
    ),
    invalid(
      'cloud key set',
      file({ cloud: { url: 'https://cloud.example', kid: 'x', pk: 'x' } }),
    ),
    invalid('no signers', file({ signers: [] })),
    invalid(
      '17 passkey signers',
      file({ signers: Array.from({ length: 17 }, () => pkSigner(p1)) }),
    ),
    invalid('threshold 0', file({ threshold: 0 })),
    invalid('threshold above the number of signers', file({ threshold: 2 })),
    invalid('threshold as a string', file({ threshold: '1' })),
    invalid(
      'the same passkey twice',
      file({ threshold: 1, signers: [pkSigner(p1), pkSigner(p1)] }),
    ),
    invalid(
      'the same Ed25519 signer twice',
      file({ mode: 1, signers: [ed1, ed1] }),
    ),
    invalid('extra top-level key', file({ note: 'x' })),
    invalid(
      'passkey signer without rpId',
      (() => {
        const { rpId: _rpId, ...rest } = pkSigner(p1) as Record<string, Json>;
        void _rpId;
        return mode2(rest);
      })(),
    ),
    invalid(
      'passkey signer without origins',
      (() => {
        const { origins: _origins, ...rest } = pkSigner(p1) as Record<
          string,
          Json
        >;
        void _origins;
        return mode2(rest);
      })(),
    ),
    invalid(
      'passkey signer with an extra key',
      mode2(pkSigner(p1, { name: 'laptop' })),
    ),
    invalid(
      'Ed25519 signer with rpId and origins',
      file({
        mode: 1,
        signers: [
          {
            ...(ed1 as Record<string, Json>),
            rpId: p1.rpId,
            origins: p1.origins,
          },
        ],
      }),
    ),
    invalid('passkey kid of another key', mode2(pkSigner(p1, { kid: p2.kid }))),
    invalid(
      'passkey kid computed with the ed25519 algorithm',
      mode2(pkSigner(p1, { kid: await keyId('ed25519', p1.point) })),
    ),
    invalid(
      'passkey pk of 64 bytes',
      mode2(await reKeyed(p1.point.subarray(0, 64))),
    ),
    invalid(
      'passkey pk with the compressed prefix 0x02',
      mode2(
        await reKeyed(
          Uint8Array.from(p1.point, (byte, index) => (index === 0 ? 2 : byte)),
        ),
      ),
    ),
    invalid(
      'passkey pk with the prefix 0x05',
      mode2(
        await reKeyed(
          Uint8Array.from(p1.point, (byte, index) => (index === 0 ? 5 : byte)),
        ),
      ),
    ),
    invalid(
      'passkey pk with padding',
      mode2(pkSigner(p1, { pk: `${toBase64Url(p1.point)}=` })),
    ),
    invalid(
      'alg ES256 instead of webauthn-es256',
      mode2(pkSigner(p1, { alg: 'ES256' })),
    ),
    invalid(
      'rpId in upper case',
      mode2(pkSigner(p1, { rpId: 'Moat.example.org' })),
    ),
    invalid(
      'rpId with a trailing dot',
      mode2(pkSigner(p1, { rpId: 'moat.example.org.' })),
    ),
    invalid(
      'rpId that is an IP address',
      mode2(pkSigner(p1, { rpId: '127.0.0.1' })),
    ),
    invalid(
      'rpId with a scheme',
      mode2(pkSigner(p1, { rpId: 'https://moat.example.org' })),
    ),
    invalid(
      'rpId with a port',
      mode2(pkSigner(p1, { rpId: 'moat.example.org:8443' })),
    ),
    invalid(
      'rpId with non-ASCII letters',
      mode2(pkSigner(p1, { rpId: 'bücher.example' })),
    ),
    invalid(
      'rpId of 254 characters',
      mode2(pkSigner(p1, { rpId: `${longName}a` })),
    ),
    invalid('empty rpId', mode2(pkSigner(p1, { rpId: '' }))),
    invalid('rpId that is not a string', mode2(pkSigner(p1, { rpId: 1 }))),
    invalid('no origins', mode2(pkSigner(p1, { origins: [] }))),
    invalid(
      'nine origins',
      mode2(
        pkSigner(p1, {
          origins: [
            'app://a',
            'app://b',
            'app://c',
            'app://d',
            'app://e',
            'app://f',
            'app://g',
            'app://h',
            'app://i',
          ],
        }),
      ),
    ),
    invalid(
      'origins as a string',
      mode2(pkSigner(p1, { origins: 'app://moat' })),
    ),
    invalid(
      'duplicate origins',
      mode2(pkSigner(p1, { origins: ['app://moat', 'app://moat'] })),
    ),
    invalid(
      'origin with plain http',
      mode2(pkSigner(p1, { origins: ['http://moat.example.org'] })),
    ),
    invalid(
      'origin with a trailing slash',
      mode2(pkSigner(p1, { origins: ['https://moat.example.org/'] })),
    ),
    invalid(
      'origin with a path',
      mode2(pkSigner(p1, { origins: ['https://moat.example.org/app'] })),
    ),
    invalid(
      'origin with the default port 443',
      mode2(pkSigner(p1, { origins: ['https://moat.example.org:443'] })),
    ),
    invalid(
      'origin with port 65536',
      mode2(pkSigner(p1, { origins: ['https://moat.example.org:65536'] })),
    ),
    invalid(
      'origin with a leading zero in the port',
      mode2(pkSigner(p1, { origins: ['https://moat.example.org:08443'] })),
    ),
    invalid(
      'origin in upper case',
      mode2(pkSigner(p1, { origins: ['https://Moat.example.org'] })),
    ),
    invalid(
      'origin that is an IP address',
      mode2(pkSigner(p1, { origins: ['https://127.0.0.1:8443'] })),
    ),
    invalid(
      'app origin in upper case',
      mode2(pkSigner(p1, { origins: ['app://Moat'] })),
    ),
    invalid(
      'app origin with a path',
      mode2(pkSigner(p1, { origins: ['app://moat/index.html'] })),
    ),
    invalid(
      'origin of 301 bytes',
      mode2(pkSigner(p1, { origins: [`app://a${'b'.repeat(295)}`] })),
    ),
    invalid(
      'origin that is not a string',
      mode2(pkSigner(p1, { origins: [1] })),
    ),
    invalid('not JSON', 'trust'),
    invalid('a float', file({ threshold: 1.5 })),
  ];

  return {
    description:
      'trust.json (docs/CRYPTO.md §7.1, §8) as a gate parses it: modes 0 and 1 pin only ed25519 signers, mode 2 only webauthn-es256 signers with rpId and origins, never mixed. `trust` is the file text and `gateId` the gate it is read for; a valid file answers mode, threshold and the kids in order, anything else `trust_invalid`. The point of a passkey is not checked against the curve here; that happens when a signature is verified.',
    notice: NOTICE,
    gateId,
    cases: cases as unknown as Json,
  };
}
