import { describe, expect, it } from 'vitest';
import { canonicalJson } from './jcs';

describe('canonicalJson', () => {
  it('refuses numbers outside the signed subset instead of writing them', () => {
    expect(() => canonicalJson(0.5)).toThrow(RangeError);
    expect(() => canonicalJson(-1)).toThrow(RangeError);
    expect(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      RangeError,
    );
    expect(() => canonicalJson(Number.NaN)).toThrow(RangeError);
  });

  it('writes -0 as 0', () => {
    expect(canonicalJson(-0)).toBe('0');
  });
});
