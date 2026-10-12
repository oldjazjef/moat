// @vitest-environment node
// Reads the message files and source from disk and walks the router config; no DOM involved.
import type { Route, Routes } from '@angular/router';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRoutes } from '../../app.routes';
import {
  allHelpKeys,
  HELP_FAQ,
  HELP_SECTION_IDS,
  HELP_SECTIONS,
} from './help-content';

const APP_DIR = fileURLToPath(new URL('../..', import.meta.url));
const I18N_DIR = fileURLToPath(
  new URL('../../../../public/i18n', import.meta.url),
);

function flatten(
  node: unknown,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  if (typeof node === 'string') out.set(prefix, node);
  else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  }
  return out;
}

const messages = (locale: string) =>
  flatten(JSON.parse(readFileSync(join(I18N_DIR, `${locale}.json`), 'utf8')));

/** The routes below a route: inline children or the lazily loaded feature routes. */
async function childrenOf(route: Route): Promise<Routes> {
  if (route.children) return route.children;
  if (!route.loadChildren) return [];
  const loaded = (await route.loadChildren()) as Routes | { default: Routes };
  return Array.isArray(loaded) ? loaded : loaded.default;
}

/** Whether a URL path (no query/fragment) reaches a page — redirects and `**` do not count. */
async function routeExists(
  routes: Routes,
  segments: string[],
): Promise<boolean> {
  for (const route of routes) {
    if (route.path === '**' || route.redirectTo !== undefined) continue;
    const parts = (route.path ?? '').split('/').filter(Boolean);
    if (parts.length > segments.length) continue;
    if (
      !parts.every((part, i) => part.startsWith(':') || part === segments[i])
    ) {
      continue;
    }
    const rest = segments.slice(parts.length);
    if (rest.length === 0 && (route.component || route.loadComponent)) {
      return true;
    }
    if (await routeExists(await childrenOf(route), rest)) return true;
  }
  return false;
}

const exists = (path: string) =>
  routeExists(appRoutes, path.split('/').filter(Boolean));

describe('help content (FR-70–FR-74)', () => {
  it('lists every section once, in the order of HELP_SECTION_IDS, each with steps', () => {
    expect(HELP_SECTIONS.map((section) => section.id)).toEqual([
      ...HELP_SECTION_IDS,
    ]);
    for (const section of HELP_SECTIONS) {
      expect(section.steps.length).toBeGreaterThan(0);
      expect(new Set(section.steps.map((item) => item.id)).size).toBe(
        section.steps.length,
      );
      expect(new Set(section.tips.map((item) => item.id)).size).toBe(
        section.tips.length,
      );
    }
    expect(new Set(HELP_FAQ).size).toBe(HELP_FAQ.length);
  });

  it('the route checker knows real routes from made-up ones', async () => {
    expect(await exists('/app/gates')).toBe(true);
    expect(await exists('/app/help')).toBe(true);
    expect(await exists('/app/nowhere')).toBe(false);
    expect(await exists('/app/gates/nowhere')).toBe(false);
    // A redirect is not a page of its own.
    expect(await exists('/')).toBe(false);
  });

  it('every "Öffnen" link targets an existing route', async () => {
    const missing: string[] = [];
    for (const section of HELP_SECTIONS) {
      for (const link of section.links) {
        if (!(await exists(link.path))) {
          missing.push(`${section.id}: ${link.path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('has no help text that nothing shows (the message files hold exactly the guide)', () => {
    const used = new Set(allHelpKeys());
    // Keys written literally in templates/code (page chrome).
    const literal = /'(help\.[a-zA-Z.]+)'/g;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return /\.(html|ts)$/.test(name) && !name.endsWith('.spec.ts')
          ? [path]
          : [];
      });
    for (const file of walk(APP_DIR)) {
      for (const [, key] of readFileSync(file, 'utf8').matchAll(literal)) {
        if (key) used.add(key);
      }
    }
    const orphans = [...messages('de-CH').keys()].filter(
      (key) => key.startsWith('help.') && !used.has(key),
    );
    expect(orphans).toEqual([]);
  });

  /**
   * The guide names buttons and tabs in quotes — «…» in German, “…” in English. Each quoted label
   * must be a text the app really shows (in the same file, outside `help.*`; `{{x}}` matches
   * anything), so renaming a button without updating the help fails here.
   */
  for (const [locale, quote] of [
    ['de-CH', /«([^»]+)»/g],
    ['en', /“([^”]+)”/g],
  ] as const) {
    it(`${locale}: every quoted UI label in the help exists in the app`, () => {
      const all = messages(locale);
      const ui = [...all]
        .filter(([key]) => !key.startsWith('help.'))
        .map(([, text]) => text);
      const pattern = (text: string) =>
        new RegExp(
          `^${text
            .split(/\{\{[^}]*\}\}/)
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('.+')}$`,
        );
      const patterns = ui.map(pattern);
      const unknown = [...all]
        .filter(([key]) => key.startsWith('help.'))
        .flatMap(([key, text]) =>
          [...text.matchAll(quote)].map(
            (match) => [key, match[1] ?? ''] as const,
          ),
        )
        .filter(([, label]) => !patterns.some((p) => p.test(label)))
        .map(([key, label]) => `${key}: ${label}`);
      expect(unknown).toEqual([]);
    });
  }
});
