import { defineConfig } from 'vitest/config';

// Nightly full-corpus run (#108 Phase 4): only the corpus slice files.
export default defineConfig({
  test: {
    include: ['tests/corpus/**/*.test.ts'],
    // A direct `vitest run --config vitest.corpus.config.ts` bypasses the
    // `pretest:corpus` npm hook, so run the submodule guard here as well.
    globalSetup: ['./scripts/require-w3c-corpus.mjs'],
  }
});
