import baseConfig from '../../eslint.config.mjs';

/**
 * libs/core is PURE (CLAUDE.md, Layout): schema, bundles, crypto and policy as functions of their
 * inputs. These fences make the rule mechanical instead of a review comment: no framework, no
 * database, no network, no file system, no clock. Randomness comes only from libsodium's CSPRNG
 * (CLAUDE.md, Security rules 11), never Math.random.
 */
const FRAMEWORKS = {
  group: [
    '@angular/*',
    '@nestjs/*',
    '@prisma/*',
    'prisma',
    '**/generated/prisma/**',
    'rxjs',
    'rxjs/*',
  ],
  message:
    'libs/core is pure TypeScript: no Angular, Nest or Prisma. Hand data in from the caller instead.',
};

const IO = {
  group: [
    'node:*',
    'fs',
    'fs/*',
    'path',
    'http',
    'https',
    'net',
    'child_process',
    'axios',
    'undici',
  ],
  message:
    'libs/core does no I/O — no file system, no network. The caller reads files and fetches bundles, then hands the bytes in.',
};

const APPS = {
  group: ['**/apps/**', '@moat/ui', '@moat/ui/*'],
  message: 'libs/core must not depend on an app or on UI code.',
};

export default [
  ...baseConfig,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        // `crypto` is a path, not a pattern: a pattern would also match core's own ./crypto/.
        {
          paths: [{ name: 'crypto', message: IO.message }],
          patterns: [FRAMEWORKS, IO, APPS],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'No network inside the core: the caller fetches.',
        },
        {
          name: 'XMLHttpRequest',
          message: 'No network inside the core: the caller fetches.',
        },
        {
          name: 'WebSocket',
          message: 'No network inside the core: the caller fetches.',
        },
        {
          name: 'process',
          message: 'No environment inside the core: pass settings in.',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'No clock inside the core: the caller passes the time in.',
        },
        {
          object: 'Math',
          property: 'random',
          message:
            'Randomness only from libsodium (randombytes_buf), never Math.random.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'No clock inside the core: `new Date()` without an argument reads the current time.',
        },
      ],
    },
  },
  {
    // Specs read the shared conformance vectors from disk, and the vector generator writes them.
    // Production code may not touch Node.
    files: ['**/*.spec.ts', 'vitest.config.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [FRAMEWORKS, APPS] },
      ],
    },
  },
];
