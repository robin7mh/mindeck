import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@': resolve(__dirname, 'src')
}

/**
 * Unit tests: `tests/unit/main` runs in Node (Electron main/preload, mocked
 * `electron`), `tests/unit/renderer` in jsdom (React). Coverage spans every
 * application source file and must stay at 100 % — `npm run test:coverage`
 * fails below that and writes the report to coverage/index.html.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    // Before each test: spies are restored, every vi.fn() loses its calls and
    // the implementations a test gave it (vitest 4's restoreMocks alone only
    // restores vi.spyOn spies).
    restoreMocks: true,
    mockReset: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          environment: 'node',
          include: ['tests/unit/main/**/*.test.ts'],
          setupFiles: ['tests/unit/main/setup.ts']
        }
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/unit/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/unit/renderer/setup.ts']
        }
      }
    ],
    coverage: {
      provider: 'v8',
      // Files no test imports count too: everything `include` matches.
      include: ['electron/**/*.ts', 'src/**/*.{ts,tsx}'],
      // Type-only modules compile to nothing (0/0 lines) and would show as an
      // empty row. tests/unit/renderer/base.test.tsx asserts they export nothing
      // at runtime — the moment one gains real code, that test fails.
      exclude: [
        '**/*.d.ts',
        'src/shared/types/{agents,context,entity,files,project,settings,system}.ts',
        'src/types/index.ts',
        'electron/main/services/ai/tools/types.ts'
      ],
      reporter: ['text-summary', 'text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // Write the report even when a test fails, so coverage/index.html is always there.
      reportOnFailure: true,
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 }
    }
  }
})
