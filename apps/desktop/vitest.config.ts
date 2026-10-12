import { defineConfig } from 'vitest/config';

/**
 * The Electron main process's pure helpers (app:// routing, config, API environment) — plain
 * Node, no Electron: the files under src/main/lib never import `electron`.
 */
export default defineConfig({
  cacheDir: '../../node_modules/.vite/apps/desktop',
  test: {
    name: 'desktop',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: false,
  },
});
