import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * `pnpm test:integration`: the persistence adapters against real databases (CLAUDE.md, Testing).
 * SQLite always (node:sqlite, a temporary file); PostgreSQL when `MOAT_TEST_POSTGRES_URL` names
 * one, or when the PostgreSQL server binaries are on this machine (a throwaway cluster).
 */
export default defineConfig({
  ...base,
  root: __dirname,
  test: {
    ...base.test,
    name: 'api-integration',
    include: ['src/**/*.integration.spec.ts'],
    exclude: [],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
