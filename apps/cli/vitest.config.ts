import path from 'node:path';
import { defineConfig } from 'vitest/config';

/** The `moat` CLI: commands run against a temporary project folder, never the network. */
export default defineConfig({
  cacheDir: '../../node_modules/.vite/apps/cli',
  resolve: {
    alias: {
      '@moat/core': path.resolve(
        import.meta.dirname,
        '../../libs/core/src/index.ts',
      ),
    },
  },
  test: {
    name: 'cli',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});
