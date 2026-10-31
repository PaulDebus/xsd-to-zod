import { defineConfig } from 'vitest/config';

// Nightly full-corpus run (#108 Phase 4): only the corpus slice files.
export default defineConfig({
  test: {
    include: ['tests/corpus/**/*.test.ts'],
    // The corpus is heavy and runs on main/weekly, not the 5s dev default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // A direct `vitest run --config vitest.corpus.config.ts` bypasses the
    // `pretest:corpus` npm hook, so run the submodule guard here as well.
    globalSetup: ['./scripts/require-w3c-corpus.mjs'],
  }
});
