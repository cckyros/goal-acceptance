import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@cckyros/goal-acceptance-core': resolve(import.meta.dirname, 'packages/goal-acceptance-core/src/index.ts'),
    },
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/goal-acceptance/tests/**',
    ],
  },
})
