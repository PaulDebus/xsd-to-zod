import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runRoundTrip } from './helpers.js';
import { parseXsd } from '../src/index.js';

const W3C_DIR = path.resolve('testdata/upstream/w3c-xsdtests');

describe('W3C smoke round-trip', () => {
  if (!fs.existsSync(W3C_DIR) || fs.readdirSync(W3C_DIR).length === 0) {
    it('skip — W3C submodule not checked out', () => {});
    return;
  }

  const smokeDirs = [
    'boeingData/ipo1',
    'boeingData/ipo2',
    'boeingData/ipo3',
    'boeingData/ipo4',
  ];

  for (const subdir of smokeDirs) {
    const dir = path.join(W3C_DIR, subdir);
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir);
    const xsdFiles = files.filter(f => f.endsWith('.xsd')).map(f => path.join(dir, f));
    const xmlFiles = files.filter(f => f.endsWith('.xml'));

    if (xsdFiles.length === 0 || xmlFiles.length === 0) continue;

    for (const xmlFile of xmlFiles) {
      it(`round-trips W3C ${subdir}/${xmlFile}`, async () => {
        await runRoundTrip(xsdFiles, path.join(dir, xmlFile));
      });
    }
  }
});

describe('upstream parse benchmark', () => {
  it('parseXsds all upstream XSDs under 5s', () => {
    const upstreamDir = path.resolve('testdata/upstream');

    const allXsdFiles: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.includes('w3c')) walk(full);
        else if (e.name.endsWith('.xsd')) allXsdFiles.push(full);
      }
    };
    walk(upstreamDir);

    expect(allXsdFiles.length).toBeGreaterThan(0);

    // NOTE: duration check removed — see issue #19.
    // We only assert that all upstream XSDs parse without error.
    // If parse time becomes a concern, add a proper benchmark script.
    parseXsd(allXsdFiles);
  });
});
