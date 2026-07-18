import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import { createRootHelpers, irToZod, parseXsd, readXmlFile, rootSchemaExportNames } from '../src/index.js';
import { decodeTagNameCharRefs } from '../src/runtime.js';
import type { RuntimeMetadata, RuntimeRootMetadata } from '../src/types.js';

export interface TestCase {
  name: string;
  xsdFiles: string[];
  xmlFile: string;
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

export function extractRuntimeMetadata(metadataCode: string): RuntimeMetadata {
  const match = metadataCode.match(/runtimeMetadata = ([\s\S]+) as const;/);
  if (!match) throw new Error('runtime metadata not found in generated output');
  return JSON.parse(match[1]) as RuntimeMetadata;
}

export interface GeneratedFromXsds {
  schemasCode: string;
  metadata: RuntimeMetadata;
}

export function generateFromXsds(xsdFiles: string[]): GeneratedFromXsds {
  const generated = irToZod(parseXsd(xsdFiles));
  return { schemasCode: generated.schemas, metadata: extractRuntimeMetadata(generated.metadata) };
}

export function getRuntimeMetadata(xsdFiles: string[]): RuntimeMetadata {
  return generateFromXsds(xsdFiles).metadata;
}

// Dynamically import a generated .zod.ts module. Written under node_modules so
// the bare `zod` import resolves and the worktree stays clean.
export async function importGeneratedSchemas(schemasCode: string): Promise<Record<string, unknown>> {
  const baseDir = path.resolve('node_modules/.xsd2zod-tests');
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

export function findRootMetadata(
  metadata: RuntimeMetadata,
  xml: string,
): RuntimeRootMetadata {
  const xmlRoot = extractRootInfo(xml);
  const rootMeta = metadata.roots.find(r => {
    const localName = r.rootElement.split('}').pop()!;
    return localName === xmlRoot.local;
  });
  if (!rootMeta) {
    expect.fail(`root element <${xmlRoot.local}> not found in runtime metadata`);
  }
  return rootMeta;
}

let wasmReady: Promise<void> | null = null;

async function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const { xmlRegisterFsInputProviders } = await import('libxml2-wasm/lib/nodejs.mjs');
      xmlRegisterFsInputProviders();
    })();
  }
  return wasmReady;
}

const TARGET_NS_RE = /\btargetNamespace\s*=\s*["']([^"']*)["']/;

export async function validateXmlAgainstSchemas(xml: string, xsdFiles: string[]): Promise<void> {
  if (xsdFiles.length === 0) return;

  await ensureWasm();

  const { XmlDocument, XsdValidator } = await import('libxml2-wasm');

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

  const xmlDoc = XmlDocument.fromString(xml);

  try {
    for (const { file } of pool) {
      const schemaSource = readXmlFile(file);

      let schemaDoc: ReturnType<typeof XmlDocument.fromString>;
      try {
        schemaDoc = XmlDocument.fromString(schemaSource, { url: file });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Cannot parse schema ${path.relative(process.cwd(), file)}: ${msg}`);
        continue;
      }

      let validator: ReturnType<typeof XsdValidator.fromDoc>;
      try {
        validator = XsdValidator.fromDoc(schemaDoc);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Cannot compile schema ${path.relative(process.cwd(), file)}: ${msg}`);
        schemaDoc.dispose();
        continue;
      }

      try {
        validator.validate(xmlDoc);
        return;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${path.relative(process.cwd(), file)}: ${msg}`);
      } finally {
        validator.dispose();
        schemaDoc.dispose();
      }
    }

    expect.fail(`Serialized XML is not valid against the root namespace's XSD (${rootNamespace || 'no namespace'}):\n${errors.join('\n')}`);
  } finally {
    xmlDoc.dispose();
  }
}

interface ZodSchemaLike {
  safeParse: (value: unknown) => { success: boolean; error?: { message: string } };
}

export async function runRoundTrip(xsdFiles: string[], xmlFile: string, expected?: unknown): Promise<void> {
  const { schemasCode, metadata } = generateFromXsds(xsdFiles);
  const xml = readXmlFile(xmlFile);
  const rootMeta = findRootMetadata(metadata, xml);

  const { parseXml, serializeXml } = createRootHelpers<Record<string, unknown>>(rootMeta, metadata.types);

  const objectA = parseXml(xml);
  if (expected !== undefined) {
    expect(objectA).toEqual(expected);
  }

  // The parser's own output must satisfy the generated zod schema (#65, #71).
  const mod = await importGeneratedSchemas(schemasCode);
  const exportName = rootSchemaExportNames(metadata.roots.map(r => r.rootElement)).get(rootMeta.rootElement)!;
  const rootSchema = mod[exportName] as ZodSchemaLike | undefined;
  if (!rootSchema || typeof rootSchema.safeParse !== 'function') {
    expect.fail(`generated schema export '${exportName}' not found`);
  }
  const zodResult = rootSchema.safeParse(objectA);
  if (!zodResult.success) {
    expect.fail(`parseXml output rejected by generated zod schema ${exportName}: ${zodResult.error?.message ?? 'unknown error'}`);
  }

  const serialized = serializeXml(objectA);
  expect(serialized).toBeTruthy();

  const objectB = parseXml(serialized);
  expect(objectB).toEqual(objectA);

  await validateXmlAgainstSchemas(serialized, xsdFiles);
}
