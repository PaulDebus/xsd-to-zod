import path from 'node:path';
import XMLParser from '@nodable/flexible-xml-parser';
import { readXmlFile } from '../src/index.js';
import { splitQName } from '../src/qname.js';
import { createOutputBuilder } from '../src/runtime.js';

// Driver for the W3C XML Schema Test Suite (#108). Parses the `.testSet`
// metadata files (and the top-level `suite.xml` index) to discover test
// groups automatically instead of hardcoding data directories.
//
// `.testSet` layout (namespace http://www.w3.org/XML/2004/xml-schema-test-suite/):
//   testGroup → schemaTest (schemaDocument xlink:href, expected validity)
//             → instanceTest (instanceDocument xlink:href, expected validity)
//             → documentationReference xlink:href (links into the XSD spec)
// All hrefs are relative to the metadata file's directory. Microsoft ships the
// same format as `msMeta/*_w3c.xml`; suite.xml uses a `ts:` prefix — all
// matching here is namespace-insensitive.

const parser = new XMLParser({
  skip: { attributes: false },
  attributes: { prefix: '@_' },
  OutputBuilder: createOutputBuilder()
});

type AnyNode = Record<string, unknown>;

const asArray = <T>(value: T | T[] | undefined): T[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

const localName = (tag: string): string => splitQName(tag).local;

// The document's root element node, skipping the `?xml` declaration key.
const rootOf = (parsed: AnyNode): AnyNode => {
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith('?') && value && typeof value === 'object') return value as AnyNode;
  }
  throw new Error('no root element found');
};

const childrenOf = (node: AnyNode, name: string): AnyNode[] => {
  const found: AnyNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || localName(key) !== name) continue;
    for (const entry of asArray(value as AnyNode | AnyNode[])) {
      if (entry && typeof entry === 'object') found.push(entry as AnyNode);
    }
  }
  return found;
};

const href = (node: AnyNode): string | undefined => {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') && localName(key.slice(2)) === 'href') return String(value);
  }
  return undefined;
};

// A test node is expected to carry exactly one <expected validity="...">
// child; require it to be present and unambiguously "valid".
const expectedValid = (testNode: AnyNode): boolean => {
  const expected = childrenOf(testNode, 'expected');
  return expected.length > 0 && expected.every(e => e['@_validity'] === 'valid');
};

// Spec anchor from a documentationReference href, e.g.
// http://www.w3.org/TR/2004/REC-xmlschema-1-20041028/#Complex_Type_Definitions
// → xmlschema-1#Complex_Type_Definitions. Non-spec hrefs return undefined.
const specAnchor = (ref: string): string | undefined => {
  const match = ref.match(/xmlschema-(\d)[^#]*#(.+)$/);
  return match ? `xmlschema-${match[1]}#${match[2]}` : undefined;
};

export interface W3cInstanceTest {
  name: string;
  xmlFile: string;
  /** Raw metadata fact (`expected validity` attribute) — not a selection. */
  expectedValid: boolean;
}

export interface W3cTestGroup {
  /** testGroup name, e.g. "ipo1" */
  name: string;
  /** testSet file this group came from */
  testSet: string;
  /** Absolute paths of the schema documents (empty when the group has no schemaTest). */
  xsdFiles: string[];
  /** Raw metadata fact (every schemaTest's `expected validity`) — not a selection. */
  schemaExpectedValid: boolean;
  instances: W3cInstanceTest[];
  /** Unique spec anchors (e.g. "xmlschema-1#Complex_Type_Definitions"). */
  specRefs: string[];
}

// Faithful, unfiltered representation of a testSet file: every testGroup with
// the raw validity facts from its metadata. All case *selection* lives in
// discoverValidCases — do not add filtering here, or the two will drift.
export const parseTestSet = (file: string): W3cTestGroup[] => {
  const dir = path.dirname(file);
  const parsed = parser.parse(readXmlFile(file)) as AnyNode;
  const root = rootOf(parsed);

  return childrenOf(root, 'testGroup').map(group => {
    const schemaTests = childrenOf(group, 'schemaTest');
    const xsdFiles = schemaTests
      .flatMap(t => childrenOf(t, 'schemaDocument'))
      .map(d => href(d))
      .filter((h): h is string => h !== undefined)
      .map(h => path.resolve(dir, h));

    const instances = childrenOf(group, 'instanceTest').map(t => {
      const doc = childrenOf(t, 'instanceDocument').map(d => href(d)).find(h => h !== undefined);
      return {
        name: String(t['@_name'] ?? ''),
        xmlFile: path.resolve(dir, doc ?? ''),
        expectedValid: expectedValid(t)
      };
    }).filter(i => i.xmlFile !== dir);

    const specRefs = [
      ...new Set(
        childrenOf(group, 'documentationReference')
          .map(d => href(d))
          .map(h => (h === undefined ? undefined : specAnchor(h)))
          .filter((a): a is string => a !== undefined)
      )
    ];

    return {
      name: String(group['@_name'] ?? ''),
      testSet: file,
      xsdFiles,
      schemaExpectedValid: schemaTests.length > 0 && schemaTests.every(expectedValid),
      instances,
      specRefs
    };
  });
};

/** Absolute paths of all testSet files referenced by the top-level suite.xml index. */
export const parseSuiteIndex = (suiteFile: string): string[] => {
  const dir = path.dirname(suiteFile);
  const parsed = parser.parse(readXmlFile(suiteFile)) as AnyNode;
  const root = rootOf(parsed);
  return childrenOf(root, 'testSetRef')
    .map(r => href(r))
    .filter((h): h is string => h !== undefined)
    .map(h => path.resolve(dir, h));
};

export interface W3cCase {
  /** e.g. "ipo1/ipo_1" */
  name: string;
  testSet: string;
  xsdFiles: string[];
  xmlFile: string;
  specRefs: string[];
}

/**
 * Positive round-trip cases from the given testSet files: groups whose schema
 * is expected valid, restricted to instances expected valid. Invalid-instance
 * tests are Phase 3 of #108.
 */
export const discoverValidCases = (testSetFiles: string[]): W3cCase[] => {
  const cases: W3cCase[] = [];
  for (const testSet of testSetFiles) {
    for (const group of parseTestSet(testSet)) {
      if (!group.schemaExpectedValid || group.xsdFiles.length === 0) continue;
      for (const instance of group.instances) {
        if (!instance.expectedValid) continue;
        cases.push({
          name: `${group.name}/${instance.name || path.basename(instance.xmlFile, '.xml')}`,
          testSet,
          xsdFiles: group.xsdFiles,
          xmlFile: instance.xmlFile,
          specRefs: group.specRefs
        });
      }
    }
  }
  return cases;
};
