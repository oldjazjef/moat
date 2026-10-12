import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    // Build output, PHP dependencies and private/ (never read by any tool, see CLAUDE.md).
    ignores: [
      '**/dist',
      'private/**',
      'gates/php/vendor/**',
      '**/out-tsc',
      '**/vitest.config.*.timestamp*',
      '**/.pnpm-store',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            // The core is pure: it may depend on nothing in the workspace but itself (its own
            // eslint.config.mjs additionally bans framework, I/O and clock access).
            {
              sourceTag: 'scope:core',
              onlyDependOnLibsWithTags: ['scope:core'],
            },
            // The CLI is the trustworthy signing path (SEC-37): libs/core and nothing else.
            {
              sourceTag: 'scope:cli',
              onlyDependOnLibsWithTags: ['scope:core'],
            },
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    rules: {
      // A leading underscore is this repo's existing, consistent way of saying "this parameter is
      // part of a signature I do not control and I am deliberately not using it". It was already
      // written that way in a dozen places — `_query`, `_command` in CQRS handlers, whose
      // `execute(query)` signature is fixed by `@nestjs/cqrs` even when the handler needs nothing
      // from the message — but nothing told eslint, so each one still counted as tracked debt.
      //
      // Warning on them made the signal worse, not better: a warning you are supposed to ignore
      // teaches you to ignore warnings. Genuinely dead variables still warn, and those were
      // deleted rather than renamed.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
