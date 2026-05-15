// Minimal ESLint flat config for the secondbrain repo.
// Intentionally permissive: catches obvious mistakes without forcing a
// stylistic rewrite. Tighten rules in follow-up PRs.

import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'dist-pkg/**',
      '.sixth/**',
      '.claude/**',
      'scripts/**',
      'src/main/empire/**',
      '**/*.py',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLDivElement: 'readonly',
        Event: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      // TS already covers unused vars; turn off the JS rule to avoid double-reports.
      'no-unused-vars': 'off',
      // Permissive defaults — focus on real errors, not style.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-useless-escape': 'off',
      'no-control-regex': 'off',
      'no-prototype-builtins': 'off',
      'no-undef': 'off', // TS handles this
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',
    },
    settings: {
      react: { version: '18' },
    },
  },
];
