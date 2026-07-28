import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { irToZod, parseXml, parseXsd, safeParseXml, serializeXml } from "../src/index.js";
import {
  xsdBase64Binary,
  xsdDate,
  xsdDateTime,
  xsdDuration,
  xsdGDay,
  xsdGMonth,
  xsdGMonthDay,
  xsdGYear,
  xsdGYearMonth,
  xsdHexBinary,
  xsdLanguage,
  xsdName,
  xsdNCName,
  xsdNCNames,
  xsdNMTOKEN,
  xsdNMTOKENS,
  xsdTime,
} from "../src/xsdLexicals.js";
import { generateAndImport, withTempDir, withTempDirAsync } from "./helpers.js";

// Lexical checks for the XSD builtin datatypes in the zod tier: valid W3C
// lexicals pass, garbage is rejected, values stay strings.

const cases = (validator: (value: string) => boolean, valid: string[], invalid: string[]): void => {
  for (const value of valid) {
    expect(validator(value), `expected ${JSON.stringify(value)} to be valid`).toBe(true);
  }
  for (const value of invalid) {
    expect(validator(value), `expected ${JSON.stringify(value)} to be invalid`).toBe(false);
  }
};

describe("xsdLexicals validators", () => {
  it("xs:date", () => {
    cases(
      xsdDate,
      [
        "2002-10-10",
        "2002-10-10Z",
        "2002-10-10+05:00",
        "2002-10-10-05:00",
        "2002-10-10+14:00",
        "-2002-10-10",
        "12002-10-10",
        "2000-02-29",
        " 2002-10-10 ",
      ],
      [
        "2002-13-10",
        "2002-00-10",
        "2002-10-32",
        "2002-10-00",
        "2002-02-30",
        "2001-02-29",
        "1900-02-29",
        "0000-10-10",
        "2002-10-10+14:01",
        "2002-10-10+15:00",
        "2002-1-10",
        "2002-10-10T00:00:00",
        "",
        "abc",
      ],
    );
  });

  it("xs:dateTime", () => {
    cases(
      xsdDateTime,
      [
        "2002-10-10T12:00:00",
        "2002-10-10T12:00:00.5",
        "2002-10-10T12:00:00Z",
        "2002-10-10T12:00:00-05:00",
        "2002-10-10T12:00:00+14:00",
        "2002-10-10T24:00:00",
        "-2002-10-10T00:00:00",
      ],
      [
        "2002-13-45T99:99:99",
        "2002-10-10T25:00:00",
        "2002-10-10T24:00:01",
        "2002-10-10T24:00:00.1",
        "2002-10-10 12:00:00",
        "2002-02-30T00:00:00",
        "2002-10-10T12:00:00+15:00",
        "2002-10-10T12:00",
        "2002-10-10T12:00:60",
        "",
        "2002-10-10",
      ],
    );
  });

  it("xs:time", () => {
    cases(
      xsdTime,
      ["12:00:00", "24:00:00", "24:00:00.0", "23:59:59Z", "12:00:00.123+14:00", "00:00:00-14:00"],
      [
        "24:00:01",
        "25:00:00",
        "12:60:00",
        "12:00:60",
        "12:00",
        "12:00:00+14:01",
        "12:00:00.",
        "",
        "12:00:00+5:00",
      ],
    );
  });

  it("xs:duration", () => {
    cases(
      xsdDuration,
      [
        "P1Y",
        "-P1Y",
        "P1Y2M3DT4H5M6S",
        "PT0.5S",
        "P0D",
        "PT10H",
        "P1DT2H",
        "PT1M",
        "P1347M",
        "P1Y2D",
      ],
      ["P", "-P", "PT", "P1YT", "P1D2Y", "P1S", "1Y", "PT1Y", "P1Y2M3DT4H5M6", "P1.5Y", "", "P1X"],
    );
  });

  it("xs:gYear", () => {
    cases(
      xsdGYear,
      ["2002", "-2002", "2002Z", "12002", " 2002 "],
      ["0000", "02", "2002-10", "2002Z2", ""],
    );
  });

  it("xs:gYearMonth", () => {
    cases(
      xsdGYearMonth,
      ["2002-10", "-2002-10", "2002-10+05:00"],
      ["0000-10", "2002-13", "2002-00", "2002", ""],
    );
  });

  it("xs:gMonth", () => {
    cases(xsdGMonth, ["--10", "--01Z", "--12+05:00"], ["--13", "--00", "-10", "--1", ""]);
  });

  it("xs:gMonthDay", () => {
    cases(
      xsdGMonthDay,
      ["--10-10", "--02-29", "--12-31Z"],
      ["--02-30", "--11-31", "--1-10", "--10-1", "--13-01", ""],
    );
  });

  it("xs:gDay", () => {
    cases(xsdGDay, ["---01", "---31", "---10Z"], ["---00", "---32", "--10", "---1", ""]);
  });

  it("xs:hexBinary", () => {
    cases(xsdHexBinary, ["", "AB", "ab12", "0FB7", " ab12 "], ["ABC", "A", "ZZ", "AB CD", "0x12"]);
  });

  it("xs:base64Binary", () => {
    cases(
      xsdBase64Binary,
      ["", "QUJD", "QUJDRA==", "QUJD RA==", " Q U J D "],
      ["QUJD=", "QUJDRA=", "QUJD==", "QUJ", "QUJD====", "QUJ$", "===="],
    );
  });

  it("xs:language", () => {
    cases(
      xsdLanguage,
      ["en", "e", "en-US", "de-CH-1901", "i-klingon", "x-private"],
      ["en-", "en_US", "123", "toolonglang", "en--US", ""],
    );
  });

  it("xs:Name", () => {
    cases(
      xsdName,
      ["foo", ":foo", "a.b-c_d", "élan", "_x"],
      ["1foo", "-foo", ".foo", "fo o", "", "foo bar"],
    );
  });

  it("xs:NCName (also ID/IDREF/ENTITY)", () => {
    cases(xsdNCName, ["foo", "foo.bar", "é-1"], ["foo:bar", ":foo", "1foo", "fo o", ""]);
  });

  it("xs:NMTOKEN", () => {
    cases(xsdNMTOKEN, ["foo", "1foo", ".", "-", "a:b", "12.5"], ["", "a b", "a?b"]);
  });

  it("xs:NMTOKENS", () => {
    cases(xsdNMTOKENS, ["foo", "foo bar", "foo  bar", " a b "], ["", "  ", "a?b", "a b?"]);
  });

  it("xs:IDREFS / xs:ENTITIES (NCName list)", () => {
    cases(xsdNCNames, ["a", "a b.c", " a  b "], ["", "  ", "a b:c", ":a", "a 1b"]);
  });
});

const codeFor = (xsd: string): string => {
  let code = "";
  withTempDir((dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    code = irToZod(parseXsd([file])).schemas;
  });
  return code;
};

describe("builtin lexical codegen", () => {
  it("emits a refine per covered builtin and imports only the used helpers", () => {
    const code = codeFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="when" type="xs:dateTime"/>
        <xs:element name="span" type="xs:duration"/>
      </xs:sequence>
      <xs:attribute name="id" type="xs:ID"/>
    </xs:complexType>
  </xs:element>
</xs:schema>`);
    expect(code).toContain(`.refine(xsdDateTime, { message: 'invalid xs:dateTime lexical' })`);
    expect(code).toContain(`.refine(xsdDuration, { message: 'invalid xs:duration lexical' })`);
    expect(code).toContain(`.refine(xsdNCName, { message: 'invalid xs:ID lexical' })`);
    expect(code).toContain(
      "import { xmlRegistry, xsdDateTime, xsdDuration, xsdNCName } from 'xsd-to-zod';",
    );
    expect(code).not.toContain("xsdDate,");
    expect(code).not.toContain("xsdTime");
  });

  it("emits value-space bounds for bounded integer builtins", () => {
    const code = codeFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="b" type="xs:byte"/>
        <xs:element name="n" type="xs:nonNegativeInteger"/>
        <xs:element name="l" type="xs:long"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`);
    expect(code).toContain('"b": z.number().int().min(-128).max(127)');
    // Arbitrary-precision and 64-bit integers map to bigint; long's bounds
    // exceed MAX_SAFE_INTEGER, so they are expressed as bigint literals.
    expect(code).toContain('"n": z.bigint().min(0n)');
    expect(code).toContain('"l": z.bigint().min(-9223372036854775808n).max(9223372036854775807n)');
  });

  it("keeps token/normalizedString/anyURI as plain strings (vacuous lexical space)", () => {
    const code = codeFor(`<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="t" type="xs:token"/>
        <xs:element name="n" type="xs:normalizedString"/>
        <xs:element name="u" type="xs:anyURI"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`);
    expect(code).toContain('"t": z.string(),');
    expect(code).toContain('"n": z.string(),');
    expect(code).toContain('"u": z.string()}');
    expect(code).not.toContain(".refine(");
  });
});

describe("parseXml lexical validation", () => {
  const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="when" type="xs:dateTime"/>
        <xs:element name="span" type="xs:duration"/>
        <xs:element name="b" type="xs:byte"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

  const importRoot = async (): Promise<z.ZodType> => {
    let root: z.ZodType | undefined;
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, XSD);
      const mod = await generateAndImport([file]);
      root = Object.values(mod).find(
        (v): v is z.ZodType => v !== null && typeof v === "object" && "_zod" in v,
      );
    });
    if (root === undefined) {
      throw new Error("no root schema generated");
    }
    return root;
  };

  it("accepts valid lexicals and preserves the original strings", async () => {
    const root = await importRoot();
    const xml = "<root><when>2002-10-10T12:00:00-05:00</when><span>-P1Y</span><b>-128</b></root>";
    const parsed = parseXml(root, xml) as Record<string, unknown>;
    expect(parsed).toEqual({
      when: "2002-10-10T12:00:00-05:00",
      span: "-P1Y",
      b: -128,
    });
    // Round-trip: serialization keeps the lexical, re-parsing is stable.
    const serialized = serializeXml(root, parsed);
    expect(parseXml(root, serialized)).toEqual(parsed);
  });

  it("rejects invalid lexicals", async () => {
    const root = await importRoot();
    const doc = (when: string, span: string, b: string) =>
      `<root><when>${when}</when><span>${span}</span><b>${b}</b></root>`;
    for (const xml of [
      doc("2002-13-45T99:99:99", "P1Y", "0"),
      doc("2002-10-10T12:00:00", "PT", "0"),
      doc("2002-10-10T12:00:00", "P1Y", "128"),
      doc("2002-10-10T12:00:00", "P1Y", "-129"),
    ]) {
      expect(safeParseXml(root, xml).success, `expected rejection: ${xml}`).toBe(false);
    }
  });
});

describe("bigint integer types", () => {
  const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="i" type="xs:integer"/>
        <xs:element name="l" type="xs:long"/>
        <xs:element name="ul" type="xs:unsignedLong"/>
        <xs:element name="n" type="xs:int"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

  const importRoot = async (): Promise<z.ZodType> => {
    let root: z.ZodType | undefined;
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "schema.xsd");
      fs.writeFileSync(file, XSD);
      const mod = await generateAndImport([file]);
      root = Object.values(mod).find(
        (v): v is z.ZodType => v !== null && typeof v === "object" && "_zod" in v,
      );
    });
    if (root === undefined) {
      throw new Error("no root schema generated");
    }
    return root;
  };

  const doc = (i: string, l: string, ul: string, n: string) =>
    `<root><i>${i}</i><l>${l}</l><ul>${ul}</ul><n>${n}</n></root>`;

  it("parses values beyond MAX_SAFE_INTEGER without precision loss", async () => {
    const root = await importRoot();
    const parsed = parseXml(
      root,
      doc("123456789012345678901234567890", "9223372036854775807", "18446744073709551615", "42"),
    ) as Record<string, unknown>;
    expect(parsed).toEqual({
      i: 123456789012345678901234567890n,
      l: 9223372036854775807n,
      ul: 18446744073709551615n,
      n: 42,
    });
    // Round-trip: the canonical lexical survives serialization intact.
    const serialized = serializeXml(root, parsed);
    expect(serialized).toContain("<i>123456789012345678901234567890</i>");
    expect(parseXml(root, serialized)).toEqual(parsed);
  });

  it("enforces the 64-bit long/unsignedLong bounds exactly", async () => {
    const root = await importRoot();
    expect(
      safeParseXml(root, doc("0", "-9223372036854775808", "0", "0")).success,
      "long min is valid",
    ).toBe(true);
    for (const xml of [
      doc("0", "9223372036854775808", "0", "0"),
      doc("0", "-9223372036854775809", "0", "0"),
      doc("0", "0", "18446744073709551616", "0"),
      doc("0", "0", "-1", "0"),
    ]) {
      expect(safeParseXml(root, xml).success, `expected rejection: ${xml}`).toBe(false);
    }
  });

  it("rejects non-integer lexicals for bigint types", async () => {
    const root = await importRoot();
    for (const bad of ["1.5", "1e3", "NaN", "INF", ""]) {
      expect(safeParseXml(root, doc(bad, "0", "0", "0")).success, bad).toBe(false);
    }
  });

  it("accepts signed lexicals and normalizes to the numeric value", async () => {
    const root = await importRoot();
    const parsed = parseXml(root, doc("+007", "-0", "0", "+5")) as Record<string, unknown>;
    expect(parsed).toEqual({ i: 7n, l: 0n, ul: 0n, n: 5 });
  });
});
