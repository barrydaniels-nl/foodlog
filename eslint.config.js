import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.superpowers/**', 'data/**'] },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
