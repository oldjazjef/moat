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
import { normalisePath } from './http/path';
import { isAllowedContentType } from './http/content-type';
import { checkOrigin, preflight } from './http/cors';
import {
  clientKey,
  hitLimits,
  type Limit,
  type Window,
} from './http/rate-limit';
import { validateCompiledConfig } from './config/compiled';
import { checkPolicy, parsePolicy } from './policy/policy';
import { openKeyFile } from './crypto/keyfile';

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
  '../../../conformance/vectors',
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
  for (const [file, content] of Object.entries(built)) {
    mkdirSync(path.dirname(path.join(VECTOR_DIR, file)), { recursive: true });
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

  describe('crypto/base64url.json', () => {
    const { cases } = load<{
      cases: { name: string; input: string; expect: Expect }[];
    }>('crypto/base64url.json');
    it.each(cases)('$name', async ({ input, expect: expected }) => {
      const result = await outcome(() => hex(fromBase64Url(input)));
      if (expected.ok)
        expect(result).toEqual({ ok: true, value: expected['hex'] });
      else expect(result).toEqual(expected);
    });
  });

  describe('crypto/json.json', () => {
    const { cases } = load<{
      cases: {
        name: string;
        input?: string;
        inputHex?: string;
        expect: Expect;
      }[];
    }>('crypto/json.json');
    it.each(cases)('$name', async ({ input, inputHex, expect: expected }) => {
      const bytes =
        inputHex === undefined ? utf8(input ?? '') : fromHex(inputHex);
      const result = await outcome(() => parseStrictJson(bytes));
      expect(result.ok ? { ok: true } : result).toEqual(expected);
    });
  });

  describe('crypto/jcs.json', () => {
    const { cases } = load<{
      cases: { name: string; input: JsonValue; canonical: string }[];
    }>('crypto/jcs.json');
    it.each(cases)('$name', ({ input, canonical }) => {
      expect(canonicalJson(input)).toBe(canonical);
    });
  });

  describe('crypto/kid.json', () => {
    const { cases } = load<{
      cases: {
        name: string;
        alg: KeyAlgorithm;
        publicKey: string;
        kid: string;
        fingerprint: string;
      }[];
    }>('crypto/kid.json');
    it.each(cases)('$name', async (item) => {
      const publicKey = fromBase64Url(item.publicKey);
      expect(await keyId(item.alg, publicKey)).toBe(item.kid);
      expect(await fingerprint(item.alg, publicKey)).toBe(item.fingerprint);
    });
  });

  describe('crypto/bundle.json', () => {
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
    }>('crypto/bundle.json');
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

  describe('crypto/secret.json', () => {
    const vectors = load<{
      gate: { secretKey: string };
      cases: {
        name: string;
        sealed: unknown;
        gateId: string;
        secretName: string;
        expect: Expect;
      }[];
    }>('crypto/secret.json');
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

  describe('http/path.json', () => {
    const { cases } = load<{
      cases: { name: string; input: string; expect: Expect }[];
    }>('http/path.json');
    it.each(cases)('$name', async ({ input, expect: expected }) => {
      const result = await outcome(() => normalisePath(input));
      expect(result.ok ? { ok: true, path: result.value } : result).toEqual(
        expected,
      );
    });
  });

  describe('http/content-type.json', () => {
    const { cases } = load<{
      cases: {
        name: string;
        header: string;
        allowed: string[];
        expect: { ok: boolean };
      }[];
    }>('http/content-type.json');
    it.each(cases)('$name', ({ header, allowed, expect: expected }) => {
      expect(isAllowedContentType(header, allowed)).toBe(expected.ok);
    });
  });

  describe('http/cors.json', () => {
    type Route = { method: 'GET'; origins: string[] };
    const { origin, preflight: flights } = load<{
      origin: {
        name: string;
        route: Route;
        origin: string | null;
        expect: Expect;
      }[];
      preflight: {
        name: string;
        routes: Route[];
        origin: string;
        requestMethod: string;
        requestHeaders: string | null;
        expect: Expect;
      }[];
    }>('http/cors.json');
    it.each(origin)('origin: $name', async (vector) => {
      const result = await outcome(() =>
        checkOrigin(vector.route, vector.origin),
      );
      expect(
        result.ok ? { ok: true, allowOrigin: result.value } : result,
      ).toEqual(vector.expect);
    });
    it.each(flights)('preflight: $name', async (vector) => {
      const result = await outcome(() =>
        preflight(
          vector.routes,
          vector.origin,
          vector.requestMethod,
          vector.requestHeaders,
        ),
      );
      expect(
        result.ok ? { ok: true, ...(result.value as object) } : result,
      ).toEqual(vector.expect);
    });
  });

  describe('http/rate-limit.json', () => {
    const { sequences, clients } = load<{
      sequences: {
        name: string;
        limits: Limit[];
        times: number[];
        expect: { allowed: boolean; retryAfter: number }[];
      }[];
      clients: { name: string; address: string; expect: string | null }[];
    }>('http/rate-limit.json');
    it.each(sequences)('sequence: $name', ({ limits, times, expect: want }) => {
      let windows: (Window | null)[] = limits.map(() => null);
      const got = times.map((now) => {
        const result = hitLimits(windows, limits, now);
        if (!result.allowed)
          return { allowed: false, retryAfter: result.retryAfter };
        windows = result.windows;
        return { allowed: true, retryAfter: 0 };
      });
      expect(got).toEqual(want);
    });
    it.each(clients)('client: $name', ({ address, expect: want }) => {
      expect(clientKey(address)).toBe(want);
    });
  });

  describe('config/config.json', () => {
    const { cases } = load<{
      cases: {
        name: string;
        config: JsonValue;
        secrets: string[];
        expect: Expect;
      }[];
    }>('config/config.json');
    it.each(cases)('$name', async ({ config, secrets, expect: expected }) => {
      const result = await outcome(() =>
        validateCompiledConfig(config, secrets),
      );
      expect(result.ok ? { ok: true } : result).toEqual(expected);
    });
  });

  describe('config/policy.json', () => {
    const { cases } = load<{
      cases: {
        name: string;
        config: JsonValue;
        policy: JsonValue;
        expect: Expect;
      }[];
    }>('config/policy.json');
    it.each(cases)('$name', async ({ config, policy, expect: expected }) => {
      const result = await outcome(() =>
        checkPolicy(
          validateCompiledConfig(config, ['hubspot-token']),
          parsePolicy(policy),
        ),
      );
      expect(result.ok ? { ok: true } : result).toEqual(expected);
    });
  });

  describe('crypto/keyfile.json', () => {
    const { cases } = load<{
      cases: {
        name: string;
        file: unknown;
        passphrase: string;
        expect: Expect;
      }[];
    }>('crypto/keyfile.json');
    it.each(cases)('$name', async ({ file, passphrase, expect: expected }) => {
      const result = await outcome(async () => {
        const signer = await openKeyFile(file, passphrase);
        return {
          kid: signer.kid,
          pk: Buffer.from(signer.publicKey).toString('base64url'),
        };
      });
      expect(
        result.ok ? { ok: true, ...(result.value as object) } : result,
      ).toEqual(expected);
    });
  });
});
