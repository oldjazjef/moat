import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MoatRejection } from '../errors';
import { normalisePath } from './path';

describe('normalisePath (SEC-42, fuzz)', () => {
  const raw = fc.string({
    unit: fc.constantFrom(...'/a.%2e5fFcC0~\\ ?#:'.split('')),
    maxLength: 24,
  });

  it('either rejects with path_invalid or returns a path that is its own normal form', () => {
    fc.assert(
      fc.property(raw, (input) => {
        let normalised: string;
        try {
          normalised = normalisePath(input);
        } catch (error) {
          expect(error).toBeInstanceOf(MoatRejection);
          expect((error as MoatRejection).code).toBe('path_invalid');
          return;
        }
        expect(normalisePath(normalised)).toBe(normalised);
        expect(normalised).not.toMatch(/%|\\|\/\.\.?(\/|$)|\/\/|[?#\s]/);
      }),
    );
  });
});
