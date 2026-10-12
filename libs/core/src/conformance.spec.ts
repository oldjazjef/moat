import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildVectors } from '../scripts/build-vectors';
import { canonicalJson } from './canonical/jcs';
import { fingerprint, keyId, type KeyAlgorithm } from './crypto/kid';
import { fromBase64Url } from './encoding/base64url';
import { utf8 } from './encoding/utf8';
import { MoatRejection } from './errors';
import { verifyBundle, type PinnedSigner } from './bundle/bundle';
import { parseStrictJson, type JsonValue } from './json/strict-json';
import { openSecret } from './secrets/seal';

/**
 * The shared vectors in conformance/vectors/crypto/ (docs/CRYPTO.md §11) — the same files the PHP
 * gate runs against. Two jobs:
 *
 * 1. The committed files must equal what scripts/build-vectors.ts produces. `pnpm vectors`
 *    (MOAT_WRITE_VECTORS=1) rewrites them; otherwise a stale file fails here.
 * 2. The core must pass every case as read from disk — so a hand edit to a file is tested too.
 */
const VECTOR_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../conformance/vectors/crypto',
);
const WRITE = process.env['MOAT_WRITE_VECTORS'] === '1';

function serialise(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function load<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(VECTOR_DIR, file), 'utf8')) as T;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(text: string): Uint8Array {
  return new Uint8Array(
    (text.match(/../g) ?? []).map((pair) => parseInt(pair, 16)),
  );
}

type Expect =
  { ok: true; [key: string]: unknown } | { ok: false; error: string };

async function outcome(
  run: () => unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof MoatRejection) return { ok: false, error: error.code };
    throw error;
  }
}

// Built (and with MOAT_WRITE_VECTORS=1 written) before the cases below are collected from disk.
const built = await buildVectors();
if (WRITE) {
  mkdirSync(VECTOR_DIR, { recursive: true });
  for (const [file, content] of Object.entries(built)) {
    writeFileSync(path.join(VECTOR_DIR, file), serialise(content));
  }
}

describe('conformance vectors', () => {
  it.each(Object.keys(built))(
    '%s matches scripts/build-vectors.ts (`pnpm vectors` rewrites it)',
    (file) => {
      const content = built[file] ?? null;
      expect(readFileSync(path.join(VECTOR_DIR, file), 'utf8')).toBe(
        serialise(content),
      );
    },
  );

  describe('base64url.json', () => {
    const { cases } = load<{
      cases: { name: string; input: string; expect: Expect }[];
    }>('base64url.json');
    it.each(cases)('$name', async ({ input, expect: expected }) => {
      const result = await outcome(() => hex(fromBase64Url(input)));
      if (expected.ok)
        expect(result).toEqual({ ok: true, value: expected['hex'] });
      else expect(result).toEqual(expected);
    });
  });

  describe('json.json', () => {
    const { cases } = load<{
      cases: {
        name: string;
        input?: string;
        inputHex?: string;
        expect: Expect;
      }[];
    }>('json.json');
    it.each(cases)('$name', async ({ input, inputHex, expect: expected }) => {
      const bytes =
        inputHex === undefined ? utf8(input ?? '') : fromHex(inputHex);
      const result = await outcome(() => parseStrictJson(bytes));
      expect(result.ok ? { ok: true } : result).toEqual(expected);
    });
  });

  describe('jcs.json', () => {
    const { cases } = load<{
      cases: { name: string; input: JsonValue; canonical: string }[];
    }>('jcs.json');
    it.each(cases)('$name', ({ input, canonical }) => {
      expect(canonicalJson(input)).toBe(canonical);
    });
  });

  describe('kid.json', () => {
    const { cases } = load<{
      cases: {
        name: string;
        alg: KeyAlgorithm;
        publicKey: string;
        kid: string;
        fingerprint: string;
      }[];
    }>('kid.json');
    it.each(cases)('$name', async (item) => {
      const publicKey = fromBase64Url(item.publicKey);
      expect(await keyId(item.alg, publicKey)).toBe(item.kid);
      expect(await fingerprint(item.alg, publicKey)).toBe(item.fingerprint);
    });
  });

  describe('bundle.json', () => {
    const vectors = load<{
      signers: {
        name: string;
        alg: 'ed25519';
        publicKey: string;
        kid: string;
      }[];
      cases: {
        name: string;
        envelope: string;
        padTo?: number;
        context: {
          gateId: string;
          pinned: string[];
          threshold: number;
          currentVersion: number;
          now: number;
          expiryEnabled: boolean;
        };
        expect: Expect;
      }[];
    }>('bundle.json');
    const signers = new Map(
      vectors.signers.map((signer) => [signer.name, signer]),
    );

    it.each(vectors.cases)(
      '$name',
      async ({ envelope, padTo, context, expect: expected }) => {
        let bytes = utf8(envelope);
        if (padTo !== undefined) {
          const padded = new Uint8Array(padTo).fill(0x20);
          padded.set(bytes);
          bytes = padded;
        }
        const pinned: PinnedSigner[] = context.pinned.map((name) => {
          const signer = signers.get(name);
          if (signer === undefined) throw new Error(`unknown signer ${name}`);
          return {
            kid: signer.kid,
            alg: signer.alg,
            publicKey: fromBase64Url(signer.publicKey),
          };
        });
        const result = await outcome(() =>
          verifyBundle(bytes, { ...context, signers: pinned }),
        );
        if (expected.ok) {
          expect(result.ok).toBe(true);
          const { payload } = (
            result as {
              value: { payload: { gateId: string; version: number } };
            }
          ).value;
          expect({
            ok: true,
            gateId: payload.gateId,
            version: payload.version,
          }).toEqual(expected);
        } else {
          expect(result).toEqual(expected);
        }
      },
    );
  });

  describe('secret.json', () => {
    const vectors = load<{
      gate: { secretKey: string };
      cases: {
        name: string;
        sealed: unknown;
        gateId: string;
        secretName: string;
        expect: Expect;
      }[];
    }>('secret.json');
    const gateSecretKey = fromBase64Url(vectors.gate.secretKey);

    it.each(vectors.cases)(
      '$name',
      async ({ sealed, gateId, secretName, expect: expected }) => {
        const result = await outcome(async () =>
          hex(await openSecret(sealed, gateSecretKey, gateId, secretName)),
        );
        if (expected.ok)
          expect(result).toEqual({ ok: true, value: expected['plaintextHex'] });
        else expect(result).toEqual(expected);
      },
    );
  });
});
