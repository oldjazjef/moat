import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fingerprint, keyId } from '../crypto/kid';
import { toBase64Url } from '../encoding/base64url';
import { utf8 } from '../encoding/utf8';
import {
  MAX_SETUP_ANSWER_BYTES,
  parseSetupAnswer,
  SETUP_TOKEN,
  SetupAnswerError,
} from './setup-answer';

const BOX = new Uint8Array(32).map((_, index) => index + 1);
const SIGNER = new Uint8Array(32).map((_, index) => 200 - index);

async function answer(
  change: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
    boxKey: toBase64Url(BOX),
    boxKeyFingerprint: await fingerprint('x25519', BOX),
    signers: [
      {
        kid: await keyId('ed25519', SIGNER),
        fingerprint: await fingerprint('ed25519', SIGNER),
      },
    ],
    threshold: 1,
    mode: 1,
    ...change,
  };
}

const bytes = (value: unknown) => utf8(JSON.stringify(value));

async function code(input: Uint8Array): Promise<string> {
  try {
    await parseSetupAnswer(input);
  } catch (error) {
    if (error instanceof SetupAnswerError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('parseSetupAnswer (SEC-28, SEC-32, T-73)', () => {
  it('reads the identity and computes the box key fingerprint itself', async () => {
    const identity = await parseSetupAnswer(bytes(await answer()));
    expect(identity).toEqual({
      gateId: 'AAAAAAAAAAAAAAAAAAAAAA',
      boxKey: toBase64Url(BOX),
      boxKeyFingerprint: await fingerprint('x25519', BOX),
      signers: [
        {
          kid: await keyId('ed25519', SIGNER),
          fingerprint: await fingerprint('ed25519', SIGNER),
        },
      ],
      threshold: 1,
      mode: 1,
    });
    expect(identity.boxKeyFingerprint).toMatch(
      /^MOAT(-[A-Z2-7]{4}){6}-[A-Z2-7]{2}$/,
    );
  });

  it('T-73: refuses a claimed fingerprint that is not the box key’s', async () => {
    const other = await fingerprint('x25519', SIGNER);
    expect(await code(bytes(await answer({ boxKeyFingerprint: other })))).toBe(
      'fingerprint_mismatch',
    );
    // The signer's own fingerprint for the same bytes is another algorithm, another print.
    expect(
      await code(
        bytes(
          await answer({
            boxKeyFingerprint: await fingerprint('ed25519', BOX),
          }),
        ),
      ),
    ).toBe('fingerprint_mismatch');
  });

  it('refuses extra, missing and __proto__ keys', async () => {
    const base = await answer();
    expect(await code(bytes({ ...base, extra: 1 }))).toBe('answer_invalid');
    const { mode: _mode, ...missing } = base;
    expect(await code(bytes(missing))).toBe('answer_invalid');
    const text = JSON.stringify(base).replace('{', '{"__proto__":{"x":1},');
    expect(await code(utf8(text))).toBe('answer_invalid');
    const signerProto = JSON.stringify(base).replace(
      '"kid"',
      '"__proto__":{},"kid"',
    );
    expect(await code(utf8(signerProto))).toBe('answer_invalid');
    const signer = (base['signers'] as Record<string, unknown>[])[0];
    expect(
      await code(bytes({ ...base, signers: [{ ...signer, pk: 'x' }] })),
    ).toBe('answer_invalid');
  });

  it('refuses a box key of the wrong length or encoding', async () => {
    for (const boxKey of [
      toBase64Url(BOX.slice(0, 31)),
      toBase64Url(new Uint8Array(33)),
      `${toBase64Url(BOX)}=`,
      toBase64Url(BOX).replace('A', '+'),
      '',
      32,
      null,
    ])
      expect(await code(bytes(await answer({ boxKey })))).toBe(
        'answer_invalid',
      );
  });

  it('refuses a gate id, signers, threshold or mode out of shape', async () => {
    const signer = (await answer())['signers'] as Record<string, unknown>[];
    const one = signer[0] as Record<string, unknown>;
    for (const change of [
      { gateId: 'short' },
      { gateId: 'A'.repeat(23) },
      { gateId: 'AAAAAAAAAAAAAAAAAAAA/A' },
      { signers: [] },
      { signers: Array.from({ length: 17 }, () => one) },
      { signers: [one, one], threshold: 1 },
      { signers: [{ ...one, kid: 'x' }] },
      { signers: [{ ...one, fingerprint: 'MOAT-abcd' }] },
      { signers: 'x' },
      { threshold: 0 },
      { threshold: 2 },
      { threshold: '1' },
      { mode: 3 },
      { mode: true },
      { boxKeyFingerprint: 'nope' },
    ])
      expect(await code(bytes(await answer(change)))).toBe('answer_invalid');
  });

  it('refuses what is no strict JSON object, and oversized answers', async () => {
    for (const text of ['', '[]', 'null', '{"a":1.5}', '<html>', '{'])
      expect(await code(utf8(text))).toBe('answer_invalid');
    expect(
      await code(new Uint8Array(MAX_SETUP_ANSWER_BYTES + 1).fill(32)),
    ).toBe('answer_invalid');
  });

  it('never throws anything but SetupAnswerError, and never echoes the input', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (input) => {
        try {
          await parseSetupAnswer(input);
        } catch (error) {
          expect(error).toBeInstanceOf(SetupAnswerError);
          expect((error as Error).message).toMatch(
            /^(answer_invalid|fingerprint_mismatch)$/,
          );
        }
      }),
      { numRuns: 200 },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.string(), fc.jsonValue()),
        async (extra) => {
          const base = await answer();
          const merged = { ...base, ...extra };
          const keys = Object.keys(merged);
          fc.pre(keys.length !== Object.keys(base).length);
          expect(await code(bytes(merged))).toBe('answer_invalid');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('knows the token shape: 32 bytes as base64url', () => {
    expect(SETUP_TOKEN.test(toBase64Url(new Uint8Array(32)))).toBe(true);
    expect(SETUP_TOKEN.test(toBase64Url(new Uint8Array(31)))).toBe(false);
    expect(SETUP_TOKEN.test(`${'A'.repeat(42)}+`)).toBe(false);
  });
});
