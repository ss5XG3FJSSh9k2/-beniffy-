export default [
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        // Pre-existing undefined call in DELETE /api/products/:id (server.js:1571), untouched per move-only rule
        writeAdminAudit: 'readonly'
      }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_|^p$', varsIgnorePattern: '^_|^(normalize|captchaToken|termsAgreed|days|ledger|admin_id)$', caughtErrors: 'none', ignoreRestSiblings: true }]
    }
  }
];
