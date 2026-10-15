import path from 'node:path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Vitest for the NestJS app (as lazy-koins). The SWC plugin is not optional: esbuild does not
 * emit `emitDecoratorMetadata`, and without it Nest cannot resolve constructor parameters by type.
 */
export default defineConfig({
  cacheDir: '../../node_modules/.vite/apps/api',
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  resolve: {
    alias: {
      '@moat/core': path.resolve(__dirname, '../../libs/core/src/index.ts'),
    },
  },
  test: {
    name: 'api',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    // Against real databases: `pnpm test:integration` (vitest.integration.config.ts).
    exclude: ['src/**/*.integration.spec.ts'],
    passWithNoTests: false,
  },
});
