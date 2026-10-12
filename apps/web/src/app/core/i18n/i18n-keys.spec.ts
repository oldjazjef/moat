// @vitest-environment node
// Reads source and message files from disk; no DOM involved.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allHelpKeys } from '../../features/help/help-content';
import { allTrustKeys } from '../../shared/components/trust-mode-badge/trust-modes';
import {
  AUTH_TYPES,
  CONFIG_ISSUE_CODES,
  EDIT_ERROR_CODES,
} from '../api/project.types';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './locales';
import { SIGN_OUTCOMES } from '../../features/gates/pages/gates-page/gates-page.service';
import { PROJECT_TABS } from '../../features/projects/pages/project-workspace/project-workspace.service';

/**
 * Every i18n key the app references exists in every message file, and every text in the files is
 * used (as lazy-koins, plus the orphan check). A missing key renders as its raw path — invisible
 * in review, obvious to users. Keys are found as quoted dotted literals; keys assembled at runtime
 * are listed below.
 */
const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));
const I18N_DIR = fileURLToPath(
  new URL('../../../../public/i18n', import.meta.url),
);

const DYNAMIC_KEYS = [
  ...allHelpKeys(),
  ...allTrustKeys(),
  ...CONFIG_ISSUE_CODES.map((code) => `config.errors.${code}`),
  ...EDIT_ERROR_CODES.map((code) => `edit.errors.${code}`),
  ...AUTH_TYPES.map((type) => `routes.auth.${type}`),
  ...['none', ...AUTH_TYPES].map(
    (type) => `routes.upstreamForm.authTypes.${type}`,
  ),
  ...['ip', 'route'].map((per) => `routes.rate.${per}`),
  ...PROJECT_TABS.map((tab) => `projects.tabs.${tab}`),
  ...SIGN_OUTCOMES.map((outcome) => `gates.signResult.${outcome}`),
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(html|ts)$/.test(name) && !name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

function referencedKeys(): Set<string> {
  const keys = new Set(DYNAMIC_KEYS);
  const literal = /'([a-z][a-zA-Z]*(?:\.[a-zA-Z]+)+)'/g;
  for (const file of files(APP_DIR)) {
    for (const [, key] of readFileSync(file, 'utf8').matchAll(literal)) {
      if (key && !/\.(ts|html|css|json|js|svg)$/.test(key)) keys.add(key);
    }
  }
  return keys;
}

/** Every `key → text` of a message file, flattened (`a.b.c`). */
function flatten(
  node: unknown,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  if (typeof node === 'string') {
    out.set(prefix, node);
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

/** `{{ name }}` placeholders of a text, sorted. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
    .map((match) => match[1] ?? '')
    .sort();
}

function messagesOf(locale: string): Map<string, string> {
  return flatten(
    JSON.parse(readFileSync(join(I18N_DIR, `${locale}.json`), 'utf8')),
  );
}

describe('i18n message files', () => {
  const keys = [...referencedKeys()];
  const reference = messagesOf(DEFAULT_LOCALE);

  it('finds the keys it is supposed to check', () => {
    expect(keys.length).toBeGreaterThan(100);
  });

  it('has exactly one file per supported locale', () => {
    expect(
      readdirSync(I18N_DIR)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace(/\.json$/, ''))
        .sort(),
    ).toEqual([...SUPPORTED_LOCALES].sort());
  });

  for (const locale of SUPPORTED_LOCALES.filter((l) => l !== DEFAULT_LOCALE)) {
    it(`${locale}.json has the same keys as ${DEFAULT_LOCALE}.json — none missing, none extra`, () => {
      const messages = messagesOf(locale);
      expect([...reference.keys()].filter((key) => !messages.has(key))).toEqual(
        [],
      );
      expect([...messages.keys()].filter((key) => !reference.has(key))).toEqual(
        [],
      );
    });

    it(`${locale}.json keeps every placeholder and translates every text`, () => {
      const messages = messagesOf(locale);
      const wrong = [...reference].filter(
        ([key, text]) =>
          placeholders(messages.get(key) ?? '').join() !==
          placeholders(text).join(),
      );
      expect(wrong.map(([key]) => key)).toEqual([]);
      expect(
        [...messages].filter(([, text]) => text.trim() === '').map(([k]) => k),
      ).toEqual([]);
    });
  }

  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale}.json contains every referenced key`, () => {
      const messages = messagesOf(locale);
      expect(keys.filter((key) => !messages.has(key))).toEqual([]);
    });
  }

  it('has no text that nothing shows', () => {
    const used = new Set(keys);
    expect([...reference.keys()].filter((key) => !used.has(key))).toEqual([]);
  });
});
