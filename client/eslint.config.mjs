import js from '@eslint/js';
import globals from 'globals';
import security from 'eslint-plugin-security';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
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
    plugins: { security, 'no-unsanitized': noUnsanitized },
    rules: {
      // The page calls into the sealed worker and into browser APIs that the
      // DOM lib types as any; the checker reports those on its own.
      '@typescript-eslint/no-explicit-any': 'off',
      // An empty catch is how a lost device or a closed socket is ignored.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Security rules. Everything the client writes into the document goes
      // through textContent or a DOM builder, so an HTML sink is a finding and
      // not a style choice.
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-unsafe-regex': 'error',
      // The plugin spells this rule with a camel case tail.
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-bidi-characters': 'error',
      'security/detect-invisible-characters': 'error',
      'security/detect-child-process': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-buffer-noassert': 'error',
      // A regexp or a computed member with a variable is worth a look, but the
      // client builds both from its own tables and from parsed messages.
      'security/detect-non-literal-regexp': 'error',
      'security/detect-possible-timing-attacks': 'error',
      // object-injection is off: it fires on every computed member, which in
      // this client is a loop counter over a typed array or a lookup in one of
      // the page's own constant tables, and it cannot tell those from a key
      // that came off the wire. The lookups that do read stored or parsed data
      // guard the key with Object.hasOwn at the site.
      'security/detect-object-injection': 'off',
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
