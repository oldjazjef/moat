import { describe, expect, it } from 'vitest';
import { previousKeyAfter } from './key-rotation';

const A = 'A'.repeat(43);
const B = 'B'.repeat(43);
const C = 'C'.repeat(43);

describe('previousKeyAfter (SEC-08)', () => {
  it('remembers the key a new one replaces', () => {
    expect(previousKeyAfter(A, null, B)).toBe(A);
  });

  it('starts no rotation for the first key or the same key again', () => {
    expect(previousKeyAfter(null, null, A)).toBeNull();
    expect(previousKeyAfter(A, null, A)).toBeNull();
    expect(previousKeyAfter(B, A, B)).toBe(A);
  });

  it('ends the rotation when the old key comes back', () => {
    expect(previousKeyAfter(B, A, A)).toBeNull();
  });

  it('keeps the oldest key when a rotation starts in the middle of another', () => {
    expect(previousKeyAfter(B, A, C)).toBe(A);
  });
});
