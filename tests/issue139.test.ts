import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseXsd } from "../src/index.js";
import { withTempDir } from "./helpers.js";

// Regression tests for remote schemaLocations: an xs:import/xs:include
// schemaLocation is only a hint, and an http(s) location must never be read
// as a local file. The location is skipped and reported as a structured
// diagnostic so consumers can tell a skipped link from a missing file.

const IMPORT_REMOTE_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:import namespace="urn:elsewhere" schemaLocation="http:/127.0.0.1/must%20not%20resolve.xyzzy"/>
  <xs:include schemaLocation="https://example.com/also-not-a-file.xsd"/>
  <xs:element name="doc" type="xs:string"/>
</xs:schema>`;

describe("remote schemaLocation hints", () => {
  it("are skipped with a remote-schema-location diagnostic, never read as files", () => {
    withTempDir((dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, IMPORT_REMOTE_XSD);
      const ir = parseXsd([file]);
      expect(ir.elements["{}doc"]).toBeDefined();
      expect(ir.diagnostics).toEqual([
        {
          kind: "remote-schema-location",
          message:
            'remote schemaLocation "http:/127.0.0.1/must%20not%20resolve.xyzzy" skipped (not resolved)',
          ref: "http:/127.0.0.1/must%20not%20resolve.xyzzy",
        },
        {
          kind: "remote-schema-location",
          message:
            'remote schemaLocation "https://example.com/also-not-a-file.xsd" skipped (not resolved)',
          ref: "https://example.com/also-not-a-file.xsd",
        },
      ]);
    });
  });
});
