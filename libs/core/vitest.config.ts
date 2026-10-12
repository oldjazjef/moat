import { defineConfig } from 'vitest/config';

/**
 * Vitest for the pure core: plain Node, no DOM, no framework. The conformance spec reads the
 * shared vectors in conformance/ — the same files the PHP gate runs against.
 */
export default defineConfig({
  cacheDir: '../../node_modules/.vite/libs/core',
  test: {
    name: 'core',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: false,
  },
});
