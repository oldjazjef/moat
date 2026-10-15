// @vitest-environment node
// Reads ANFORDERUNGEN.md and the message files from disk; no DOM involved.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRUST_MODES, trustKeys } from './trust-modes';

const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const message = (locale: string, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      JSON.parse(
        readFileSync(`${ROOT}apps/web/public/i18n/${locale}.json`, 'utf8'),
      ),
    );

/** The §2.9 table row of a mode: [intern, "**de** / _en_", short, if hacked]. */
function row(intern: string): string[] {
  const text = readFileSync(`${ROOT}ANFORDERUNGEN.md`, 'utf8');
  const line = text
    .split('\n')
    .find((candidate) => candidate.startsWith(`| ${intern} `));
  if (line === undefined) throw new Error(`§2.9 has no row ${intern}`);
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

const INTERN = { signed: 'Modus 1', passkey: 'Modus 2' } as const;

describe('trust mode wording (§2.9, SEC-58)', () => {
  for (const mode of TRUST_MODES) {
    it(`${mode}: the label and the sentences are exactly those of §2.9`, () => {
      const [, name, short, ifHacked] = row(INTERN[mode]);
      const [, de, en] = /^\*\*(.+)\*\* \/ _(.+)_$/.exec(name ?? '') ?? [];
      expect(message('de-CH', trustKeys.label(mode))).toBe(de);
      expect(message('en', trustKeys.label(mode))).toBe(en);
      expect(message('de-CH', trustKeys.short(mode))).toBe(short);
      expect(message('de-CH', trustKeys.ifHacked(mode))).toBe(ifHacked);
      expect(message('de-CH', 'trust.ifHackedPrefix')).toBe(
        'Wenn Moat Cloud gehackt wird',
      );
    });
  }
});
