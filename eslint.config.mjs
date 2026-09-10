// @ts-check
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';

/**
 * Flat config.
 *
 * `package.json` has always declared a `lint` script, but there was no ESLint
 * configuration file in the repository, so `npm run lint` failed before it
 * checked anything. This is that missing file.
 *
 * It is composed from the packages already in devDependencies — no new
 * dependency is introduced — and deliberately stays type-unaware: type errors
 * are `npm run typecheck`'s job, and running the full type-aware rule set over
 * 25k lines would make linting slower than compiling for little extra signal.
 */
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'tools/**',
      'prisma/migrations/**',
      'eslint.config.mjs',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,

      // TypeScript already reports unused values and undefined identifiers
      // with better precision; the base rules duplicate that and misfire on
      // type-only positions.
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  prettierConfig,
];
