const js = require('@eslint/js');
const globals = require('globals');

const rules = {
    'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none'}],
    'no-empty': ['error', {allowEmptyCatch: true}],
    'eqeqeq': ['error', 'always'],
    'no-var': 'error',
    'prefer-const': 'error'
};

module.exports = [
    {
        ignores: ['node_modules/**', 'out/**']
    },
    js.configs.recommended,
    {
        files: ['*.js', 'core/**/*.js', 'test/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {...globals.node}
        },
        rules
    },
    {
        files: ['preload/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {require: 'readonly'}
        },
        rules
    },
    {
        files: ['view/**/*.js', 'control/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'script',
            globals: {...globals.browser}
        },
        rules
    }
];
