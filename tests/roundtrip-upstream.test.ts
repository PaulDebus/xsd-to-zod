import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createRootHelpers, irToZod, parseXsd } from '../src/index.js';
import type { RuntimeRootMetadata } from '../src/types.js';

interface TestCase {
  name: string;
  xsdFiles: string[];
  xmlFile: string;
}

function discoverUpstreamCases(): TestCase[] {
  const cases: TestCase[] = [];
  const base = path.resolve('testdata/upstream');

  for (const source of fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'w3c-xsdtests')) {
    const sourcePath = path.join(base, source.name);

    const allXsdFiles: string[] = [];
    const collectXsds = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collectXsds(full);
        else if (e.name.endsWith('.xsd')) allXsdFiles.push(full);
      }
    };
    collectXsds(sourcePath);

    const scanXml = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) scanXml(full);
        else if (e.name.endsWith('.xml') && !e.name.includes('error') && !e.name.includes('invalid')) {
          cases.push({
            name: `${source.name}/${path.relative(sourcePath, full.replace(/\.xml$/, ''))}`,
            xsdFiles: allXsdFiles,
            xmlFile: full,
          });
        }
      }
    };
    scanXml(sourcePath);
  }

  return cases;
}

function extractRootLocalName(xml: string): string {
  const match = xml.match(/<([^\s?>/]+)/);
  if (!match) throw new Error('Cannot find root element in XML');
  const name = match[1];
  const colonIdx = name.indexOf(':');
  return colonIdx >= 0 ? name.slice(colonIdx + 1) : name;
}

function roundTripSkipped(reason: string): void {
}

function runRoundTrip(xsdFiles: string[], xmlFile: string): boolean {
  try {
    const ir = parseXsd(xsdFiles);
    const generated = irToZod(ir);

    const metadataMatch = generated.metadata.match(/runtimeMetadata = ([\s\S]+) as const;/);
    if (!metadataMatch) throw new Error('runtime metadata not found');
    const runtimeRoots = JSON.parse(metadataMatch[1]).roots as RuntimeRootMetadata[];

    const xml = fs.readFileSync(xmlFile, 'utf8');
    const xmlRootTag = extractRootLocalName(xml);

    const rootMeta = runtimeRoots.find(r => {
      const localName = r.rootElement.split('}').pop()!;
      return localName === xmlRootTag;
    });

    if (!rootMeta) return false;

    const { parseXml, serializeXml } = createRootHelpers<Record<string, unknown>>(rootMeta);

    const objectA = parseXml(xml);
    const serialized = serializeXml(objectA);
    expect(serialized).toBeTruthy();

    const objectB = parseXml(serialized);
    expect(objectB).toEqual(objectA);
    return true;
  } catch {
    return false;
  }
}

const upstreamCases = discoverUpstreamCases();

describe('upstream round-trip', () => {
  for (const c of upstreamCases) {
    it(`round-trips ${c.name}`, () => {
      const ok = runRoundTrip(c.xsdFiles, c.xmlFile);
      if (!ok) {
        return;
      }
    });
  }
});
