import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { irToZod, parseXml, parseXsd, serializeXml } from "../src/index.js";
import { importGeneratedSchemas, withTempDirAsync } from "./helpers.js";

// serializeXml takes the schema's input type: it validates before walking, so
// zod-level attribute defaults apply and invalid data fails early. Generated
// modules export an *In alias per complex type for hand-building data.

const DEFAULTS_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:defaults" xmlns:t="urn:defaults" elementFormDefault="qualified">
  <xs:complexType name="OrderType">
    <xs:sequence>
      <xs:element name="item" type="xs:string"/>
      <xs:element name="quantity" type="xs:integer" default="1"/>
    </xs:sequence>
    <xs:attribute name="currency" type="xs:string" default="EUR"/>
    <xs:attribute name="version" type="xs:string" fixed="1.0"/>
  </xs:complexType>
  <xs:element name="order" type="t:OrderType"/>
</xs:schema>`;

const generate = async (xsd: string): Promise<Record<string, unknown>> => {
  let mod: Record<string, unknown> = {};
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    mod = await importGeneratedSchemas(irToZod(await parseXsd([file])).schemas);
  });
  return mod;
};

describe("serializeXml validates its input", () => {
  it("accepts partial data; defaults apply, fixed/defaulted attributes need not be written", async () => {
    const mod = await generate(DEFAULTS_XSD);
    const orderSchema = mod["orderSchema"] as z.ZodType;
    // The defaulted @currency and the fixed @version are omitted by the
    // caller; validation fills them.
    const serialized = serializeXml(orderSchema, { item: "x", quantity: 1n });
    expect(serialized).toContain("<ns0:item>x</ns0:item>");
    expect(serialized).toContain("<ns0:quantity>1</ns0:quantity>");
    // Round-trip restores the full value.
    expect(parseXml(orderSchema, serialized)).toEqual({
      item: "x",
      quantity: 1n,
      "@currency": "EUR",
      "@version": "1.0",
    });
    // A non-default value is emitted.
    expect(serializeXml(orderSchema, { item: "x", quantity: 2n, "@currency": "USD" })).toContain(
      'currency="USD"',
    );
  });

  it("fails early with a ZodError on invalid data", async () => {
    const mod = await generate(DEFAULTS_XSD);
    const orderSchema = mod["orderSchema"] as z.ZodType;
    expect(() => serializeXml(orderSchema, { quantity: 1n })).toThrow(z.ZodError);
    expect(() => serializeXml(orderSchema, { item: "x", quantity: 1n, "@version": "2.0" })).toThrow(
      z.ZodError,
    );
  });

  it("does not consume the caller's parse-time recordings", async () => {
    const mod = await generate(DEFAULTS_XSD);
    const orderSchema = mod["orderSchema"] as z.ZodType;
    const parsed = parseXml(
      orderSchema,
      '<ns0:order xmlns:ns0="urn:defaults" currency="CHF"><ns0:item>x</ns0:item><ns0:quantity>03</ns0:quantity></ns0:order>',
    );
    // The retained lexical "03" is re-emitted on every serialize of the same
    // tree, not just the first.
    expect(serializeXml(orderSchema, parsed)).toContain(">03</ns0:quantity>");
    expect(serializeXml(orderSchema, parsed)).toContain(">03</ns0:quantity>");
  });

  it("generated modules export input types that admit partial construction", async () => {
    // A consumer that hand-builds partial data must typecheck under strict
    // settings: the defaulted attribute is optional on the input side. Files
    // live in the gitignored dotdir so the xsd-to-zod import resolves via
    // package self-reference.
    const baseDir = path.resolve(".xsd-to-zod-tests");
    fs.mkdirSync(baseDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(baseDir, "serialize-input-"));
    try {
      const xsdFile = path.join(dir, "schema.xsd");
      fs.writeFileSync(xsdFile, DEFAULTS_XSD);
      const { schemas } = irToZod(await parseXsd([xsdFile]));
      expect(schemas).toContain("export type OrderTypeIn = z.input<typeof OrderTypeSchema>;");
      fs.writeFileSync(path.join(dir, "schema.zod.ts"), schemas);
      const consumerFile = path.join(dir, "consumer.ts");
      fs.writeFileSync(
        consumerFile,
        `import { serializeXml } from "xsd-to-zod";
import { orderSchema } from "./schema.zod.js";
import type { OrderTypeIn } from "./schema.zod.js";

const partial: OrderTypeIn = { item: "x", quantity: 1n };
serializeXml(orderSchema, partial);
`,
      );
      const tsc = path.resolve("node_modules/.bin/tsc");
      const result = spawnSync(
        tsc,
        [
          "--noEmit",
          "--ignoreConfig",
          "--strict",
          "--skipLibCheck",
          "--target",
          "es2022",
          "--module",
          "nodenext",
          "--moduleResolution",
          "nodenext",
          consumerFile,
        ],
        { encoding: "utf8" },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
