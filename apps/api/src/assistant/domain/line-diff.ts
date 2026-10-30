/** One line of a proposal's preview: kept (' '), removed ('-') or added ('+'). */
export interface DiffLine {
  readonly kind: ' ' | '-' | '+';
  readonly text: string;
}

/** A gap of unchanged lines the preview leaves out. */
export interface DiffGap {
  readonly kind: '…';
  readonly lines: number;
}

/** Bounds keep the LCS table small: moat.yaml is at most a few hundred lines. */
const MAX_LINES = 2000;

/**
 * The lines that change from `before` to `after` (longest common subsequence), with `context`
 * unchanged lines around each change and the rest folded into gaps. Texts longer than MAX_LINES
 * are shown as one removal and one addition: still exact, only less compact.
 */
export function lineDiff(
  before: string,
  after: string,
  context = 3,
): readonly (DiffLine | DiffGap)[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const lines =
    a.length > MAX_LINES || b.length > MAX_LINES ? plain(a, b) : lcs(a, b);
  return fold(lines, context);
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function plain(a: readonly string[], b: readonly string[]): DiffLine[] {
  return [
    ...a.map((text) => ({ kind: '-' as const, text })),
    ...b.map((text) => ({ kind: '+' as const, text })),
  ];
}

function lcs(a: readonly string[], b: readonly string[]): DiffLine[] {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0,
            );
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i] ?? '';
    const right = b[j] ?? '';
    if (left === right) {
      out.push({ kind: ' ', text: left });
      i++;
      j++;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      out.push({ kind: '-', text: left });
      i++;
    } else {
      out.push({ kind: '+', text: right });
      j++;
    }
  }
  for (; i < a.length; i++) out.push({ kind: '-', text: a[i] ?? '' });
  for (; j < b.length; j++) out.push({ kind: '+', text: b[j] ?? '' });
  return out;
}

function fold(
  lines: readonly DiffLine[],
  context: number,
): (DiffLine | DiffGap)[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === ' ') return;
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(lines.length - 1, index + context);
      k++
    )
      keep[k] = true;
  });
  const out: (DiffLine | DiffGap)[] = [];
  let gap = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (gap > 0) out.push({ kind: '…', lines: gap });
      gap = 0;
      out.push(line);
    } else gap++;
  });
  if (gap > 0) out.push({ kind: '…', lines: gap });
  return out;
}
