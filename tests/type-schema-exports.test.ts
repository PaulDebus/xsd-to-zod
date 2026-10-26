import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { irToZod, parseXsd, xmlRegistry } from "../src/index.js";
import { importGeneratedSchemas, withTempDirAsync } from "./helpers.js";

const generate = async (
  xsd: string,
): Promise<{ schemas: string; mod: Record<string, unknown> }> => {
  let schemas = "";
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    schemas = irToZod(await parseXsd([file])).schemas;
  });
  return { schemas, mod: await importGeneratedSchemas(schemas) };
};

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:dt" xmlns:t="urn:dt">
  <xs:simpleType name="GuidType">
    <xs:restriction base="xs:string">
      <xs:pattern value="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:complexType name="DataTemplateType">
    <xs:sequence>
      <xs:element name="guid" type="t:GuidType"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="dataTemplate" type="t:DataTemplateType"/>
</xs:schema>`;

describe("named type schema exports", () => {
  it("exports simple and complex type schemas", async () => {
    const { schemas } = await generate(XSD);
    expect(schemas).toContain("export const GuidTypeSchema = ");
    expect(schemas).toContain("export const DataTemplateTypeSchema");
  });

  it("validates fragments through the exported type schemas", async () => {
    const { mod } = await generate(XSD);
    const guid = mod["GuidTypeSchema"] as z.ZodType;
    const template = mod["DataTemplateTypeSchema"] as z.ZodType;
    expect(guid.parse("2f1c9d1e-4b6a-4f3c-9d2e-7a8b9c0d1e2f")).toBe(
      "2f1c9d1e-4b6a-4f3c-9d2e-7a8b9c0d1e2f",
    );
    expect(guid.safeParse("not-a-guid").success).toBe(false);
    expect(template.parse({ guid: "2f1c9d1e-4b6a-4f3c-9d2e-7a8b9c0d1e2f" })).toEqual({
      guid: "2f1c9d1e-4b6a-4f3c-9d2e-7a8b9c0d1e2f",
    });
    // The exported type schema is a fragment schema: it registers no root.
    expect(xmlRegistry.get(guid)).not.toHaveProperty("root");
  });

  it("keeps root and type exports in separate namespaces", async () => {
    const { mod } = await generate(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:simpleType name="GuidType">
    <xs:restriction base="xs:string"/>
  </xs:simpleType>
  <xs:element name="GuidType" type="xs:string"/>
</xs:schema>`);
    // The root claims the element-derived name; the type const is suffixed.
    expect(xmlRegistry.get(mod["GuidTypeSchema"] as z.ZodType)?.root).toBe("{}GuidType");
    expect((mod["GuidTypeSchema2"] as z.ZodType).parse("x")).toBe("x");
  });
});
