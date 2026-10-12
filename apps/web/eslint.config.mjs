import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

export default [
  ...nx.configs['flat/angular'],
  ...nx.configs['flat/angular-template'],
  ...baseConfig,
  {
    files: ['**/*.ts'],
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'mt',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'mt',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    ignores: ['src/index.html'],
    rules: {
      '@nx/workspace-no-hardcoded-design-values': 'error',
      '@nx/workspace-no-hardcoded-text': 'error',
    },
  },
];
