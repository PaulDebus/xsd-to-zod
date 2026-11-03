import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { irToZod, parseXsd } from "../src/compiler.js";
import {
  STANDALONE_HELPER_MODULE_NAMES,
  STANDALONE_HELPER_SOURCES,
} from "../src/standaloneHelperSources.generated.js";
import { standaloneHelperExportNames, standaloneHelperSource } from "../src/standaloneHelpers.js";
import { expectTscPasses, importGeneratedSchemas, withTempDirAsync } from "./helpers.js";

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           targetNamespace="urn:s" xmlns="urn:s" elementFormDefault="qualified">
  <xs:simpleType name="Code">
    <xs:restriction base="xs:string"><xs:pattern value="[A-Z]{3}"/></xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Amount">
    <xs:restriction base="xs:integer">
      <xs:totalDigits value="6"/>
      <xs:minInclusive value="0"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:complexType name="Base" abstract="true">
    <xs:sequence><xs:element name="name" type="xs:string"/></xs:sequence>
  </xs:complexType>
  <xs:complexType name="Derived">
    <xs:complexContent>
      <xs:extension base="Base">
        <xs:sequence><xs:element name="extra" type="xs:int"/></xs:sequence>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:complexType name="Root">
    <xs:sequence>
      <xs:element name="item" type="Base" maxOccurs="unbounded"/>
      <xs:element name="code" type="Code"/>
      <xs:element name="amount" type="Amount"/>
      <xs:element name="when" type="xs:date" minOccurs="0"/>
      <xs:choice>
        <xs:element name="a" type="xs:string"/>
        <xs:element name="b" type="xs:string"/>
      </xs:choice>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="root" type="Root"/>
</xs:schema>`;

const generatedFor = async (
  xsd: string,
  opts: { standalone?: boolean; datatypes?: "string" | "structured" } = {},
): Promise<string> => {
  let source = "";
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    source = irToZod(await parseXsd([file]), opts).schemas;
  });
  return source;
};

describe("--standalone output", () => {
  it("imports only zod and never registers xml metadata", async () => {
    const source = await generatedFor(XSD, { standalone: true });
    const imports = source.split("\n").filter((line) => line.startsWith("import"));
    expect(imports).toEqual(["import { z } from 'zod';"]);
    expect(source).not.toContain("from 'xsd-to-zod'");
    expect(source).not.toContain(".register(xmlRegistry");
    expect(source).toContain("choiceGroupIssues(");
    expect(source).toContain("xsdPattern(");
  });

  it("enforces identity constraints on the data shape", async () => {
    const identityXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="item" maxOccurs="unbounded">
          <xs:complexType>
            <xs:attribute name="id" type="xs:string" use="required"/>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
    <xs:key name="itemKey"><xs:selector xpath="item"/><xs:field xpath="@id"/></xs:key>
  </xs:element>
</xs:schema>`;
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, identityXsd);
      const result = irToZod(await parseXsd([file]), { standalone: true });
      expect(result.warnings.join("\n")).not.toContain("identity constraints");
      expect(result.schemas).toContain("identityIssues");
      const mod = await importGeneratedSchemas(result.schemas);
      const root = mod["rootSchema"] as z.ZodType;
      expect(root.safeParse({ item: [{ "@id": "a" }, { "@id": "a" }] }).success).toBe(false);
      expect(root.safeParse({ item: [{ "@id": "a" }, { "@id": "b" }] }).success).toBe(true);
    });
  });

  it("keeps the registry-backed output unchanged when the flag is off", async () => {
    const source = await generatedFor(XSD);
    expect(source).toContain("from 'xsd-to-zod'");
    expect(source).toContain(".register(xmlRegistry");
    expect(source).not.toContain("choiceGroupIssues(");
  });

  it("enforces xs:choice with a plain .parse()", async () => {
    const source = await generatedFor(XSD, { standalone: true });
    const mod = await importGeneratedSchemas(source);
    const root = mod["rootSchema"] as z.ZodType;

    const valid = { item: [{ name: "n" }], code: "ABC", amount: 12, a: "x" };
    expect(root.safeParse(valid).success).toBe(true);
    expect(root.safeParse({ ...valid, a: undefined }).success).toBe(false);
    expect(root.safeParse({ ...valid, b: "y" }).success).toBe(false);
  });

  it("keeps XSD facets and lexical checks in the standalone schemas", async () => {
    const source = await generatedFor(XSD, { standalone: true });
    const mod = await importGeneratedSchemas(source);
    const root = mod["rootSchema"] as z.ZodType;

    const valid = { item: [{ name: "n" }], code: "ABC", amount: 12, a: "x" };
    expect(root.safeParse(valid).success).toBe(true);
    expect(root.safeParse({ ...valid, code: "abc" }).success).toBe(false);
    expect(root.safeParse({ ...valid, amount: 1234567 }).success).toBe(false);
    expect(root.safeParse({ ...valid, amount: 123456 }).success).toBe(true);
    expect(root.safeParse({ ...valid, amount: -1 }).success).toBe(false);
    expect(root.safeParse({ ...valid, when: "not-a-date" }).success).toBe(false);
    expect(root.safeParse({ ...valid, when: "2024-02-29" }).success).toBe(true);
  });

  it("dispatches xsi:type variants from the synthetic discriminant", async () => {
    const source = await generatedFor(XSD, { standalone: true });
    const mod = await importGeneratedSchemas(source);
    const root = mod["rootSchema"] as z.ZodType;

    const declared = { item: [{ name: "base" }], code: "ABC", amount: 1, a: "x" };
    expect(root.safeParse(declared).success).toBe(true);
    const derived = {
      item: [{ name: "d", xsiType: "{urn:s}Derived", extra: 2 }],
      code: "ABC",
      amount: 1,
      a: "x",
    };
    expect(root.safeParse(derived).success).toBe(true);
    expect(
      root.safeParse({ ...derived, item: [{ name: "d", xsiType: "{urn:s}Derived" }] }).success,
    ).toBe(false);
  });

  it("inlines structured datatype helpers and types", async () => {
    const source = await generatedFor(XSD, { standalone: true, datatypes: "structured" });
    expect(source).toContain("export const parseXsdDate");
    expect(source).toContain("export type XsdDate");
    const mod = await importGeneratedSchemas(source);
    const root = mod["rootSchema"] as z.ZodType;
    const parsed = root.parse({
      item: [{ name: "n" }],
      code: "ABC",
      amount: 1,
      when: "2024-02-29Z",
      a: "x",
    }) as { when: { year: number; month: number; day: number } };
    expect(parsed.when.year).toBe(2024);
    expect(parsed.when.month).toBe(2);
    expect(parsed.when.day).toBe(29);
  });

  it("emits helper code only when the schema needs it", async () => {
    const trivial = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
    const source = await generatedFor(trivial, { standalone: true });
    expect(source).not.toContain("export const xsdDate");
    expect(source).not.toContain("choiceGroupIssues");
    expect(source).not.toContain("coerceXmlValue");
  });

  it("keeps the embedded helper sources in sync with src", () => {
    for (const file of STANDALONE_HELPER_MODULE_NAMES) {
      expect(STANDALONE_HELPER_SOURCES[file]).toBe(
        fs.readFileSync(path.resolve("src", file), "utf8"),
      );
    }
  });

  it("inlines every helper module without duplicate top-level names or imports", () => {
    const source = standaloneHelperSource(
      new Set(["parseXsdDate", "xsdPattern", "xsdOrderCompare", "choiceGroupIssues"]),
      {
        totalDigits: true,
        fractionDigits: true,
        coerceXmlValue: true,
        choices: true,
        identity: true,
      },
    );
    expect(source).not.toMatch(/^import\b/m);
    const declarations = [
      ...source.matchAll(
        /^(?:export\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
      ),
    ].map((match) => match[1]);
    const duplicates = declarations.filter(
      (name, index) => name !== undefined && declarations.indexOf(name) !== index,
    );
    expect(duplicates).toEqual([]);
  });

  it("reserves inlined helper names for generated type identifiers", async () => {
    const names = standaloneHelperExportNames();
    expect(names).toContain("xsdPattern");
    expect(names).toContain("choiceGroupIssues");
    expect(names).toContain("parseXsdDate");
  });

  it("typechecks under strict settings with unused-location checks", async () => {
    const unionXsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:simpleType name="Val"><xs:union memberTypes="xs:int xs:boolean"/></xs:simpleType>
  <xs:complexType name="Root">
    <xs:attribute name="v" type="Val" default="42"/>
  </xs:complexType>
  <xs:element name="root" type="Root"/>
</xs:schema>`;
    const baseDir = path.resolve(".xsd-to-zod-tests");
    fs.mkdirSync(baseDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(baseDir, "standalone-tsc-"));
    try {
      const files = [
        ["plain.zod.ts", await generatedFor(XSD, { standalone: true })],
        [
          "structured.zod.ts",
          await generatedFor(XSD, { standalone: true, datatypes: "structured" }),
        ],
        ["union-default.zod.ts", await generatedFor(unionXsd, { standalone: true })],
      ].map(([name, source]) => {
        const file = path.join(dir, name as string);
        fs.writeFileSync(file, source as string);
        return file;
      });
      expectTscPasses(files, [
        "--noUnusedLocals",
        "--noUnusedParameters",
        "--exactOptionalPropertyTypes",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
