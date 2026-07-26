import { describe, it } from 'vitest';
import { corpusAvailable, corpusTestSets, registerCorpusTests } from '../w3cCorpus.js';

describe('W3C corpus round-trip (ms)', () => {
  if (!corpusAvailable()) {
    it('skip — W3C submodule not checked out', () => {});
    return;
  }
  registerCorpusTests('ms', corpusTestSets().filter(f => f.includes('msMeta')));
});
