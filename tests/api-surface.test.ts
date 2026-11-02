import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as compiler from "../src/compiler.js";
import { irToZod, parseXsd } from "../src/compiler.js";
import * as runtime from "../src/index.js";
import { XSD_LEXICAL_VALIDATORS, XSD_STRUCTURED_TYPES } from "../src/irToZod.js";
import { withTempDirAsync } from "./helpers.js";

// The root entry is the contract committed generated modules rely on. It may
// only contain the runtime and the helpers codegen can emit; the compiler
// surface lives at `xsd-to-zod/compiler`. These lists are the review diff for
// every public export change.

const RUNTIME_EXPORTS = new Set([
  "coerceXmlValue",
  "parseXml",
  "safeParseXml",
  "serializeXml",
  "ParseXmlOptions",
  "SerializeXmlOptions",
  "QName",
  "XmlChoiceArrayMeta",
  "XmlChoiceBranchMeta",
  "XmlChoiceFieldMeta",
  "XmlChoiceMeta",
  "XmlFieldMeta",
  "XmlLexicalFacets",
  "XmlMeta",
  "XmlSimpleTypeMeta",
  "XmlWrappedMeta",
  "xmlRegistry",
  "XsdOrderDatatype",
  "xsdDecimalLexical",
  "xsdFractionDigits",
  "xsdOrderCompare",
  "xsdTotalDigits",
  "XsdDatatypeName",
  "XsdDate",
  "XsdDateTime",
  "XsdDuration",
  "XsdGDay",
  "XsdGMonth",
  "XsdGMonthDay",
  "XsdGYear",
  "XsdGYearMonth",
  "XsdStructuredValue",
  "XsdTime",
  "parseXsdDatatype",
  "parseXsdDate",
  "parseXsdDateTime",
  "parseXsdDuration",
  "parseXsdGDay",
  "parseXsdGMonth",
  "parseXsdGMonthDay",
  "parseXsdGYear",
  "parseXsdGYearMonth",
  "parseXsdTime",
  "writeXsdDatatype",
  "writeXsdDate",
  "writeXsdDateTime",
  "writeXsdDuration",
  "writeXsdGDay",
  "writeXsdGMonth",
  "writeXsdGMonthDay",
  "writeXsdGYear",
  "writeXsdGYearMonth",
  "writeXsdTime",
  "xsdBase64Binary",
  "xsdDate",
  "xsdDateTime",
  "xsdDuration",
  "xsdGDay",
  "xsdGMonth",
  "xsdGMonthDay",
  "xsdGYear",
  "xsdGYearMonth",
  "xsdHexBinary",
  "xsdLanguage",
  "xsdName",
  "xsdNCName",
  "xsdNCNames",
  "xsdNMTOKEN",
  "xsdNMTOKENS",
  "xsdQName",
  "xsdTime",
  "xsdPattern",
]);

const COMPILER_EXPORTS = new Set([
  "DownloadedSchemaClosure",
  "DownloadSchemaOptions",
  "downloadSchemaClosure",
  "Xsd2ZodError",
  "FetchSchemaResolver",
  "FetchSchemaResolverOptions",
  "createFetchSchemaResolver",
  "describeSchemaBase",
  "IrToZodOptions",
  "irToZod",
  "ParseXsdOptions",
  "ResolvedSchema",
  "ResolveSchema",
  "SchemaResolutionBase",
  "parseXsd",
  "runPostGenerationFormatting",
  "readXmlFile",
  "CachedRemoteSchema",
  "FetchedRemoteSchema",
  "RemoteSchemaLockEntry",
  "RemoteSchemaStoreOptions",
  "REMOTE_SCHEMA_LOCKFILE",
  "RemoteSchemaStore",
  "Cardinality",
  "ChoiceArrayBranch",
  "ChoiceArrayField",
  "ChoiceGroupGuard",
  "ComplexTypeDef",
  "Diagnostic",
  "DiagnosticKind",
  "ElementDef",
  "Facet",
  "FieldKind",
  "IdentityConstraint",
  "IdentityPath",
  "IdentityStep",
  "IrField",
  "QName",
  "SimpleTypeDef",
  "WildcardDef",
  "XsdIr",
]);

const exportedNames = (file: string): string[] => {
  const source = fs
    .readFileSync(path.resolve(file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const names = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    const body = match[1] ?? "";
    for (const raw of body.split(",")) {
      const spec = raw.trim();
      if (spec === "") {
        continue;
      }
      const withoutType = spec.replace(/^type\s+/, "");
      const [imported, alias] = withoutType.split(/\s+as\s+/);
      const name = (alias ?? imported ?? "").trim();
      if (name !== "") {
        names.add(name);
      }
    }
  }
  return [...names].sort();
};

const generatedImports = (source: string): string[] => {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    const match = /^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]xsd-to-zod['"]/.exec(line);
    if (match === null) {
      continue;
    }
    for (const raw of (match[1] ?? "").split(",")) {
      const spec = raw.trim().replace(/^type\s+/, "");
      const [name] = spec.split(/\s+as\s+/);
      if (name !== undefined && name.trim() !== "") {
        names.add(name.trim());
      }
    }
  }
  return [...names].sort();
};

const ALL_HELPERS = new Set([
  "xmlRegistry",
  "coerceXmlValue",
  "xsdPattern",
  "xsdTotalDigits",
  "xsdFractionDigits",
  "xsdOrderCompare",
  "xsdDecimalLexical",
  ...XSD_LEXICAL_VALIDATORS.values(),
  ...[...XSD_STRUCTURED_TYPES.values()].flatMap((t) => [t.parseFn, t.writeFn, t.tsType]),
  "XmlMeta",
  "XmlFieldMeta",
  "XmlChoiceMeta",
]);

const FIXTURE = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
  targetNamespace="urn:api" xmlns:t="urn:api" elementFormDefault="qualified">
  <xs:simpleType name="Code">
    <xs:restriction base="xs:string"><xs:pattern value="[A-Z]{3}"/></xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Amount">
    <xs:restriction base="xs:decimal">
      <xs:totalDigits value="6"/>
      <xs:fractionDigits value="2"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Mode">
    <xs:union memberTypes="xs:int xs:string"/>
  </xs:simpleType>
  <xs:complexType name="Root">
    <xs:sequence>
      <xs:element name="code" type="t:Code"/>
      <xs:element name="amount" type="t:Amount"/>
      <xs:element name="when" type="xs:date"/>
      <xs:element name="from">
        <xs:simpleType>
          <xs:restriction base="xs:date"><xs:minInclusive value="2000-01-01"/></xs:restriction>
        </xs:simpleType>
      </xs:element>
      <xs:element name="qname" type="xs:QName"/>
      <xs:choice maxOccurs="unbounded">
        <xs:element name="a" type="xs:string"/>
        <xs:element name="b" type="xs:string"/>
      </xs:choice>
    </xs:sequence>
    <xs:attribute name="id" type="xs:ID" use="required"/>
    <xs:attribute name="mode" type="t:Mode" default="1"/>
  </xs:complexType>
  <xs:element name="root" type="t:Root"/>
</xs:schema>`;

describe("public API surface", () => {
  it("keeps the runtime entry to the documented runtime exports", () => {
    expect(exportedNames("src/index.ts")).toEqual([...RUNTIME_EXPORTS].sort());
    for (const name of Object.keys(runtime)) {
      expect(RUNTIME_EXPORTS.has(name)).toBe(true);
    }
  });

  it("keeps the compiler entry to the documented compiler exports", () => {
    expect(exportedNames("src/compiler.ts")).toEqual([...COMPILER_EXPORTS].sort());
    for (const name of Object.keys(compiler)) {
      expect(COMPILER_EXPORTS.has(name)).toBe(true);
    }
  });

  it("does not leak compiler symbols from the runtime entry", () => {
    expect(runtime).not.toHaveProperty("parseXsd");
    expect(runtime).not.toHaveProperty("irToZod");
    expect(runtime).not.toHaveProperty("readXmlFile");
    expect(runtime).not.toHaveProperty("runPostGenerationFormatting");
    expect(runtime).not.toHaveProperty("Xsd2ZodError");
    expect(runtime).not.toHaveProperty("downloadSchemaClosure");
    expect(runtime).not.toHaveProperty("RemoteSchemaStore");
    expect(runtime).not.toHaveProperty("createFetchSchemaResolver");
  });

  it("keeps every codegen-emittable helper in the runtime entry", () => {
    for (const name of ALL_HELPERS) {
      expect(RUNTIME_EXPORTS.has(name)).toBe(true);
    }
  });

  it("generates only runtime imports in every generation mode", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "api.xsd");
      fs.writeFileSync(file, FIXTURE);
      const ir = await parseXsd([file]);
      const modes = [
        {},
        { datatypes: "structured" as const },
        { integers: "bigint" as const },
        { decimal: "string" as const },
        { ergonomic: true },
        { js: true },
      ];
      for (const mode of modes) {
        const source = irToZod(ir, mode).schemas;
        for (const name of generatedImports(source)) {
          expect(RUNTIME_EXPORTS.has(name), `${JSON.stringify(mode)} imports ${name}`).toBe(true);
        }
      }
    });
  });
});
