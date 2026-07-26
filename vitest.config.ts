import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      // Full-corpus suite is nightly-only (npm run test:corpus) — too slow for PRs.
      'tests/corpus/**'
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 87,
        functions: 89,
        branches: 78,
        statements: 86
      }
    }
  }
});
