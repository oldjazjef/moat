/**
 * Builds the shared crypto vectors in conformance/vectors/crypto/ (docs/CRYPTO.md §11).
 *
 * Every key here is derived from a fixed label and is TEST ONLY: never use one outside the
 * vectors. Ed25519 signatures are deterministic; the ephemeral key and nonce of each sealed secret
 * are fixed through the test-only randomness injection of sealSecret, so the output is stable and
 * `pnpm vectors` produces no diff unless the format or a case changes.
 *
 * Pure: returns the files as objects. The conformance spec compares them with the committed files
 * (or writes them with `pnpm vectors`).
 */
import { canonicalJsonBytes } from '../src/canonical/jcs';
import { fingerprint, keyId, type KeyAlgorithm } from '../src/crypto/kid';
import { sodium } from '../src/crypto/sodium';
import { toBase64Url } from '../src/encoding/base64url';
import { concatBytes, utf8 } from '../src/encoding/utf8';
import {
  signBundle,
  type BundlePayload,
  type Ed25519Signer,
} from '../src/bundle/bundle';
import { sealSecret, type SealedSecret } from '../src/secrets/seal';
import type { JsonValue } from '../src/json/strict-json';

export const TEST_ONLY_NOTICE =
  'TEST ONLY — every key in this file is derived from a public label. Never use it anywhere else.';

const NOW = 1791792000;
const CURRENT_VERSION = 41;
const MAX_ENVELOPE_BYTES = 1024 * 1024;

type Json = JsonValue;
type Expect = { ok: true; [key: string]: Json } | { ok: false; error: string };

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function testSeed(label: string, length = 32): Promise<Uint8Array> {
  const na = await sodium();
  return na.crypto_generichash(length, utf8(`moat:test-only:${label}`), null);
}

interface TestSigner extends Ed25519Signer {
  readonly name: string;
  readonly kid: string;
}

async function testSigner(name: string): Promise<TestSigner> {
  const na = await sodium();
  const pair = na.crypto_sign_seed_keypair(await testSeed(`signer-${name}`));
  return {
    name,
    alg: 'ed25519',
    secretKey: pair.privateKey,
    publicKey: pair.publicKey,
    kid: await keyId('ed25519', pair.publicKey),
  };
}

// ---------------------------------------------------------------------------------------------
// base64url

function base64urlVectors(): Json {
  const valid: [string, string][] = [
    ['', ''],
    ['66', 'Zg'],
    ['666f', 'Zm8'],
    ['666f6f', 'Zm9v'],
    ['666f6f62', 'Zm9vYg'],
    ['666f6f6261', 'Zm9vYmE'],
    ['666f6f626172', 'Zm9vYmFy'],
    ['fbff', '-_8'],
    ['00000000', 'AAAAAA'],
    ['ffffffffffff', '________'],
  ];
  const invalid: [string, string][] = [
    ['padding', 'Zg=='],
    ['single padding', 'Zm8='],
    ['standard alphabet plus', 'a+b0'],
    ['standard alphabet slash', 'a/b0'],
    ['leading space', ' Zg'],
    ['trailing newline', 'Zg\n'],
    ['impossible length', 'Zm9vY'],
    ['single character', 'Z'],
    ['non-zero trailing bits (1 byte)', 'Zh'],
    ['non-zero trailing bits (2 bytes)', 'Zm9'],
    ['non-ascii character', 'Zé'],
  ];
  return {
    description:
      'base64url without padding (RFC 4648 §5), docs/CRYPTO.md §2. Decoders reject padding, the standard alphabet, whitespace, impossible lengths and non-zero trailing bits.',
    cases: [
      ...valid.map(([bytesHex, text]) => ({
        name: `decode ${JSON.stringify(text)}`,
        input: text,
        expect: { ok: true, hex: bytesHex },
      })),
      ...invalid.map(([name, text]) => ({
        name,
        input: text,
        expect: { ok: false, error: 'encoding_invalid' },
      })),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// strict JSON

function nested(depth: number): string {
  return '['.repeat(depth) + ']'.repeat(depth);
}

function jsonVectors(): Json {
  const ok: [string, string][] = [
    ['empty object', '{}'],
    ['empty array', '[]'],
    ['zero', '0'],
    ['minus zero is zero', '-0'],
    ['largest safe integer', '9007199254740991'],
    ['scalar true', 'true'],
    ['nested values', '{"a":[1,2,{"b":null}],"c":"x"}'],
    ['escaped surrogate pair', '"\\ud83d\\ude00"'],
    ['raw non-ascii text', '"Grüezi 😀"'],
    ['__proto__ is plain data', '{"__proto__":{"admin":true}}'],
    ['numeric-looking key', '{"1":"one","0":"zero"}'],
    ['empty key', '{"":1}'],
    ['whitespace around', ' \n\t{ "a" : 1 }\r\n '],
    ['32 nested containers', nested(32)],
  ];
  const invalid: { name: string; input?: string; inputHex?: string }[] = [
    { name: 'fraction', input: '1.0' },
    { name: 'exponent', input: '1e3' },
    { name: 'negative integer', input: '-1' },
    { name: 'above 2^53 - 1', input: '9007199254740992' },
    { name: 'huge integer', input: '123456789012345678901234567890' },
    { name: 'leading zero', input: '01' },
    { name: 'float inside object', input: '{"a":0.5}' },
    { name: 'lone high surrogate', input: '"\\ud800"' },
    { name: 'lone low surrogate in key', input: '{"\\udc00":1}' },
    { name: 'reversed surrogate pair', input: '"\\ude00\\ud83d"' },
    { name: 'byte order mark', inputHex: 'efbbbf7b7d' },
    { name: 'invalid utf-8', inputHex: '22ff22' },
    { name: 'overlong utf-8', inputHex: '22c0af22' },
    { name: '33 nested containers', input: nested(33) },
    { name: 'trailing comma', input: '{"a":1,}' },
    { name: 'single quotes', input: "{'a':1}" },
    { name: 'NaN', input: 'NaN' },
    { name: 'empty document', input: '' },
    { name: 'two documents', input: '{}{}' },
    { name: 'comment', input: '{} // x' },
  ];
  return {
    description:
      'Strict JSON as every implementation parses envelopes, payloads and data files (docs/CRYPTO.md §2): UTF-8 without BOM, integers 0 … 2^53 − 1 only (-0 counts as 0), no lone surrogates, at most 32 nested containers. `inputHex` is used where the input is not valid UTF-8.',
    cases: [
      ...ok.map(([name, input]) => ({ name, input, expect: { ok: true } })),
      ...invalid.map((item) => ({
        ...item,
        expect: { ok: false, error: 'json_invalid' },
      })),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// JCS

function jcsVectors(): Json {
  const cases: [string, Json, string][] = [
    [
      'keys sorted',
      { b: 1, a: 2, c: { z: null, y: true } },
      '{"a":2,"b":1,"c":{"y":true,"z":null}}',
    ],
    ['arrays keep order', [3, 1, 2], '[3,1,2]'],
    [
      'integer limits',
      { max: 9007199254740991, zero: 0 },
      '{"max":9007199254740991,"zero":0}',
    ],
    [
      'keys sorted by UTF-16 code units',
      { '\u{1F600}': 1, ﬁ: 2, a: 3, Z: 4 },
      '{"Z":4,"a":3,"\u{1F600}":1,"ﬁ":2}',
    ],
    [
      'control characters escaped',
      { s: '\u0000\u0008\u001f\n"\\' },
      '{"s":"\\u0000\\b\\u001f\\n\\"\\\\"}',
    ],
    ['non-ascii stays literal', { s: 'Grüezi €' }, '{"s":"Grüezi €"}'],
    ['solidus not escaped', { s: '/a/' }, '{"s":"/a/"}'],
  ];
  return {
    description:
      'RFC 8785 (JCS) for the subset Moat signs. Signers must produce exactly `canonical` (UTF-8). Gates never canonicalise — they verify the received bytes — so a gate may skip this file.',
    cases: cases.map(([name, input, canonical]) => ({
      name,
      input,
      canonical,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// kid + fingerprint

async function kidVectors(): Promise<Json> {
  const na = await sodium();
  const keys: [string, KeyAlgorithm, Uint8Array][] = [];
  for (const name of ['a', 'b', 'c']) {
    keys.push([
      `signer-${name}`,
      'ed25519',
      (await testSigner(name)).publicKey,
    ]);
  }
  keys.push([
    'gate-box',
    'x25519',
    na.crypto_scalarmult_base(await testSeed('gate-box-1')),
  ]);
  keys.push([
    'webauthn point',
    'webauthn-es256',
    concatBytes(
      new Uint8Array([4]),
      await testSeed('es256-x'),
      await testSeed('es256-y'),
    ),
  ]);
  const cases = [];
  for (const [name, alg, publicKey] of keys) {
    cases.push({
      name,
      alg,
      publicKey: toBase64Url(publicKey),
      kid: await keyId(alg, publicKey),
      fingerprint: await fingerprint(alg, publicKey),
    });
  }
  return {
    description:
      'kid = base64url(BLAKE2b-128("moat:kid:v1|" ‖ alg ‖ "|" ‖ publicKey)); fingerprint = "MOAT-" + base32 of the same 16 bytes in groups of four (docs/CRYPTO.md §3). The webauthn point is arbitrary bytes, not a curve point: the kid only hashes it.',
    cases,
  };
}

// ---------------------------------------------------------------------------------------------
// bundles

interface Context {
  gateId: string;
  pinned: string[];
  threshold: number;
  currentVersion: number;
  now: number;
  expiryEnabled: boolean;
}

async function bundleVectors(): Promise<Json> {
  const na = await sodium();
  const [a, b, c] = [
    await testSigner('a'),
    await testSigner('b'),
    await testSigner('c'),
  ];
  const gateId = toBase64Url(await testSeed('gate-id-1', 16));
  const otherGateId = toBase64Url(await testSeed('gate-id-2', 16));

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

  const context = (overrides: Partial<Context> = {}): Context => ({
    gateId,
    pinned: ['a'],
    threshold: 1,
    currentVersion: CURRENT_VERSION,
    now: NOW,
    expiryEnabled: true,
    ...overrides,
  });

  /** Signs arbitrary payload bytes — for payloads the honest signer would never produce. */
  const signRaw = (
    payloadBytes: Uint8Array,
    signers: TestSigner[],
    domain = 'moat:bundle:v1\n',
  ): string =>
    JSON.stringify({
      moat: 'bundle',
      v: 1,
      payload: toBase64Url(payloadBytes),
      sigs: signers.map((signer) => ({
        kid: signer.kid,
        alg: 'ed25519',
        sig: toBase64Url(
          na.crypto_sign_detached(
            concatBytes(utf8(domain), payloadBytes),
            signer.secretKey,
          ),
        ),
      })),
    });

  const valid = await signBundle(payload(), [a]);
  const validEnvelope = JSON.parse(valid) as {
    payload: string;
    sigs: Json[];
  } & Record<string, Json>;
  const validBytes = canonicalJsonBytes(payload() as unknown as Json);
  const withEnvelope = (
    change: (envelope: Record<string, Json>) => void,
  ): string => {
    const copy = JSON.parse(valid) as Record<string, Json>;
    change(copy);
    return JSON.stringify(copy);
  };
  const raw = (text: string, signers: TestSigner[] = [a]): string =>
    signRaw(utf8(text), signers);
  const payloadText = (): string => new TextDecoder().decode(validBytes);

  const tampered = new Uint8Array(validBytes);
  tampered.set([(tampered.at(-3) ?? 0) ^ 0x01], tampered.length - 3);

  const deep = (depth: number): Json => {
    let value: Json = {};
    for (let index = 0; index < depth; index++) value = { n: value };
    return value;
  };

  type Case = {
    name: string;
    envelope: string;
    padTo?: number;
    context: Context;
    expect: Expect;
  };
  const ok = (version = 42): Expect => ({ ok: true, gateId, version });
  const fail = (error: string): Expect => ({ ok: false, error });

  const cases: Case[] = [
    { name: 'valid', envelope: valid, context: context(), expect: ok() },
    {
      name: 'valid as first bundle',
      envelope: valid,
      context: context({ currentVersion: 0 }),
      expect: ok(),
    },
    {
      name: 'non-canonical payload bytes are verified as received, never re-serialised',
      envelope: raw(JSON.stringify(payload(), null, 2)),
      context: context(),
      expect: ok(),
    },

    // 1. size
    {
      name: 'envelope of exactly 1 MiB (padded with whitespace) is accepted',
      envelope: valid,
      padTo: MAX_ENVELOPE_BYTES,
      context: context(),
      expect: ok(),
    },
    {
      name: 'envelope of 1 MiB + 1 byte is rejected before parsing',
      envelope: valid,
      padTo: MAX_ENVELOPE_BYTES + 1,
      context: context(),
      expect: fail('too_large'),
    },

    // 2. envelope
    {
      name: 'envelope is not JSON',
      envelope: 'moat',
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'envelope is an array',
      envelope: '[]',
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'envelope with an extra field',
      envelope: withEnvelope((e) => (e['note'] = 'x')),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'envelope without sigs',
      envelope: withEnvelope((e) => delete e['sigs']),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'envelope type is not "bundle"',
      envelope: withEnvelope((e) => (e['moat'] = 'release')),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'envelope version 2',
      envelope: withEnvelope((e) => (e['v'] = 2)),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'envelope version as string',
      envelope: withEnvelope((e) => (e['v'] = '1')),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'envelope version 1.0 (float)',
      envelope: valid.replace('"v":1', '"v":1.0'),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'empty sigs',
      envelope: withEnvelope((e) => (e['sigs'] = [])),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'more than 16 signatures',
      envelope: withEnvelope(
        (e) =>
          (e['sigs'] = Array.from(
            { length: 17 },
            () => validEnvelope.sigs[0] ?? null,
          )),
      ),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'signature entry with an extra field',
      envelope: withEnvelope(
        (e) =>
          (e['sigs'] = [
            { ...(validEnvelope.sigs[0] as Record<string, Json>), at: 1 },
          ]),
      ),
      context: context(),
      expect: fail('envelope_invalid'),
    },
    {
      name: 'payload is not a string',
      envelope: withEnvelope(
        (e) => (e['payload'] = payload() as unknown as Json),
      ),
      context: context(),
      expect: fail('envelope_invalid'),
    },

    // 3. payload encoding
    {
      name: 'payload with base64 padding',
      envelope: withEnvelope(
        (e) => (e['payload'] = `${validEnvelope.payload}=`),
      ),
      context: context(),
      expect: fail('payload_encoding'),
    },
    {
      name: 'payload in the standard base64 alphabet',
      envelope: withEnvelope(
        (e) => (e['payload'] = `+${validEnvelope.payload.slice(1)}`),
      ),
      context: context(),
      expect: fail('payload_encoding'),
    },

    // 4. signatures
    {
      name: 'tampered payload',
      envelope: withEnvelope((e) => (e['payload'] = toBase64Url(tampered))),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'signature without the domain prefix',
      envelope: signRaw(validBytes, [a], ''),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'signature with another domain',
      envelope: signRaw(validBytes, [a], 'moat:release:v1\n'),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'known kid with another algorithm',
      envelope: withEnvelope(
        (e) =>
          (e['sigs'] = [
            {
              ...(validEnvelope.sigs[0] as Record<string, Json>),
              alg: 'ed448',
            },
          ]),
      ),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'known kid with a truncated signature',
      envelope: withEnvelope((e) => {
        const sig = validEnvelope.sigs[0] as Record<string, string>;
        e['sigs'] = [{ ...sig, sig: sig['sig']?.slice(0, 80) ?? '' }];
      }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'known kid with a signature by another key',
      envelope: withEnvelope((e) => {
        const other = JSON.parse(signRaw(validBytes, [b])) as {
          sigs: Record<string, Json>[];
        };
        e['sigs'] = [
          { kid: a.kid, alg: 'ed25519', sig: other.sigs[0]?.['sig'] ?? '' },
        ];
      }),
      context: context(),
      expect: fail('signature_invalid'),
    },
    {
      name: 'only an unknown kid',
      envelope: await signBundle(payload(), [c]),
      context: context(),
      expect: fail('threshold_not_met'),
    },
    {
      name: 'unknown kid next to a valid one is ignored',
      envelope: await signBundle(payload(), [c, a]),
      context: context(),
      expect: ok(),
    },
    {
      name: '2 of 2 required, both signed',
      envelope: await signBundle(payload(), [a, b]),
      context: context({ pinned: ['a', 'b'], threshold: 2 }),
      expect: ok(),
    },
    {
      name: '2 of 3 required, one signed',
      envelope: valid,
      context: context({ pinned: ['a', 'b', 'c'], threshold: 2 }),
      expect: fail('threshold_not_met'),
    },
    {
      name: '2 of 2 required, the same kid twice counts once',
      envelope: await signBundle(payload(), [a, a]),
      context: context({ pinned: ['a', 'b'], threshold: 2 }),
      expect: fail('threshold_not_met'),
    },

    // 5. payload
    {
      name: 'signed payload with a float',
      envelope: raw(
        payloadText().replace(
          `"issuedAt":${NOW - 60}`,
          `"issuedAt":${NOW - 60}.0`,
        ),
      ),
      context: context(),
      expect: fail('payload_invalid'),
    },
    {
      name: 'signed payload with an integer above 2^53 - 1',
      envelope: raw(
        payloadText().replace('"version":42', '"version":9007199254740992'),
      ),
      context: context(),
      expect: fail('payload_invalid'),
    },
    {
      name: 'signed payload with a negative integer',
      envelope: raw(
        payloadText().replace(`"issuedAt":${NOW - 60}`, '"issuedAt":-1'),
      ),
      context: context(),
      expect: fail('payload_invalid'),
    },
    {
      name: 'signed payload with an extra field',
      envelope: signRaw(
        canonicalJsonBytes({ ...payload(), extra: true } as unknown as Json),
        [a],
      ),
      context: context(),
      expect: fail('payload_invalid'),
    },
    {
      name: 'signed payload of another type',
      envelope: signRaw(
        canonicalJsonBytes({
          ...payload(),
          type: 'moat.release',
        } as unknown as Json),
        [a],
      ),
      context: context(),
      expect: fail('payload_invalid'),
    },
    {
      name: 'signed payload with version 0',
      envelope: await signBundle(payload({ version: 0 }), [a]),
      context: context({ currentVersion: 0 }),
      expect: fail('payload_invalid'),
    },
    {
      name: 'signed payload that is not JSON',
      envelope: raw('moat'),
      context: context(),
      expect: fail('payload_invalid'),
    },
    {
      name: 'signed payload with a byte order mark',
      envelope: signRaw(
        concatBytes(new Uint8Array([0xef, 0xbb, 0xbf]), validBytes),
        [a],
      ),
      context: context(),
      expect: fail('payload_invalid'),
    },
    {
      name: 'signed payload with a lone surrogate',
      envelope: raw(payloadText().replace('"/contact"', '"/contact\\ud800"')),
      context: context(),
      expect: fail('payload_invalid'),
    },
    {
      name: 'signed payload with 32 nested containers',
      envelope: await signBundle(
        payload({ config: deep(30) as BundlePayload['config'] }),
        [a],
      ),
      context: context(),
      expect: ok(),
    },
    {
      name: 'signed payload with 33 nested containers',
      envelope: await signBundle(
        payload({ config: deep(31) as BundlePayload['config'] }),
        [a],
      ),
      context: context(),
      expect: fail('payload_invalid'),
    },
    {
      name: 'signed payload with __proto__ and numeric keys as plain data',
      envelope: await signBundle(
        payload({
          config: JSON.parse(
            '{"__proto__":{"admin":true},"1":"one"}',
          ) as BundlePayload['config'],
        }),
        [a],
      ),
      context: context(),
      expect: ok(),
    },

    // 6. gate id
    {
      name: 'bundle for another gate',
      envelope: await signBundle(payload({ gateId: otherGateId }), [a]),
      context: context(),
      expect: fail('gate_mismatch'),
    },

    // 7. version
    {
      name: 'same version as the current one (replay)',
      envelope: await signBundle(payload({ version: CURRENT_VERSION }), [a]),
      context: context(),
      expect: fail('version_not_newer'),
    },
    {
      name: 'lower version (downgrade)',
      envelope: await signBundle(payload({ version: 7 }), [a]),
      context: context(),
      expect: fail('version_not_newer'),
    },

    // 8. expiry
    {
      name: 'expired',
      envelope: await signBundle(payload({ expiresAt: NOW - 1 }), [a]),
      context: context(),
      expect: fail('expired'),
    },
    {
      name: 'expires exactly now',
      envelope: await signBundle(payload({ expiresAt: NOW }), [a]),
      context: context(),
      expect: fail('expired'),
    },
    {
      name: 'not yet expired',
      envelope: await signBundle(payload({ expiresAt: NOW + 1 }), [a]),
      context: context(),
      expect: ok(),
    },
    {
      name: 'expired, but expiry is not enabled on this gate',
      envelope: await signBundle(payload({ expiresAt: NOW - 1 }), [a]),
      context: context({ expiryEnabled: false }),
      expect: ok(),
    },

    // order: the first failing check decides
    {
      name: 'foreign gate and old version: gate id is checked first',
      envelope: await signBundle(payload({ gateId: otherGateId, version: 7 }), [
        a,
      ]),
      context: context(),
      expect: fail('gate_mismatch'),
    },
    {
      name: 'unsigned garbage payload: signatures are checked before parsing',
      envelope: withEnvelope(
        (e) => (e['payload'] = toBase64Url(utf8('not json'))),
      ),
      context: context(),
      expect: fail('signature_invalid'),
    },
  ];

  return {
    description:
      'Bundle verification in the binding order of docs/CRYPTO.md §4.3 (steps 1–8). Each case: the envelope as received (append ASCII spaces up to `padTo` bytes when set), the gate state (`pinned` names keys from `signers`), and the expected result — the gate id and version on success, otherwise the rejection code of the first failing check.',
    notice: TEST_ONLY_NOTICE,
    signers: [a, b, c].map((signer) => ({
      name: signer.name,
      alg: signer.alg,
      seed: toBase64Url(signer.secretKey.slice(0, 32)),
      publicKey: toBase64Url(signer.publicKey),
      kid: signer.kid,
    })),
    cases: cases as unknown as Json,
  };
}

// ---------------------------------------------------------------------------------------------
// sealed secrets

async function secretVectors(): Promise<Json> {
  const na = await sodium();
  const gateSecretKey = await testSeed('gate-box-1');
  const gatePublicKey = na.crypto_scalarmult_base(gateSecretKey);
  const gateId = toBase64Url(await testSeed('gate-id-1', 16));
  const otherGateId = toBase64Url(await testSeed('gate-id-2', 16));
  const plaintext = utf8('pat-eu1-TEST-ONLY-0000');

  const seal = async (
    label: string,
    text: Uint8Array,
    secretName: string,
    secretVersion: number,
  ) =>
    sealSecret(
      text,
      gatePublicKey,
      { gateId, secretName, secretVersion },
      {
        ephemeralSecretKey: await testSeed(`ephemeral-${label}`),
        nonce: await testSeed(`nonce-${label}`, 24),
      },
    );

  const sealed = await seal('1', plaintext, 'hubspot-token', 3);
  const empty = await seal('2', new Uint8Array(0), 'empty', 1);
  const flip = (text: string): string => {
    const first = text.charAt(0) === 'A' ? 'B' : 'A';
    return first + text.slice(1);
  };
  const lowOrder = new Uint8Array(32);
  lowOrder[0] = 1;

  type Case = {
    name: string;
    sealed: Json;
    gateId: string;
    secretName: string;
    expect: Expect;
  };
  const asJson = (value: SealedSecret | Record<string, unknown>): Json =>
    value as unknown as Json;
  const fail: Expect = { ok: false, error: 'secret_invalid' };
  const cases: Case[] = [
    {
      name: 'opens',
      sealed: asJson(sealed),
      gateId,
      secretName: 'hubspot-token',
      expect: { ok: true, plaintextHex: hex(plaintext) },
    },
    {
      name: 'empty plaintext opens',
      sealed: asJson(empty),
      gateId,
      secretName: 'empty',
      expect: { ok: true, plaintextHex: '' },
    },
    {
      name: 'another gate id',
      sealed: asJson(sealed),
      gateId: otherGateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'another secret name',
      sealed: asJson(sealed),
      gateId,
      secretName: 'stripe-key',
      expect: fail,
    },
    {
      name: 'secretVersion changed in the sealed object',
      sealed: asJson({ ...sealed, secretVersion: 4 }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'tampered ciphertext',
      sealed: asJson({ ...sealed, ct: flip(sealed.ct) }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'tampered nonce',
      sealed: asJson({ ...sealed, nonce: flip(sealed.nonce) }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'tampered ephemeral key',
      sealed: asJson({ ...sealed, epk: flip(sealed.epk) }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'all-zero ephemeral key',
      sealed: asJson({ ...sealed, epk: toBase64Url(new Uint8Array(32)) }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'low-order ephemeral key',
      sealed: asJson({ ...sealed, epk: toBase64Url(lowOrder) }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'ephemeral key of the wrong length',
      sealed: asJson({ ...sealed, epk: sealed.epk.slice(0, 40) }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'truncated ciphertext (no tag)',
      sealed: asJson({ ...sealed, ct: toBase64Url(new Uint8Array(15)) }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'extra field',
      sealed: asJson({ ...sealed, note: 'x' }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'unknown algorithm',
      sealed: asJson({ ...sealed, alg: 'x25519-xsalsa20poly1305' }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'format version 2',
      sealed: asJson({ ...sealed, v: 2 }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'secretVersion 0',
      sealed: asJson({ ...sealed, secretVersion: 0 }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'secretVersion as string',
      sealed: asJson({ ...sealed, secretVersion: '3' }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'ciphertext with padding',
      sealed: asJson({ ...sealed, ct: `${sealed.ct}=` }),
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
    {
      name: 'not an object',
      sealed: 'sealed',
      gateId,
      secretName: 'hubspot-token',
      expect: fail,
    },
  ];
  return {
    description:
      'Sealed secrets (docs/CRYPTO.md §5): X25519 + keyed BLAKE2b + XChaCha20-Poly1305, AD = "moat:secret:v1|" ‖ gateId ‖ "|" ‖ secretName ‖ "|" ‖ secretVersion. Gate id and name come from the gate, never from the sealed object. Every failure is `secret_invalid`.',
    notice: TEST_ONLY_NOTICE,
    gate: {
      gateId,
      secretKey: toBase64Url(gateSecretKey),
      publicKey: toBase64Url(gatePublicKey),
    },
    cases: cases as unknown as Json,
  };
}

/** File name (relative to conformance/vectors/crypto/) → content. */
export async function buildVectors(): Promise<Record<string, Json>> {
  return {
    'base64url.json': base64urlVectors(),
    'json.json': jsonVectors(),
    'jcs.json': jcsVectors(),
    'kid.json': await kidVectors(),
    'bundle.json': await bundleVectors(),
    'secret.json': await secretVectors(),
  };
}
