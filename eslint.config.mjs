import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['lib/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', URL: 'readonly',
        // Node 20 ships these as globals, and engines requires node >= 20.
        fetch: 'readonly', URLSearchParams: 'readonly',
        structuredClone: 'readonly', require: 'readonly', module: 'readonly' },
    },
    rules: {
      // Existing API boundaries deliberately accept Garmin's undocumented DTOs.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // Authentication inputs intentionally reject ASCII control characters.
      'no-control-regex': 'off',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
