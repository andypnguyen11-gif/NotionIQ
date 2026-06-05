// eslint-config-next bundles eslint-plugin-react 7.x which is not compatible
// with ESLint 10 flat config (getFilename API removed). Per the Next.js 16 docs,
// we use @next/eslint-plugin-next directly for Next-specific rules and pair it
// with typescript-eslint for TS linting — this is the approach recommended for
// setups that have conflicting plugin configurations.
import { defineConfig, globalIgnores } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import nextPlugin from '@next/eslint-plugin-next'

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,jsx,mjs,ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: { ...nextPlugin.configs.recommended.rules },
  },
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'lib/generated/**']),
])
