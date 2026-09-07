import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import n from 'eslint-plugin-n';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat config for the SiteOps backend.
 *
 * Type-aware rules are on via `projectService`, which resolves the nearest
 * tsconfig automatically. `any` is an error rather than a warning so CI blocks
 * it: the strict compiler settings are pointless if a single `any` can switch
 * them off for a whole call chain.
 */
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '*.config.js',
      /*
       * The Cloudflare Worker is a separate deployment with a separate runtime.
       * It targets workerd, not Node: no `node:` built-ins, different globals,
       * and its own toolchain and lockfile under `cloudflare/`. Linting it with
       * this project's type-aware config would resolve it against a tsconfig
       * that does not include it, which fails on every file rather than finding
       * anything.
       */
      'cloudflare/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.mts', '*.config.mjs', 'eslint.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { n },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // Catches importing a package that is not declared in package.json — the
      // most common way a service that runs locally fails in production.
      'n/no-extraneous-import': 'error',
      'n/no-process-exit': 'error',
      'n/no-sync': ['error', { allowAtRootLevel: true }],

      // Nothing may read raw configuration. Every value goes through the
      // validated env module so a misconfigured process fails at startup.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Import the validated `env` object instead of reading process.env directly.',
        },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-param-reassign': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
    },
  },
  {
    // These sit upstream of the validated object: the env module is where raw
    // configuration is read, operator scripts are their own entry points, and
    // the test-runner config supplies the environment `env.ts` then validates.
    files: ['src/config/env.ts', 'scripts/**/*.ts', 'vitest.config.mts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-console': 'off',

      /*
       * An HTTP response body is untyped by nature — supertest types it `any`
       * because only the test knows what the route returns. Casting every
       * assertion through an interface would bury what is being asserted under
       * type ceremony, and the assertion *is* the check that the shape is
       * right. Production code keeps every one of these rules on.
       */
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
