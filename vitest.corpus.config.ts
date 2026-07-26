import { defineConfig } from 'vitest/config';

// Nightly full-corpus run (#108 Phase 4): only the corpus slice files.
export default defineConfig({
  test: {
    include: ['tests/corpus/**/*.test.ts'],
  }
});
