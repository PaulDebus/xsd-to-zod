import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

// Dev-loop "quick" level (#108): everything except the heavy upstream corpus
// round-trips (UBL, expanded W3C selection). Coverage settings stay inherited
// from the base config so there is one source of truth. CI runs the full
// suite via `npm test`.
export default mergeConfig(base, defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'tests/roundtrip-upstream.test.ts',
      'tests/roundtrip-w3c-extended.test.ts',
      'tests/roundtrip-w3c-negative.test.ts'
    ]
  }
}));
