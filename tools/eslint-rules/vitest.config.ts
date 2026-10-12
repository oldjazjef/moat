import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/tools/eslint-rules',
  test: {
    name: 'eslint-rules',
    environment: 'node',
    globals: true,
    include: ['**/*.spec.ts'],
    passWithNoTests: false,
  },
});
