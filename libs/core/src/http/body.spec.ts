import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { utf8 } from '../encoding/utf8';
import { MoatRejection } from '../errors';
import { parseStrictJson, type JsonValue } from '../json/strict-json';
import { validateBody, type BodyFields } from './body';

const SIGNUP: BodyFields = {
  email: { type: 'string', required: true, format: 'email', maxLength: 254 },
  firstName: { type: 'string', maxLength: 50 },
  tags: {
    type: 'array',
    maxItems: 3,
    items: { type: 'string', enum: ['news', 'offers'] },
  },
  address: {
    type: 'object',
    fields: { city: { type: 'string' }, zip: { type: 'integer' } },
  },
};

/** The names a body may carry: the schema's, plus a few it does not know. */
const key = fc.constantFrom(
  'email',
  'firstName',
  'tags',
  'address',
  'city',
  'zip',
  'admin',
  '__proto__',
  'constructor',
);
const value = fc.letrec((tie) => ({
  json: fc.oneof(
    { depthSize: 'small' },
    fc.constantFrom<JsonValue>(
      null,
      true,
      0,
      7,
      '',
      'news',
      'admin',
      'a@example.com',
      'a@example.com\n',
    ),
    fc.array(tie('json'), { maxLength: 4 }),
    fc.dictionary(key, tie('json'), { maxKeys: 5 }),
  ),
})).json;

function keysOf(value: JsonValue, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out);
  else if (value !== null && typeof value === 'object')
    for (const [name, item] of Object.entries(value)) {
      out.add(name);
      keysOf(item, out);
    }
  return out;
}

describe('validateBody (FR-13, fuzz)', () => {
  it('rejects with body_invalid, or forwards only known fields as its own canonical form', () => {
    fc.assert(
      fc.property(fc.dictionary(key, value, { maxKeys: 6 }), (input) => {
        let body: string;
        try {
          body = validateBody(SIGNUP, utf8(JSON.stringify(input)));
        } catch (error) {
          expect(error).toBeInstanceOf(MoatRejection);
          expect((error as MoatRejection).code).toBe('body_invalid');
          return;
        }
        const known = new Set(['email', 'firstName', 'tags', 'address']);
        const nested = new Set(['city', 'zip']);
        for (const name of keysOf(parseStrictJson(utf8(body))))
          expect(known.has(name) || nested.has(name), name).toBe(true);
        // Validating what the gate forwards changes nothing.
        expect(validateBody(SIGNUP, utf8(body))).toBe(body);
      }),
    );
  });
});

describe('validateBody', () => {
  it('a __proto__ key is plain data and removed (DT-17)', () => {
    expect(
      validateBody(
        SIGNUP,
        utf8('{"email":"a@example.com","__proto__":{"admin":true}}'),
      ),
    ).toBe('{"email":"a@example.com"}');
  });

  it('never echoes the rejected value (SEC-34)', () => {
    try {
      validateBody(SIGNUP, utf8('{"email":"planted-secret-value"}'));
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('planted');
    }
  });
});
