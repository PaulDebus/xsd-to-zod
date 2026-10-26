import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { parseXml, safeParseXml } from "../src/index.js";
import type { IrToZodOptions } from "../src/irToZod.js";
import { generateAndImport, onlyRootSchema, withTempDirAsync } from "./helpers.js";

// Order facets on the ordered non-numeric builtins: date/time value-space
// comparison, duration's partial order, and codepoint string ordering.

const importRoot = async (xsd: string, opts?: IrToZodOptions): Promise<z.ZodType> => {
  let root: z.ZodType | undefined;
  await withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    root = onlyRootSchema(await generateAndImport([file], opts));
  });
  if (root === undefined) {
    throw new Error("no root schema generated");
  }
  return root;
};

const fieldSchema = (type: string, facets: string): string => `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="v">
          <xs:simpleType>
            <xs:restriction base="xs:${type}">
              ${facets}
            </xs:restriction>
          </xs:simpleType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const doc = (value: string): string => `<root><v>${value}</v></root>`;

const expectValues = (root: z.ZodType, valid: string[], invalid: string[]): void => {
  for (const value of valid) {
    expect(safeParseXml(root, doc(value)).success, `expected valid: ${value}`).toBe(true);
  }
  for (const value of invalid) {
    expect(safeParseXml(root, doc(value)).success, `expected invalid: ${value}`).toBe(false);
  }
};

describe("date order facets", () => {
  it("enforces minInclusive/maxExclusive in plain date value space", async () => {
    const root = await importRoot(
      fieldSchema(
        "date",
        `<xs:minInclusive value="2002-01-01"/>
         <xs:maxExclusive value="2003-01-01"/>`,
      ),
    );
    expectValues(
      root,
      ["2002-01-01", "2002-06-15", "2002-12-31"],
      ["2001-12-31", "2003-01-01", "2003-06-01"],
    );
  });

  it("normalizes a timezone before comparing", async () => {
    const root = await importRoot(fieldSchema("date", `<xs:minInclusive value="2002-01-01Z"/>`));
    // 2001-12-31-14:00 is 2002-01-01T14:00Z, after the lower bound.
    expectValues(root, ["2002-01-01-14:00"], ["2001-12-31+14:00"]);
    // A timezone-less value within the ±14:00 window is indeterminate: the
    // partial order cannot establish that it is in range.
    expect(safeParseXml(root, doc("2002-01-01")).success).toBe(false);
  });

  it("accepts an in-range timezoned value against a floating boundary", async () => {
    const root = await importRoot(fieldSchema("date", `<xs:minInclusive value="2002-01-01"/>`));
    expect(safeParseXml(root, doc("2002-06-01Z")).success).toBe(true);
    expect(safeParseXml(root, doc("2002-01-01Z")).success).toBe(false);
  });

  it("emits the same refinements in structured mode and keeps objects", async () => {
    const root = await importRoot(
      fieldSchema("dateTime", `<xs:minInclusive value="2002-01-01T00:00:00Z"/>`),
      { datatypes: "structured" },
    );
    expect(safeParseXml(root, doc("2002-01-01T00:00:00Z")).success).toBe(true);
    expect(safeParseXml(root, doc("2001-12-31T23:59:59Z")).success).toBe(false);
    const parsed = parseXml(root, doc("2002-06-01T12:00:00Z")) as { v: unknown };
    expect(parsed.v).toEqual({
      year: 2002,
      month: 6,
      day: 1,
      hour: 12,
      minute: 0,
      second: 0,
      tzOffset: 0,
    });
  });
});

describe("duration order facets", () => {
  it("compares sub-second boundaries exactly", async () => {
    const root = await importRoot(
      fieldSchema(
        "duration",
        `<xs:minInclusive value="PT5.999999999S"/>
         <xs:maxInclusive value="PT6S"/>`,
      ),
    );
    expectValues(root, ["PT6S", "PT5.999999999S"], ["PT5S", "PT6.000000001S"]);
  });

  it("treats an indeterminate partial order as out of range", async () => {
    const root = await importRoot(fieldSchema("duration", `<xs:maxInclusive value="P30D"/>`));
    expectValues(root, ["P29D", "P30D"], ["P31D", "P1M"]);
  });
});

describe("string order facets", () => {
  it("compares by codepoint, not UTF-16 code unit", async () => {
    const root = await importRoot(
      fieldSchema(
        "string",
        `<xs:minInclusive value="\uE000"/>
         <xs:maxInclusive value="\u{10000}"/>`,
      ),
    );
    // U+10000 is greater than U+E000 as a codepoint, although its UTF-16
    // surrogate sorts before it.
    expectValues(root, ["\uE000", "\u{10000}"], ["\uD7FF", "\u{10001}"]);
  });

  it("applies the type's whiteSpace facet to the boundary", async () => {
    const root = await importRoot(fieldSchema("token", `<xs:minInclusive value="  b  "/>`));
    expectValues(root, ["b", "c"], ["a"]);
  });
});
