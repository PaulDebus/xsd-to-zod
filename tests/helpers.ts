import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import { z } from 'zod';
import { irToZod, parseXsd, parseXml, readXmlFile, safeParseXml, serializeXml, xmlRegistry } from '../src/index.js';
import { decodeTagNameCharRefs } from '../src/runtime.js';

export interface TestCase {
  name: string;
  xsdFiles: string[];
  xmlFile: string;
}

export function discoverCuratedCases(): TestCase[] {
  const cases: TestCase[] = [];
  const base = path.resolve('testdata/curated');

  for (const cat of fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'negative')) {
    const catPath = path.join(base, cat.name);
    const files = fs.readdirSync(catPath);
    const allXsdPaths = files.filter(f => f.endsWith('.xsd')).map(f => path.join(catPath, f));

    for (const xmlFile of files.filter(f => f.endsWith('.xml'))) {
      const stem = xmlFile.replace(/\.xml$/, '');
      cases.push({
        name: `${cat.name}/${stem}`,
        xsdFiles: allXsdPaths,
        xmlFile: path.join(catPath, xmlFile),
      });
    }
  }

  return cases;
}

export { readXmlFile };

export const withTempDir = (fn: (dir: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd2zod-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

export const withTempDirAsync = async (fn: (dir: string) => void | Promise<void>): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsd2zod-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// Dynamically import a generated .zod.ts module. Written in a dotdir at the
// package root so the bare `zod` import and the `xsd-to-zod` self-reference
// resolve (self-reference does not work from inside node_modules), and the
// worktree stays clean (the dotdir is gitignored).
export async function importGeneratedSchemas(schemasCode: string): Promise<Record<string, unknown>> {
  const baseDir = path.resolve('.xsd2zod-tests');
  fs.mkdirSync(baseDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(baseDir, 'schema-'));
  try {
    const file = path.join(dir, 'schema.zod.ts');
    fs.writeFileSync(file, schemasCode);
    return await import(pathToFileURL(file).href) as Record<string, unknown>;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const stripProlog = (xml: string): string =>
  xml
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE(?:[^\[\]>]|\[[\s\S]*?\])*>/i, '');

export interface RootInfo {
  local: string;
  namespace: string;
}

// Root element name and namespace, anchored to the actual document root
// (XML declaration, PIs, comments and DOCTYPE are skipped first).
export function extractRootInfo(xml: string): RootInfo {
  const cleaned = decodeTagNameCharRefs(stripProlog(xml));
  const match = cleaned.match(/<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/);
  if (!match) throw new Error('Cannot find root element in XML');
  const [, qname, attrText] = match;
  const colonIdx = qname.indexOf(':');
  const prefix = colonIdx >= 0 ? qname.slice(0, colonIdx) : '';
  const local = colonIdx >= 0 ? qname.slice(colonIdx + 1) : qname;
  const nsDecl = new RegExp(`xmlns${prefix ? `:${prefix}` : ''}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrText);
  return { local, namespace: nsDecl?.[1] ?? nsDecl?.[2] ?? '' };
}

const isZodSchema = (value: unknown): value is z.ZodType =>
  value !== null && typeof value === 'object' && '_zod' in value;

// All exported root schemas of a generated module, with their registered root
// element qnames.
export function findRootSchemas(mod: Record<string, unknown>): { schema: z.ZodType; rootQName: string }[] {
  const roots: { schema: z.ZodType; rootQName: string }[] = [];
  for (const value of Object.values(mod)) {
    if (!isZodSchema(value)) {
      continue;
    }
    const root = xmlRegistry.get(value)?.root;
    if (root) {
      roots.push({ schema: value, rootQName: root });
    }
  }
  return roots;
}

// Pick the generated root schema matching the XML document's root element.
export function findRootSchema(mod: Record<string, unknown>, xml: string): z.ZodType {
  const xmlRoot = extractRootInfo(xml);
  const roots = findRootSchemas(mod);
  const exact = roots.find(r => r.rootQName === `{${xmlRoot.namespace}}${xmlRoot.local}`);
  const byLocal = roots.find(r => r.rootQName.split('}').pop() === xmlRoot.local);
  const found = exact ?? byLocal;
  if (!found) {
    expect.fail(`no generated root schema matches <${xmlRoot.local}> (roots: ${roots.map(r => r.rootQName).join(', ') || 'none'})`);
  }
  return found.schema;
}

const TARGET_NS_RE = /\btargetNamespace\s*=\s*["']([^"']*)["']/;

export async function validateXmlAgainstSchemas(xml: string, xsdFiles: string[]): Promise<void> {
  if (xsdFiles.length === 0) return;

  const { formatIssues, validateXml } = await import('../src/validate.js');

  const { namespace: rootNamespace } = extractRootInfo(xml);

  const candidates: { file: string; targetNamespace: string }[] = [];
  const errors: string[] = [];
  for (const xsdFile of xsdFiles.map(f => path.resolve(f))) {
    if (!fs.existsSync(xsdFile)) {
      errors.push(`XSD file not found: ${xsdFile}`);
      continue;
    }
    candidates.push({ file: xsdFile, targetNamespace: readXmlFile(xsdFile).match(TARGET_NS_RE)?.[1] ?? '' });
  }

  // Only XSDs whose targetNamespace matches the serialized root are relevant;
  // validating against an arbitrary unrelated schema proves nothing (#83).
  const matching = candidates.filter(c => c.targetNamespace === rootNamespace);
  const pool = matching.length > 0 ? matching : candidates;

  for (const { file } of pool) {
    try {
      const result = await validateXml(xml, readXmlFile(file), { url: file });
      if (result.valid) {
        return;
      }
      errors.push(`${path.relative(process.cwd(), file)}: ${formatIssues(result.issues).join('; ')}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${path.relative(process.cwd(), file)}: ${msg}`);
    }
  }

  expect.fail(`Serialized XML is not valid against the root namespace's XSD (${rootNamespace || 'no namespace'}):\n${errors.join('\n')}`);
}

export async function runRoundTrip(xsdFiles: string[], xmlFile: string, expected?: unknown): Promise<void> {
  const { schemas } = irToZod(parseXsd(xsdFiles));
  const xml = readXmlFile(xmlFile);
  const mod = await importGeneratedSchemas(schemas);
  const rootSchema = findRootSchema(mod, xml);

  const objectA = parseXml(rootSchema, xml);
  if (expected !== undefined) {
    expect(objectA).toEqual(expected);
  }

  // parseXml validates by construction; the result-object path must agree.
  const safeResult = safeParseXml(rootSchema, xml);
  if (!safeResult.success) {
    expect.fail(`safeParseXml rejected what parseXml accepted: ${safeResult.error}`);
  }

  const serialized = serializeXml(rootSchema, objectA);
  expect(serialized).toBeTruthy();

  const objectB = parseXml(rootSchema, serialized);
  expect(objectB).toEqual(objectA);

  await validateXmlAgainstSchemas(serialized, xsdFiles);
}
