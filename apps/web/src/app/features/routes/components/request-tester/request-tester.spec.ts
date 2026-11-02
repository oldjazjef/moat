import { describe, expect, it } from 'vitest';
import { prettyBody, sampleBody } from './request-tester';

describe('sampleBody', () => {
  it('fills each listed field with a value of its type', () => {
    expect(
      JSON.parse(
        sampleBody({
          email: { type: 'string', format: 'email', required: true },
          plan: { type: 'string', enum: ['free', 'pro'] },
          count: { type: 'integer', minimum: 1 },
          news: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
          address: { type: 'object', fields: { city: { type: 'string' } } },
        }),
      ),
    ).toEqual({
      email: 'test@example.com',
      plan: 'free',
      count: 1,
      news: false,
      tags: [],
      address: { city: '' },
    });
  });

  it('is an empty object without fields', () => {
    expect(sampleBody(undefined)).toBe('{}\n');
  });
});

describe('prettyBody', () => {
  it('indents JSON and leaves anything else as it came', () => {
    expect(prettyBody('{"a":1}', 'application/json', false)).toBe(
      '{\n  "a": 1\n}',
    );
    expect(prettyBody('{"a":1', 'application/json', true)).toBe('{"a":1');
    expect(prettyBody('{"a":', 'application/json', false)).toBe('{"a":');
    expect(prettyBody('<b>hi</b>', 'text/html', false)).toBe('<b>hi</b>');
  });
});
