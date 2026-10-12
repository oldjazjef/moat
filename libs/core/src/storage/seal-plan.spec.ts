import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../encoding/base64url';
import {
  isSecretValue,
  MAX_SECRET_BYTES,
  planSeal,
  SealPlanError,
} from './seal-plan';
import type { StoragePort } from './storage-port';

const RECIPE = readFileSync(
  resolve(__dirname, '../../../../recipes/hubspot-newsletter.moat.yaml'),
  'utf8',
);
const GATE = JSON.stringify({
  moat: 'gate',
  v: 1,
  gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
  boxKey: toBase64Url(new Uint8Array(32).fill(7)),
});

const folder = (files: Record<string, string>): StoragePort => ({
  read: (path) => files[path] ?? null,
  list: () => [],
});

const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    if (error instanceof SealPlanError) return error.code;
    throw error;
  }
  return 'none';
};

describe('planSeal', () => {
  it('names the gate by fingerprint, the upstreams that send the secret, and version 1', async () => {
    const plan = await planSeal(
      folder({ 'moat.yaml': RECIPE, 'gates/site.json': GATE }),
      'site',
      'hubspot-token',
    );
    expect(plan).toMatchObject({
      gate: 'site',
      gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
      name: 'hubspot-token',
      currentVersion: null,
      nextVersion: 1,
      usedBy: [{ upstream: 'hubspot', origin: 'https://api.hubapi.com' }],
    });
    expect(plan.boxKeyFingerprint).toMatch(/^MOAT-[A-Z2-7]{4}(-[A-Z2-7]{4})+/);
    expect(plan.boxPublicKey).toHaveLength(32);
  });

  it('seals a new version over the current one, and still rotates a secret moat.yaml no longer uses', async () => {
    const files = {
      'moat.yaml': RECIPE,
      'gates/site.json': GATE,
      'secrets/site/hubspot-token.json': '{"secretVersion":3}',
      'secrets/site/old-key.json': '{"secretVersion":1}',
    };
    expect(
      await planSeal(folder(files), 'site', 'hubspot-token'),
    ).toMatchObject({ currentVersion: 3, nextVersion: 4 });
    expect(await planSeal(folder(files), 'site', 'old-key')).toMatchObject({
      currentVersion: 1,
      nextVersion: 2,
      usedBy: [],
    });
  });

  it('refuses an unknown gate or secret, bad names and a config it cannot read', async () => {
    const files = { 'moat.yaml': RECIPE, 'gates/site.json': GATE };
    expect(
      await code(() => planSeal(folder(files), 'shop', 'hubspot-token')),
    ).toBe('gate_unknown');
    expect(
      await code(() => planSeal(folder(files), '../site', 'hubspot-token')),
    ).toBe('gate_unknown');
    expect(await code(() => planSeal(folder(files), 'site', 'other'))).toBe(
      'secret_unknown',
    );
    expect(await code(() => planSeal(folder(files), 'site', '../x'))).toBe(
      'secret_unknown',
    );
    expect(
      await code(() =>
        planSeal(
          folder({ ...files, 'gates/site.json': '{"moat":"gate"}' }),
          'site',
          'hubspot-token',
        ),
      ),
    ).toBe('gate_unknown');
    expect(
      await code(() =>
        planSeal(folder({ 'gates/site.json': GATE }), 'site', 'hubspot-token'),
      ),
    ).toBe('config_missing');
    expect(
      await code(() =>
        planSeal(
          folder({ ...files, 'moat.yaml': 'version: 1\nroutes: [\n' }),
          'site',
          'hubspot-token',
        ),
      ),
    ).toBe('config_invalid');
  });

  it('refuses a sealed file it cannot read instead of starting again at version 1', async () => {
    for (const sealed of [
      '{',
      '{"secretVersion":0}',
      '{"secretVersion":"3"}',
      '[]',
    ]) {
      expect(
        await code(() =>
          planSeal(
            folder({
              'moat.yaml': RECIPE,
              'gates/site.json': GATE,
              'secrets/site/hubspot-token.json': sealed,
            }),
            'site',
            'hubspot-token',
          ),
        ),
      ).toBe('secret_unreadable');
    }
  });
});

describe('isSecretValue', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  it('takes a token and refuses empty, too long, line breaks, NUL and broken UTF-8', () => {
    expect(isSecretValue(bytes('pat-TEST-ONLY-1234'))).toBe(true);
    expect(isSecretValue(bytes(''))).toBe(false);
    expect(isSecretValue(bytes('x'.repeat(MAX_SECRET_BYTES + 1)))).toBe(false);
    expect(isSecretValue(bytes('a\nb'))).toBe(false);
    expect(isSecretValue(bytes('a\rb'))).toBe(false);
    expect(isSecretValue(bytes('a\0b'))).toBe(false);
    expect(isSecretValue(new Uint8Array([0xff, 0xfe]))).toBe(false);
  });

  it('checks UTF-8 on the bytes exactly as a strict decoder does', () => {
    const strict = (value: Uint8Array) => {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(value);
        return true;
      } catch {
        return false;
      }
    };
    fc.assert(
      fc.property(
        fc
          .uint8Array({ minLength: 1, maxLength: 12 })
          .map((value) =>
            value.map((byte) =>
              byte === 0 || byte === 0x0a || byte === 0x0d ? 0x41 : byte,
            ),
          ),
        (value) => isSecretValue(value) === strict(value),
      ),
      { numRuns: 20000 },
    );
    for (const value of [
      [0xc0, 0x80],
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf0, 0x80, 0x80, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x82],
    ])
      expect(isSecretValue(new Uint8Array(value))).toBe(false);
    expect(isSecretValue(bytes('Grüezi €𝄞'))).toBe(true);
  });
});
