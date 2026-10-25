import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { irToZod, parseXml, parseXsd } from "../src/index.js";
import { importGeneratedSchemas, onlyRootSchema, withTempDirAsync } from "./helpers.js";

// Codegen wraps every generated type in z.lazy, whose getter builds the whole
// object literal. The runtime must take zod's cached inner type rather than
// re-invoking the getter, or every schema lookup reconstructs the schema.
const RECURSIVE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:hot" xmlns:t="urn:hot" elementFormDefault="qualified">
  <xs:complexType name="node">
    <xs:sequence>
      <xs:element name="value" type="xs:string"/>
      <xs:element name="child" type="t:node" minOccurs="0" maxOccurs="unbounded"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="node" type="t:node"/>
</xs:schema>`;

const XML = `<node xmlns="urn:hot"><value>a</value><child><value>b</value><child><value>c</value></child></child></node>`;

const isSchema = (value: unknown): value is z.ZodType =>
  value !== null && typeof value === "object" && "_zod" in value;

// Walk every schema reachable from the roots, resolving each lazy through
// zod's cached innerType, and return the lazy instances.
const collectLazies = (roots: readonly z.ZodType[]): z.ZodType[] => {
  const lazies = new Set<z.ZodType>();
  const seen = new Set<z.ZodType>();
  const visitValue = (value: unknown): void => {
    if (isSchema(value)) {
      visit(value);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const nested of Object.values(value)) {
        if (isSchema(nested)) {
          visit(nested);
        }
      }
    }
  };
  const visit = (schema: z.ZodType): void => {
    if (seen.has(schema)) {
      return;
    }
    seen.add(schema);
    const def = schema._zod.def;
    if (def.type === "lazy") {
      lazies.add(schema);
      const internals = schema._zod as { innerType?: z.ZodType };
      visitValue(internals.innerType);
      return;
    }
    for (const value of Object.values(def)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          visitValue(item);
        }
      } else {
        visitValue(value);
      }
    }
  };
  for (const root of roots) {
    visit(root);
  }
  return [...lazies];
};

describe("runtime hot path", () => {
  it("does not re-run a lazy schema getter on repeated parses", async () => {
    let schemasCode = "";
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, RECURSIVE_XSD);
      schemasCode = irToZod(await parseXsd([file])).schemas;
    });
    const mod = await importGeneratedSchemas(schemasCode);
    const rootSchema = onlyRootSchema(mod);
    const lazies = collectLazies(
      Object.values(mod).filter((value): value is z.ZodType => isSchema(value)),
    );

    let getterCalls = 0;
    for (const lazy of lazies) {
      const def = lazy._zod.def as { getter?: () => z.ZodType };
      const original = def.getter;
      if (original === undefined) {
        throw new Error("lazy schema has no getter");
      }
      def.getter = () => {
        getterCalls++;
        return original();
      };
    }

    parseXml(rootSchema, XML);
    getterCalls = 0;
    parseXml(rootSchema, XML);
    expect(getterCalls).toBe(0);
  });
});
