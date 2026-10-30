import { describe, expect, it } from 'vitest';
import { lineDiff } from './line-diff';

describe('lineDiff', () => {
  it('shows an added line with its context and folds the rest', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n') + '\n';
    const after =
      ['a', 'b', 'c', 'd', 'X', 'e', 'f', 'g', 'h'].join('\n') + '\n';
    expect(lineDiff(before, after, 1)).toEqual([
      { kind: '…', lines: 3 },
      { kind: ' ', text: 'd' },
      { kind: '+', text: 'X' },
      { kind: ' ', text: 'e' },
      { kind: '…', lines: 3 },
    ]);
  });

  it('shows a changed line as removal and addition', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { kind: ' ', text: 'a' },
      { kind: '-', text: 'b' },
      { kind: '+', text: 'B' },
      { kind: ' ', text: 'c' },
    ]);
  });

  it('is empty-safe and shows no change as one gap', () => {
    expect(lineDiff('', 'a\n')).toEqual([{ kind: '+', text: 'a' }]);
    expect(lineDiff('a\nb\n', 'a\nb\n')).toEqual([{ kind: '…', lines: 2 }]);
  });
});
