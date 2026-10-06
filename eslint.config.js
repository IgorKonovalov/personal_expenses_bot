// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// Layer boundaries (project-context.md): the bot framework lives only in src/bot/ and the boot
// entry; the domain is pure. Each block lists every restriction for its glob because a later
// flat-config block replaces, not merges, a rule's options.
const botFramework = {
  name: 'grammy',
  message: 'grammY is imported only in src/bot/ and src/index.ts.',
};
const botLayer = { group: ['**/bot/**'], message: 'Only src/index.ts wires the bot layer.' };
const moneySyntax = [
  {
    selector: "MemberExpression[property.name='toFixed']",
    message: 'Money is integer minor units; use formatMoney in src/domain/money.ts.',
  },
  {
    selector: "MemberExpression[object.name='Number'][property.name='parseFloat']",
    message: 'Money is integer minor units; use src/domain/money.ts.',
  },
];
// ADR-0012: message text is sent only through src/bot/render/html.ts, which escapes it.
const htmlSeam =
  'Send and edit message text with replyHtml / editHtml from src/bot/render/html.ts.';

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'coverage/',
      'dist/',
      'data/',
      '.claude/',
      'scripts/**/*.mjs',
      'tools/',
      'docs/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // Money is integer minor units (ADR-0004): no float parsing or float formatting.
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is integer minor units; use src/domain/money.ts.' },
      ],
      'no-restricted-syntax': ['error', ...moneySyntax],
    },
  },
  {
    files: ['src/bot/**/*.ts'],
    ignores: ['src/bot/render/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...moneySyntax,
        { selector: "Property[key.name='parse_mode']", message: htmlSeam },
        { selector: "Property[key.value='parse_mode']", message: htmlSeam },
        {
          selector: 'CallExpression[callee.property.name=/^(reply|editMessageText|sendMessage)$/]',
          message: htmlSeam,
        },
      ],
    },
  },
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            botFramework,
            { name: 'better-sqlite3', message: 'The domain is pure: no storage.' },
            { name: 'pino', message: 'The domain is pure: no logging.' },
            { name: 'fs', message: 'The domain is pure: no I/O.' },
            { name: 'node:fs', message: 'The domain is pure: no I/O.' },
            { name: 'fs/promises', message: 'The domain is pure: no I/O.' },
            { name: 'node:fs/promises', message: 'The domain is pure: no I/O.' },
            { name: 'process', message: 'The domain is pure: take values as parameters.' },
            { name: 'node:process', message: 'The domain is pure: take values as parameters.' },
          ],
          patterns: [
            botLayer,
            { group: ['**/db/**', '**/services/**'], message: 'The domain depends on nothing.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'The domain is pure: take values as parameters.' },
        { name: 'parseFloat', message: 'Money is integer minor units; use src/domain/money.ts.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Domain code never reads the wall clock; take `now` as a parameter.',
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Domain code never reads the wall clock; take `now` as a parameter.',
        },
        ...moneySyntax,
      ],
    },
  },
  {
    files: ['src/db/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [botFramework],
          patterns: [
            botLayer,
            { group: ['**/services/**'], message: 'Repositories do not call use-cases.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/services/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [botFramework], patterns: [botLayer] }],
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
