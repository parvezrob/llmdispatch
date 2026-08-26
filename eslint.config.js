import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

/**
 * Globals the maintenance scripts rely on. Listed by hand so the config needs no
 * extra dependency; the scripts use nothing beyond Node built-ins.
 *
 * @type {Record<string, 'readonly'>}
 */
const nodeGlobals = {
  Buffer: 'readonly',
  URL: 'readonly',
  console: 'readonly',
  process: 'readonly',
  fetch: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
}

export default tseslint.config(
  {
    // Generated output, recorded snapshots, and anything a fixture installed for itself.
    ignores: [
      'dist/',
      'coverage/',
      'api/',
      'test/consumers/**/node_modules/',
      'examples/*/node_modules/',
      'examples/next/.next/',
      '**/*.tgz',
      '.changeset/',
      // Copied byte for byte out of the spec's code fences by
      // `scripts/check-spec-surface.mjs`. Every other file under `test/types/` is written
      // by hand and linted like any other.
      'test/types/spec-surface*.d.ts',
    ],
  },
  js.configs.recommended,

  // Library and test sources: the full type-aware rule set.
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.test.json', './test/types/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },

  // Tests may assert on values the type system cannot narrow.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  // The negative compile fixtures contain deliberate type errors, so the expressions built
  // on them have no type the rules can trust. Only that family is turned off: an actual
  // `any` written into a fixture would defeat the fixture, so `no-explicit-any` stays on.
  {
    files: ['test/types/negative/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Maintenance scripts and this config: plain JavaScript, no type information.
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.strict, tseslint.configs.stylistic],
    languageOptions: {
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },

  // The consumer fixture templates. They import the package by its published name, which
  // only resolves inside a copy of them with the tarball installed, so they are linted
  // without type information. Not loosely, though: an `any` here would hide the very
  // thing they exist to prove. They come under the type-aware rules if they ever become
  // resolvable from here.
  {
    files: ['test/consumers/**/*.{mts,cts,mjs,cjs}'],
    extends: [tseslint.configs.strict, tseslint.configs.stylistic],
    languageOptions: {
      globals: { ...nodeGlobals, module: 'readonly', require: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // Reaching the package through `require` is the point of the CommonJS fixtures.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // The Next.js example. Its TypeScript belongs to that project's own tsconfig, not to any
  // program this config loads, so the type-aware rules the block above claims for `**/*.ts`
  // are switched off here and the files are linted for syntax. An `any` written into an
  // example would still be a defect, so that rule stays on.
  {
    files: ['examples/next/**/*.ts', 'examples/next/**/*.tsx'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: nodeGlobals,
      parserOptions: { project: false, projectService: false },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // Formatting is the formatter's job; keep this entry last.
  prettier,
)
