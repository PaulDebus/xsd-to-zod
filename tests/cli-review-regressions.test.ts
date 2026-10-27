import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main, stripImports } from "../src/cli.js";
import { validateSchema } from "../src/validate.js";
import { withTempDirAsync } from "./helpers.js";

describe("bundle namespace context preservation", () => {
  it("decodes dependency paths and escapes added namespace bindings exactly once", async () => {
    await withTempDirAsync(async (dir) => {
      const entry = path.join(dir, "main.xsd");
      const out = path.join(dir, "bundle.xsd");
      fs.writeFileSync(
        entry,
        `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:r">
        <xs:include schemaLocation="dep&amp;one.xsd"/>
        <xs:element name="root" type="xs:string"/>
      </xs:schema>`,
      );
      fs.writeFileSync(
        path.join(dir, "dep&one.xsd"),
        `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:r" xmlns:code="urn:a?x=1&amp;y=2">
        <xs:simpleType name="Code"><xs:restriction base="xs:string"/></xs:simpleType>
      </xs:schema>`,
      );
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await main(["bundle", entry, "-o", out])).toBe(0);
      } finally {
        log.mockRestore();
      }
      const xml = fs.readFileSync(out, "utf8");
      expect(xml).toContain('xmlns:code="urn:a?x=1&amp;y=2"');
      expect(xml).not.toContain("&amp;amp;");
      expect(await validateSchema(xml)).toEqual({ valid: true });
    });
  });

  it.each(['xmlns="urn:r"', 'blockDefault="extension"', 'finalDefault="restriction"'])(
    "rejects dependency context changes: %s",
    async (extra) => {
      await withTempDirAsync(async (dir) => {
        const entry = path.join(dir, "main.xsd");
        const out = path.join(dir, "bundle.xsd");
        fs.writeFileSync(
          entry,
          `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:r"><xs:include schemaLocation="dep.xsd"/></xs:schema>`,
        );
        fs.writeFileSync(
          path.join(dir, "dep.xsd"),
          `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:r" ${extra}/>`,
        );
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          expect(await main(["bundle", entry, "-o", out])).toBe(1);
          expect(fs.existsSync(out)).toBe(false);
          expect(error.mock.calls.flat().join(" ")).toContain("download");
        } finally {
          error.mockRestore();
        }
      });
    },
  );

  it("removes paired imports containing comments without touching quoted examples", () => {
    const source =
      '<xs:include schemaLocation="a>b.xsd"><!-- note --><xs:annotation/></xs:include><xs:element name="kept"/><!-- <xs:include schemaLocation="example"/> --><![CDATA[<xs:import schemaLocation="example"/>]]>';
    expect(stripImports(source)).toBe(
      '<xs:element name="kept"/><!-- <xs:include schemaLocation="example"/> --><![CDATA[<xs:import schemaLocation="example"/>]]>',
    );
  });
});
