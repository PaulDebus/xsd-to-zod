import fs from 'node:fs';
import path from 'node:path';
import iconv from 'iconv-lite';
import { expect } from 'vitest';
import { createRootHelpers, decodeXmlEntities, irToZod, parseXsd } from '../src/index.js';
import type { RuntimeMetadata, RuntimeRootMetadata } from '../src/types.js';

export interface TestCase {
  name: string;
  xsdFiles: string[];
  xmlFile: string;
}

export function readXmlFile(filePath: string): string {
  const raw = fs.readFileSync(filePath);
  const declMatch = raw.toString('ascii', 0, Math.min(raw.length, 200)).match(/<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']+)["']/);
  const encoding = declMatch ? declMatch[1] : 'utf-8';
  let content: string;
  try {
    content = iconv.decode(raw, encoding);
  } catch {
    content = raw.toString('utf-8');
  }
  return declMatch
    ? content.replace(
        /^(<\?xml\s+[^>]*?)(encoding\s*=\s*["'])([^"']+)(["'][^>]*?\?>)/,
        (_, pre, attr, _enc, rest) => `${pre}${attr}UTF-8${rest}`
      )
    : content;
}

export function extractRootLocalName(xml: string): string {
  const match = xml.match(/<([^!?][^\s?>/]*)/);
  if (!match) throw new Error('Cannot find root element in XML');
  const name = match[1];
  const colonIdx = name.indexOf(':');
  const local = colonIdx >= 0 ? name.slice(colonIdx + 1) : name;
  return decodeXmlEntities(local);
}

export function getRuntimeMetadata(xsdFiles: string[]): RuntimeMetadata {
  const ir = parseXsd(xsdFiles);
  const generated = irToZod(ir);

  const metadataMatch = generated.metadata.match(/runtimeMetadata = ([\s\S]+) as const;/);
  if (!metadataMatch) throw new Error('runtime metadata not found in generated output');
  return JSON.parse(metadataMatch[1]) as RuntimeMetadata;
}

export function findRootMetadata(
  metadata: RuntimeMetadata,
  xml: string,
): RuntimeRootMetadata {
  const xmlRootTag = extractRootLocalName(xml);
  const rootMeta = metadata.roots.find(r => {
    const localName = r.rootElement.split('}').pop()!;
    return localName === xmlRootTag;
  });
  if (!rootMeta) {
    expect.fail(`root element <${xmlRootTag}> not found in runtime metadata`);
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

export async function validateXmlAgainstSchemas(xml: string, xsdFiles: string[]): Promise<void> {
  if (xsdFiles.length === 0) return;

  await ensureWasm();

  const { XmlDocument, XsdValidator } = await import('libxml2-wasm');

  const resolvedXsdFiles = xsdFiles.map(f => path.resolve(f));
  const xmlDoc = XmlDocument.fromString(xml);

  const errors: string[] = [];

  try {
    for (const xsdFile of resolvedXsdFiles) {
      if (!fs.existsSync(xsdFile)) {
        errors.push(`XSD file not found: ${xsdFile}`);
        continue;
      }

      const schemaSource = readXmlFile(xsdFile);

      let schemaDoc: ReturnType<typeof XmlDocument.fromString>;
      try {
        schemaDoc = XmlDocument.fromString(schemaSource, { url: xsdFile });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Cannot parse schema ${path.relative(process.cwd(), xsdFile)}: ${msg}`);
        continue;
      }

      let validator: ReturnType<typeof XsdValidator.fromDoc>;
      try {
        validator = XsdValidator.fromDoc(schemaDoc);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Cannot compile schema ${path.relative(process.cwd(), xsdFile)}: ${msg}`);
        schemaDoc.dispose();
        continue;
      }

      try {
        validator.validate(xmlDoc);
        return;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${path.relative(process.cwd(), xsdFile)}: ${msg}`);
      } finally {
        validator.dispose();
        schemaDoc.dispose();
      }
    }

    expect.fail(`Serialized XML is not valid against any XSD:\n${errors.join('\n')}`);
  } finally {
    xmlDoc.dispose();
  }
}

export async function runRoundTrip(xsdFiles: string[], xmlFile: string): Promise<void> {
  const metadata = getRuntimeMetadata(xsdFiles);
  const xml = readXmlFile(xmlFile);
  const rootMeta = findRootMetadata(metadata, xml);

  const { parseXml, serializeXml } = createRootHelpers<Record<string, unknown>>(rootMeta, metadata.types);

  const objectA = parseXml(xml);
  const serialized = serializeXml(objectA);
  expect(serialized).toBeTruthy();

  const objectB = parseXml(serialized);
  expect(objectB).toEqual(objectA);

  await validateXmlAgainstSchemas(serialized, xsdFiles);
}
