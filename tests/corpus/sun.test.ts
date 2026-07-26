import { describe, it } from 'vitest';
import { corpusAvailable, corpusTestSets, registerCorpusTests } from '../w3cCorpus.js';

describe('W3C corpus round-trip (sun)', () => {
  if (!corpusAvailable()) {
    it('skip — W3C submodule not checked out', () => {});
    return;
  }
  registerCorpusTests('sun', corpusTestSets().filter(f => f.includes('sunMeta')));
});
