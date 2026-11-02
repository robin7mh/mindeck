// Lint for the renderer (src/): the rules of hooks — the one class of bug
// TypeScript and the tests do not catch reliably. Deliberate exceptions to
// exhaustive-deps carry an inline `eslint-disable-next-line … -- reason`.
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default defineConfig([
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Control characters in a regex are mostly a typo; where they are the point, say so inline.
      'no-control-regex': 'error'
    }
  }
])
