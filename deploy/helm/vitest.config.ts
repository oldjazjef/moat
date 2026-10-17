import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '../../node_modules/.vite/deploy/helm',
  test: {
    name: 'helm-chart',
    environment: 'node',
    include: ['**/*.spec.ts'],
    passWithNoTests: false,
  },
});
