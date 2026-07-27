import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { irToZod, parseXsd } from "../src/index.js";
import { generateAndImport, withTempDir, withTempDirAsync } from "./helpers.js";

// Targeted regression tests for the issue-#114 facet codegen fixes: facet
// checks must only be emitted in a form the mapped Zod schema supports.

const codeFor = (xsd: string): string => {
  let code = "";
  withTempDir((dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    code = irToZod(parseXsd([file])).schemas;
  });
  return code;
};

describe("facet codegen on incompatible Zod types (#114)", () => {
  it("emits pattern as a String(val) refine on non-string bases", () => {
    const code = codeFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:simpleType name="FiveDigits">
    <xs:restriction base="xs:integer">
      <xs:pattern value="[0-9]{5}"/>
    </xs:restriction>
  </xs:simpleType>
</xs:schema>`);
    expect(code).not.toContain(".regex(");
    expect(code).toContain(".test(String(val))");
  });

  it("skips order facets on string-typed bases (no .gt/.lt/NaN emission)", () => {
    const code = codeFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:simpleType name="Window">
    <xs:restriction base="xs:date">
      <xs:minInclusive value="2002-01-01"/>
      <xs:maxExclusive value="2003-01-01"/>
    </xs:restriction>
  </xs:simpleType>
</xs:schema>`);
    expect(code).not.toMatch(/\.(gt|lt|min|max)\(/);
    expect(code).not.toContain("NaN");
    // Skipped facets must leave a diagnostic in the generated code.
    expect(code).toContain("facet minInclusive skipped");
    expect(code).toContain("facet maxExclusive skipped");
  });

  it("skips length facets on NOTATION/QName restrictions (vacuous in XSD 1.0)", () => {
    const code = codeFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" xmlns:t="urn:t">
  <xs:simpleType name="Notations">
    <xs:restriction base="xs:NOTATION">
      <xs:enumeration value="jpeg"/>
      <xs:enumeration value="g"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Sized">
    <xs:restriction base="t:Notations">
      <xs:length value="4"/>
    </xs:restriction>
  </xs:simpleType>
</xs:schema>`);
    expect(code).toContain("facet length skipped: vacuous for xs:NOTATION in XSD 1.0");
    expect(code).not.toContain(".length(4)");
  });

  it("emits length facets as a .length refine on enum/reference bases", () => {
    const code = codeFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:t" xmlns:t="urn:t">
  <xs:simpleType name="Base">
    <xs:restriction base="xs:string">
      <xs:enumeration value="aa"/>
      <xs:enumeration value="bbb"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:simpleType name="Derived">
    <xs:restriction base="t:Base">
      <xs:minLength value="2"/>
    </xs:restriction>
  </xs:simpleType>
</xs:schema>`);
    expect(code).toContain("val.length >= 2");
  });

  it("generated module imports and validates (pattern refine rejects mismatches)", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(
        file,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:simpleType name="FiveDigits">
    <xs:restriction base="xs:integer">
      <xs:pattern value="[0-9]{5}"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:element name="n" type="FiveDigits"/>
</xs:schema>`,
      );
      const mod = await generateAndImport([file]);
      const schema = Object.values(mod)[0] as import("zod").z.ZodType;
      expect(schema.safeParse(12345).success).toBe(true);
      expect(schema.safeParse(123).success).toBe(false);
    });
  });
});
