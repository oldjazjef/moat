/** Lines are counted from 1, as the API's issues count them. */
export interface LineRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The lines of a gate's entry under the top-level `gates:` of a moat.yaml (from its name to the
 * line before the next entry or top-level key), or null when the text has none. Read from the
 * text as written, so it works on a file the schema refuses as well.
 */
export function gateLines(text: string, gate: string): LineRange | null {
  const lines = text.split('\n');
  const top = lines.findIndex((line) => /^gates:\s*(#.*)?$/.test(line));
  if (top < 0) return null;
  let from = -1;
  let last = -1;
  let indent = -1;
  for (let i = top + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const own = line.length - line.trimStart().length;
    // A top-level key, or the next entry at the gates' own indent, ends the entry.
    if (own === 0 || (from >= 0 && own <= indent)) break;
    if (from >= 0) {
      last = i;
      continue;
    }
    if (indent < 0) indent = own;
    const name = /^\s*(['"]?)([a-z][a-z0-9-]*)\1:/.exec(line)?.[2];
    if (own === indent && name === gate) {
      from = i;
      last = i;
    }
  }
  return from < 0 ? null : { from: from + 1, to: last + 1 };
}

/** The character offset where line `line` (from 1) starts. */
export function lineOffset(text: string, line: number): number {
  let offset = 0;
  for (let i = 1; i < line; i += 1) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset;
}
