import { describe, expect, it, vi } from 'vitest';
import { confirmed, passkeyGatesAfter } from './state-change';

describe('confirmed (changes only after the main process asked)', () => {
  it('applies the change on a yes', async () => {
    const apply = vi.fn();
    expect(await confirmed(() => Promise.resolve(true), apply)).toBe(true);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('changes nothing on a no', async () => {
    const apply = vi.fn();
    expect(await confirmed(() => Promise.resolve(false), apply)).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not apply while the question is still open', async () => {
    const apply = vi.fn();
    let answer: (yes: boolean) => void = () => undefined;
    const pending = confirmed(
      () => new Promise<boolean>((resolve) => (answer = resolve)),
      apply,
    );
    expect(apply).not.toHaveBeenCalled();
    answer(true);
    await pending;
    expect(apply).toHaveBeenCalledOnce();
  });
});

describe('passkeyGatesAfter', () => {
  it('turns a gate on only with a passkey, sorted and without duplicates', () => {
    expect(passkeyGatesAfter(['p/b'], 'p/a', true, true)).toEqual([
      'p/a',
      'p/b',
    ]);
    expect(passkeyGatesAfter(['p/a'], 'p/a', true, true)).toEqual(['p/a']);
    expect(passkeyGatesAfter([], 'p/a', true, false)).toBeNull();
  });

  it('turns a gate off even without a passkey', () => {
    expect(passkeyGatesAfter(['p/a', 'p/b'], 'p/a', false, false)).toEqual([
      'p/b',
    ]);
  });
});
