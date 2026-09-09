import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SchemaResolutionBase } from "../src/index.js";
import { parseXsd, type Xsd2ZodError } from "../src/index.js";
import { withTempDirAsync } from "./helpers.js";

const MAIN_XSD = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:t="urn:types" targetNamespace="urn:main">
  <xs:import namespace="urn:types" schemaLocation="https://schemas.example.com/types.xsd"/>
  <xs:element name="doc" type="t:ThingType"/>
</xs:schema>`;

const REMOTE_SCHEMAS: Record<string, string> = {
  "https://schemas.example.com/types.xsd": `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:t="urn:types" targetNamespace="urn:types">
    <xs:include schemaLocation="nested/common.xsd"/>
    <xs:complexType name="ThingType">
      <xs:sequence><xs:element name="common" type="t:CommonType"/></xs:sequence>
    </xs:complexType>
  </xs:schema>`,
  "https://schemas.example.com/nested/common.xsd": `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:t="urn:types">
    <xs:include schemaLocation="/shared.xsd"/>
    <xs:complexType name="CommonType">
      <xs:sequence><xs:element name="shared" type="t:SharedType"/></xs:sequence>
    </xs:complexType>
  </xs:schema>`,
  "https://schemas.example.com/shared.xsd": `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
    <xs:simpleType name="SharedType">
      <xs:restriction base="xs:string"/>
    </xs:simpleType>
  </xs:schema>`,
};

describe("parseXsd schema resolver", () => {
  it("resolves remote imports and remote-relative includes against their containing URL", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "main.xsd");
      fs.writeFileSync(file, MAIN_XSD);
      const requests: { location: string; base: SchemaResolutionBase }[] = [];
      const fetched: string[] = [];

      const ir = await parseXsd([file], {
        resolveSchema: async (location, base) => {
          requests.push({ location, base });
          const url = base.kind === "url" ? new URL(location, base.url).href : location;
          const content = REMOTE_SCHEMAS[url];
          return content === undefined ? undefined : { content, url };
        },
        onFetch: (url) => fetched.push(url),
      });

      expect(ir.complexTypes["{urn:types}ThingType"]).toBeDefined();
      expect(ir.complexTypes["{urn:types}CommonType"]).toBeDefined();
      expect(ir.simpleTypes["{urn:types}SharedType"]).toBeDefined();
      expect(fetched).toEqual(Object.keys(REMOTE_SCHEMAS));
      expect(requests).toContainEqual({
        location: "nested/common.xsd",
        base: { kind: "url", url: "https://schemas.example.com/types.xsd" },
      });
      expect(requests).toContainEqual({
        location: "/shared.xsd",
        base: { kind: "url", url: "https://schemas.example.com/nested/common.xsd" },
      });
      expect(ir.diagnostics).toEqual([]);
    });
  });

  it("accepts a remote entry schema through the resolver", async () => {
    const entry = "https://schemas.example.com/entry.xsd";
    const schemas: Record<string, string> = {
      [entry]: `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
        <xs:include schemaLocation="types.xsd"/>
        <xs:element name="doc" type="DocType"/>
      </xs:schema>`,
      "https://schemas.example.com/types.xsd": `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
        <xs:complexType name="DocType">
          <xs:sequence><xs:element name="value" type="xs:string"/></xs:sequence>
        </xs:complexType>
      </xs:schema>`,
    };

    const ir = await parseXsd([entry], {
      resolveSchema: async (location, base) => {
        const url = base.kind === "url" ? new URL(location, base.url).href : location;
        const content = schemas[url];
        return content === undefined ? undefined : { content, url };
      },
    });

    expect(ir.elements["{}doc"]?.typeName).toBe("{}DocType");
    expect(ir.complexTypes["{}DocType"]).toBeDefined();
    expect(ir.diagnostics).toEqual([]);
  });
});

describe("internal entity expansion limits", () => {
  it("expands single-quoted internal entities", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(
        file,
        `<!DOCTYPE xs:schema [<!ENTITY pattern '[a-z]+'>]>
        <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
          <xs:simpleType name="Quoted">
            <xs:restriction base="xs:string"><xs:pattern value="&pattern;"/></xs:restriction>
          </xs:simpleType>
        </xs:schema>`,
      );

      const ir = await parseXsd([file]);
      expect(ir.simpleTypes["{}Quoted"]).toMatchObject({
        kind: "restriction",
        facets: [{ kind: "pattern", value: "[a-z]+" }],
      });
    });
  });

  it("rejects exponential entity expansion", async () => {
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(
        file,
        `<!DOCTYPE xs:schema [
          <!ENTITY e0 "${"x".repeat(1024)}">
          <!ENTITY e1 "${"&e0;".repeat(10)}">
          <!ENTITY e2 "${"&e1;".repeat(10)}">
          <!ENTITY e3 "${"&e2;".repeat(10)}">
          <!ENTITY e4 "${"&e3;".repeat(10)}">
          <!ENTITY e5 "${"&e4;".repeat(10)}">
        ]>
        <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
          <xs:simpleType name="Limited">
            <xs:restriction base="xs:string"><xs:pattern value="&e5;"/></xs:restriction>
          </xs:simpleType>
        </xs:schema>`,
      );

      await expect(parseXsd([file])).rejects.toMatchObject({
        code: "entity-expansion-too-large",
      } satisfies Partial<Xsd2ZodError>);
    });
  });

  it("does not dereference external entities", async () => {
    await withTempDirAsync(async (dir) => {
      const secret = path.join(dir, "external.xsd");
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(
        file,
        `<!DOCTYPE xs:schema [<!ENTITY external SYSTEM "${secret}">]>
        <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
          <xs:annotation><xs:documentation>&external;</xs:documentation></xs:annotation>
          <xs:element name="doc" type="xs:string"/>
        </xs:schema>`,
      );

      await expect(parseXsd([file])).rejects.toMatchObject({
        code: "external-entity",
      } satisfies Partial<Xsd2ZodError>);

      const parameterEntityFile = path.join(dir, "parameter-entity.xsd");
      fs.writeFileSync(
        parameterEntityFile,
        `<!DOCTYPE xs:schema [<!ENTITY % external SYSTEM "${secret}">]>
        <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
          <xs:element name="doc" type="xs:string"/>
        </xs:schema>`,
      );
      await expect(parseXsd([parameterEntityFile])).rejects.toMatchObject({
        code: "external-entity",
      } satisfies Partial<Xsd2ZodError>);
    });
  });
});
