import eslint from '@eslint/js'
import prettierConfig from 'eslint-config-prettier'
import babelParser from '@babel/eslint-parser'

export default [
    eslint.configs.recommended,
    prettierConfig,
    {
        ignores: ['dist/', 'node_modules/', 'coverage/', '.roo/'],
    },
    {
        files: ['src/**/*.ts', 'tests/**/*.ts'],
        languageOptions: {
            parser: babelParser,
            parserOptions: {
                requireConfigFile: false,
                babelOptions: {
                    presets: ['@babel/preset-typescript', ['@babel/preset-env', { targets: { node: 'current' } }]],
                },
            },
            globals: {
                // Browser APIs used by the library
                crypto: 'readonly',
                localStorage: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
                btoa: 'readonly',
                atob: 'readonly',
                fetch: 'readonly',
                Blob: 'readonly',
                indexedDB: 'readonly',
                setTimeout: 'readonly',
                console: 'readonly',
            },
        },
        rules: {
            // Disable rules that conflict with TypeScript — tsc --noEmit covers these
            'no-undef': 'off',
            'no-unused-vars': 'off',
            // Enable useful rules
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-constant-condition': 'warn',
            'no-console': 'off',
        },
    },
]
