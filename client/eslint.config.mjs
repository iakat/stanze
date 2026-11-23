import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The client is a browser bundle with no framework. The recommended sets are
// the baseline; the few rules below are off because the code predates them and
// they fire on patterns that are deliberate here.
export default tseslint.config(
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      // The page calls into the sealed worker and into browser APIs that the
      // DOM lib types as any; the checker reports those on its own.
      '@typescript-eslint/no-explicit-any': 'off',
      // An empty catch is how a lost device or a closed socket is ignored.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // The two cleaners exist to drop control characters, so the expression
    // that names them is the point and not a mistake.
    files: ['src/files.ts', 'src/sealed.ts'],
    rules: { 'no-control-regex': 'off' },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
