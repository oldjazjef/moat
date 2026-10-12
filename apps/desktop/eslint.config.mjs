import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  {
    // The helpers are unit-tested in plain Node: they must not pull in Electron.
    files: ['src/main/lib/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'src/main/lib holds the pure, unit-tested helpers. Electron code lives in src/main/*.ts.',
            },
          ],
        },
      ],
    },
  },
];
