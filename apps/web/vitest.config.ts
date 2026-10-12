import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import angular from '@analogjs/vite-plugin-angular';
import { defineConfig } from 'vitest/config';

const WORKSPACE_ROOT = resolve(__dirname, '../..');

/**
 * Pinned so date formatting in specs does not depend on the machine: a spec written on a laptop
 * in UTC+2 and run on a UTC CI runner otherwise disagrees by a day around midnight. Mirrored into
 * `test.env` so the worker threads inherit it.
 */
const TEST_TIMEZONE = 'UTC';
process.env.TZ = TEST_TIMEZONE;

/** Mirrors the `@moat/*` aliases from tsconfig.base.json into Vite's resolver. */
function tsconfigPathAliases(): Record<string, string> {
  const tsconfig = JSON.parse(
    readFileSync(resolve(WORKSPACE_ROOT, 'tsconfig.base.json'), 'utf8'),
  ) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  return Object.fromEntries(
    Object.entries(tsconfig.compilerOptions?.paths ?? {}).map(
      ([alias, [target]]) => [alias, resolve(WORKSPACE_ROOT, target)],
    ),
  );
}

/**
 * Vitest for the Angular app, through `@analogjs/vite-plugin-angular` rather than
 * `@angular/build:unit-test` — the same choice as lazy-koins
 * (the builder's generated test-bed module never ran a spec there). Standalone + zoneless, so
 * there is no zone.js to configure.
 */
export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/web',
  plugins: [angular({ tsconfig: './tsconfig.spec.json' })],
  test: {
    name: 'web',
    globals: true,
    environment: 'jsdom',
    env: { TZ: TEST_TIMEZONE },
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    passWithNoTests: false,
    // Each file in its own realm: shared realms leak `vi.mock` registrations between files.
    isolate: true,
    pool: 'threads',
  },
  resolve: { alias: tsconfigPathAliases() },
  define: { ngDevMode: 'true' },
});
