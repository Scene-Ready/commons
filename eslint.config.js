import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['**/*.{ts,tsx,js}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    // oidc/testing is for apps' tests: no production entry point may reach it.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/oidc/testing.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['./testing', './testing.*', '**/oidc/testing', '**/oidc/testing.*'],
              message: 'oidc/testing is test-only.',
            },
          ],
        },
      ],
    },
  },
);
