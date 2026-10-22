const js = require('@eslint/js');

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'panel/web/dist/**',
            'logs/**',
            'auth_info_baileys/**',
            'contacts_db.json',
            'contacts_db.json.example',
            'settings_db.json',
            'settings_db.json.example',
            '*.tmp'
        ]
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                __dirname: 'readonly',
                __filename: 'readonly',
                console: 'readonly',
                process: 'readonly',
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                setInterval: 'readonly',
                setTimeout: 'readonly',
                clearInterval: 'readonly',
                clearTimeout: 'readonly',
                setImmediate: 'readonly',
                clearImmediate: 'readonly',
                Buffer: 'readonly',
                fetch: 'readonly',
                AbortSignal: 'readonly',
                URLSearchParams: 'readonly',
                URL: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    }
];
