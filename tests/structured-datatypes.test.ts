import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { irToZod, parseXml, parseXsd, serializeXml, xmlRegistry } from "../src/index.js";
import {
  parseXsdDate,
  parseXsdDateTime,
  parseXsdDuration,
  parseXsdGDay,
  parseXsdGMonth,
  parseXsdGMonthDay,
  parseXsdGYear,
  parseXsdGYearMonth,
  parseXsdTime,
  writeXsdDate,
  writeXsdDateTime,
  writeXsdDuration,
  writeXsdGDay,
  writeXsdGMonth,
  writeXsdGMonthDay,
  writeXsdGYear,
  writeXsdGYearMonth,
  writeXsdTime,
  type XsdStructuredValue,
} from "../src/xsdDateTime.js";
import { importGeneratedSchemas, withTempDirAsync } from "./helpers.js";

// Structured parsing of the XSD date/time builtins (datatypes: "structured"):
// parsers normalize to the value space (UTC when a timezone is present),
// writers emit the XSD 1.0 canonical lexical form, and the generated schemas
// transform after the lexical refine.

const fixedPoint = <T extends XsdStructuredValue>(
  parse: (value: string) => T,
  write: (value: T) => string,
  lexical: string,
): T => {
  const value = parse(lexical);
  // parse(write(parse(x))) deep-equals parse(x), however non-canonical x was.
  expect(parse(write(value))).toEqual(value);
  return value;
};

describe("xsdDateTime parsers and canonical writers", () => {
  it("xs:date", () => {
    expect(fixedPoint(parseXsdDate, writeXsdDate, "2002-10-10")).toEqual({
      year: 2002,
      month: 10,
      day: 10,
    });
    // A present timezone anchors the interval in UTC (tzOffset: 0).
    expect(fixedPoint(parseXsdDate, writeXsdDate, "2002-10-10+05:00")).toEqual({
      year: 2002,
      month: 10,
      day: 9,
      tzOffset: 0,
    });
    expect(writeXsdDate(parseXsdDate("2002-10-10+05:00"))).toBe("2002-10-09Z");
    expect(fixedPoint(parseXsdDate, writeXsdDate, "2002-10-10-05:00")).toEqual({
      year: 2002,
      month: 10,
      day: 10,
      tzOffset: 0,
    });
    // Z, +00:00 and -00:00 collapse to the same UTC anchor.
    for (const tz of ["Z", "+00:00", "-00:00"]) {
      expect(parseXsdDate(`2002-10-10${tz}`)).toEqual({
        year: 2002,
        month: 10,
        day: 10,
        tzOffset: 0,
      });
    }
    expect(fixedPoint(parseXsdDate, writeXsdDate, "-2002-10-10")).toEqual({
      year: -2002,
      month: 10,
      day: 10,
    });
    expect(writeXsdDate(parseXsdDate("-2002-10-10"))).toBe("-2002-10-10");
    expect(fixedPoint(parseXsdDate, writeXsdDate, "12002-02-29")).toEqual({
      year: 12002,
      month: 2,
      day: 29,
    });
    expect(fixedPoint(parseXsdDate, writeXsdDate, "2000-02-29").day).toBe(29);
    // No year zero: shifting 0001-01-01T00:00+00:30 to UTC lands in year -1.
    expect(writeXsdDate(parseXsdDate("0001-01-01+00:30"))).toBe("-0001-12-31Z");
    expect(fixedPoint(parseXsdDate, writeXsdDate, " 2002-10-10 ")).toEqual({
      year: 2002,
      month: 10,
      day: 10,
    });
  });

  it("xs:dateTime", () => {
    expect(fixedPoint(parseXsdDateTime, writeXsdDateTime, "2002-10-10T12:00:00")).toEqual({
      year: 2002,
      month: 10,
      day: 10,
      hour: 12,
      minute: 0,
      second: 0,
    });
    // The canonical example from XSD 1.0 Part 2: -05:00 → UTC with Z.
    expect(writeXsdDateTime(parseXsdDateTime("2002-10-10T12:00:00-05:00"))).toBe(
      "2002-10-10T17:00:00Z",
    );
    expect(writeXsdDateTime(parseXsdDateTime("2002-10-10T00:00:00+14:00"))).toBe(
      "2002-10-09T10:00:00Z",
    );
    // 24:00:00 is midnight at the start of the next day.
    expect(fixedPoint(parseXsdDateTime, writeXsdDateTime, "2002-10-10T24:00:00")).toEqual({
      year: 2002,
      month: 10,
      day: 11,
      hour: 0,
      minute: 0,
      second: 0,
    });
    // Fractional seconds lose trailing zeros, drop entirely when zero.
    expect(writeXsdDateTime(parseXsdDateTime("2002-10-10T12:00:00.5000"))).toBe(
      "2002-10-10T12:00:00.5",
    );
    expect(writeXsdDateTime(parseXsdDateTime("2002-10-10T24:00:00.0"))).toBe("2002-10-11T00:00:00");
    expect(fixedPoint(parseXsdDateTime, writeXsdDateTime, "-2002-10-10T12:00:00Z").year).toBe(
      -2002,
    );
  });

  it("xs:time", () => {
    expect(fixedPoint(parseXsdTime, writeXsdTime, "13:20:00")).toEqual({
      hour: 13,
      minute: 20,
      second: 0,
    });
    // The canonical example from XSD 1.0 Part 2.
    expect(writeXsdTime(parseXsdTime("12:00:00-05:00"))).toBe("17:00:00Z");
    // Wraps within the day.
    expect(writeXsdTime(parseXsdTime("00:30:00+01:00"))).toBe("23:30:00Z");
    // 24:00:00 is the same value as 00:00:00; canonical midnight is 00:00:00.
    expect(fixedPoint(parseXsdTime, writeXsdTime, "24:00:00")).toEqual({
      hour: 0,
      minute: 0,
      second: 0,
    });
    expect(writeXsdTime(parseXsdTime("24:00:00Z"))).toBe("00:00:00Z");
    expect(writeXsdTime(parseXsdTime("13:20:00.5000Z"))).toBe("13:20:00.5Z");
    expect(fixedPoint(parseXsdTime, writeXsdTime, "13:20:00.123456789")).toEqual({
      hour: 13,
      minute: 20,
      second: 0,
      fraction: "123456789",
    });
  });

  it("xs:gYear / xs:gYearMonth", () => {
    expect(fixedPoint(parseXsdGYear, writeXsdGYear, "2002")).toEqual({ year: 2002 });
    expect(writeXsdGYear(parseXsdGYear("2002+05:00"))).toBe("2001Z");
    expect(fixedPoint(parseXsdGYear, writeXsdGYear, "-2002")).toEqual({ year: -2002 });
    expect(fixedPoint(parseXsdGYearMonth, writeXsdGYearMonth, "2002-10")).toEqual({
      year: 2002,
      month: 10,
    });
    expect(writeXsdGYearMonth(parseXsdGYearMonth("2002-10+05:00"))).toBe("2002-09Z");
    expect(writeXsdGYearMonth(parseXsdGYearMonth("2002-01-14:00"))).toBe("2002-01Z");
  });

  it("xs:gMonth / xs:gMonthDay / xs:gDay", () => {
    expect(fixedPoint(parseXsdGMonth, writeXsdGMonth, "--05")).toEqual({ month: 5 });
    expect(writeXsdGMonth(parseXsdGMonth("--05Z"))).toBe("--05Z");
    expect(fixedPoint(parseXsdGMonthDay, writeXsdGMonthDay, "--02-29")).toEqual({
      month: 2,
      day: 29,
    });
    expect(writeXsdGMonthDay(parseXsdGMonthDay("--05-01+14:00"))).toBe("--04-30Z");
    expect(fixedPoint(parseXsdGDay, writeXsdGDay, "---31")).toEqual({ day: 31 });
    expect(writeXsdGDay(parseXsdGDay("---01+14:00"))).toBe("---31Z");
  });

  it("xs:duration", () => {
    expect(fixedPoint(parseXsdDuration, writeXsdDuration, "P1Y2M3DT4H5M6S")).toEqual({
      sign: 1,
      years: 1,
      months: 2,
      days: 3,
      hours: 4,
      minutes: 5,
      seconds: 6,
    });
    expect(writeXsdDuration(parseXsdDuration("-P1Y2M3DT4H5M6.700S"))).toBe("-P1Y2M3DT4H5M6.7S");
    // Zero components drop; an all-zero duration canonicalizes to PT0S with a
    // positive sign (negative zero is the same value).
    expect(writeXsdDuration(parseXsdDuration("P1Y0M"))).toBe("P1Y");
    expect(fixedPoint(parseXsdDuration, writeXsdDuration, "-PT0S")).toEqual({ sign: 1 });
    expect(writeXsdDuration(parseXsdDuration("-P0D"))).toBe("PT0S");
    expect(fixedPoint(parseXsdDuration, writeXsdDuration, "PT10S")).toEqual({
      sign: 1,
      seconds: 10,
    });
    expect(fixedPoint(parseXsdDuration, writeXsdDuration, "P3D")).toEqual({ sign: 1, days: 3 });
    expect(writeXsdDuration(parseXsdDuration("P1YT2H"))).toBe("P1YT2H");
  });

  it("rejects lexicals outside the expected shape", () => {
    // The parsers assume prior lexical validation (the refine runs first) and
    // only fail on input outside the regex shape altogether.
    expect(() => parseXsdDate("2002-13-10")).toThrow();
    expect(() => parseXsdDateTime("2002-10-10")).toThrow();
    expect(() => parseXsdTime("12:00")).toThrow();
    expect(() => parseXsdDuration("X1Y")).toThrow();
  });
});

const ALL_TYPES_XSD = `
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="event" type="Event"/>
  <xs:complexType name="Event">
    <xs:sequence>
      <xs:element name="date" type="xs:date"/>
      <xs:element name="stamp" type="xs:dateTime" minOccurs="0"/>
      <xs:element name="at" type="xs:time"/>
      <xs:element name="year" type="xs:gYear"/>
      <xs:element name="yearMonth" type="xs:gYearMonth"/>
      <xs:element name="month" type="xs:gMonth"/>
      <xs:element name="monthDay" type="xs:gMonthDay"/>
      <xs:element name="day" type="xs:gDay"/>
      <xs:element name="span" type="xs:duration"/>
      <xs:element name="tags" type="DateList" minOccurs="0"/>
    </xs:sequence>
    <xs:attribute name="kind" type="DateEnum"/>
  </xs:complexType>
  <xs:simpleType name="DateList"><xs:list itemType="xs:date"/></xs:simpleType>
  <xs:simpleType name="DateEnum">
    <xs:restriction base="xs:date">
      <xs:enumeration value="2002-10-10"/>
      <xs:enumeration value="2002-10-11+00:00"/>
    </xs:restriction>
  </xs:simpleType>
</xs:schema>`;

const withXsd = async (xsd: string, fn: (file: string) => void | Promise<void>): Promise<void> =>
  withTempDirAsync(async (dir) => {
    const file = path.join(dir, "schema.xsd");
    fs.writeFileSync(file, xsd);
    await fn(file);
  });

describe("datatypes: structured codegen", () => {
  it("emits transforms, structured TS types and datatype metadata", async () => {
    await withXsd(ALL_TYPES_XSD, (file) => {
      const { schemas } = irToZod(parseXsd([file]), { datatypes: "structured" });
      // Transform pipeline after the lexical refine, for all nine builtins.
      for (const [validator, parser] of [
        ["xsdDate", "parseXsdDate"],
        ["xsdDateTime", "parseXsdDateTime"],
        ["xsdTime", "parseXsdTime"],
        ["xsdGYear", "parseXsdGYear"],
        ["xsdGYearMonth", "parseXsdGYearMonth"],
        ["xsdGMonth", "parseXsdGMonth"],
        ["xsdGMonthDay", "parseXsdGMonthDay"],
        ["xsdGDay", "parseXsdGDay"],
        ["xsdDuration", "parseXsdDuration"],
      ]) {
        expect(schemas).toContain(`.refine(${validator},`);
        expect(schemas).toContain(`.transform(${parser})`);
      }
      // Structured TS types imported and used in the interface.
      expect(schemas).toContain("import type { XsdDate, XsdDateTime, XsdDuration");
      expect(schemas).toContain('"date": XsdDate;');
      expect(schemas).toContain('"tags"?: XsdDate[] | undefined;');
      // Datatype metadata for the serializer, per field.
      expect(schemas).toContain('"date": { kind: "element", qname: "{}date", datatype: "date" }');
      expect(schemas).toContain(
        '"@kind": { kind: "attribute", qname: "{}kind", datatype: "date" }',
      );
      // Enum values canonicalize at codegen time (+00:00 → Z).
      expect(schemas).toContain('["2002-10-10", "2002-10-11Z"].includes(writeXsdDate(val))');
    });
  });

  it("leaves default (string) mode output unchanged", async () => {
    await withXsd(ALL_TYPES_XSD, (file) => {
      const ir = parseXsd([file]);
      const structured = irToZod(ir, { datatypes: "structured" }).schemas;
      const plain = irToZod(ir).schemas;
      const explicit = irToZod(ir, { datatypes: "string" }).schemas;
      expect(explicit).toBe(plain);
      expect(plain).not.toContain(".transform(parseXsd");
      expect(plain).not.toContain("datatype:");
      expect(structured).not.toBe(plain);
    });
  });

  it("emits object literals for fixed/default values and datatype meta", async () => {
    await withXsd(
      `
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="cfg" type="Cfg"/>
  <xs:complexType name="Cfg">
    <xs:sequence>
      <xs:element name="start" type="xs:date" default="2002-10-10"/>
      <xs:element name="epoch" type="xs:dateTime" fixed="2002-10-10T12:00:00-05:00"/>
    </xs:sequence>
    <xs:attribute name="tz" type="xs:time" default="12:00:00-05:00"/>
  </xs:complexType>
</xs:schema>`,
      (file) => {
        const { schemas } = irToZod(parseXsd([file]), { datatypes: "structured" });
        // Meta defaults/fixed hold the lexical (validation transforms it);
        // attribute defaults are zod .default() of the structured object.
        expect(schemas).toContain('defaultValue: "2002-10-10"');
        expect(schemas).toContain('fixedValue: "2002-10-10T12:00:00-05:00"');
        expect(schemas).toContain('.default({"hour":17,"minute":0,"second":0,"tzOffset":0})');
        // Fixed is a canonical-lexical refine, not a z.literal of an object.
        expect(schemas).toContain('writeXsdDateTime(val) === "2002-10-10T17:00:00Z"');
      },
    );
  });

  it("emits structured object literals for xs:list attribute defaults", async () => {
    await withXsd(
      `
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="cfg" type="Cfg"/>
  <xs:complexType name="Cfg">
    <xs:attribute name="days" default="2002-10-10 2003-11-11">
      <xs:simpleType>
        <xs:list itemType="xs:date"/>
      </xs:simpleType>
    </xs:attribute>
  </xs:complexType>
</xs:schema>`,
      (file) => {
        const { schemas } = irToZod(parseXsd([file]), { datatypes: "structured" });
        // Each list token becomes a structured object literal in the array.
        expect(schemas).toContain(
          '.default([{"year":2002,"month":10,"day":10}, {"year":2003,"month":11,"day":11}])',
        );
      },
    );
  });
});

describe("datatypes: structured runtime round-trip", () => {
  it("parses to structured values and serializes to canonical lexicals", async () => {
    await withXsd(ALL_TYPES_XSD, async (file) => {
      const { schemas } = irToZod(parseXsd([file]), { datatypes: "structured" });
      const mod = await importGeneratedSchemas(schemas);
      const schema = mod["eventSchema"] as z.ZodType;
      expect(xmlRegistry.get(schema)?.root).toBe("{}event");

      const xml =
        '<event kind="2002-10-10"><date>2002-10-10+05:00</date><stamp>2002-10-10T12:00:00-05:00</stamp>' +
        "<at>24:00:00</at><year>2002</year><yearMonth>2002-10Z</yearMonth><month>--05</month>" +
        "<monthDay>--02-29</monthDay><day>---31</day><span>P1Y2M3DT4H5M6.700S</span>" +
        "<tags>2002-10-10 2003-11-11Z</tags></event>";
      const parsed = parseXml(schema, xml);
      expect(parsed).toEqual({
        date: { year: 2002, month: 10, day: 9, tzOffset: 0 },
        stamp: { year: 2002, month: 10, day: 10, hour: 17, minute: 0, second: 0, tzOffset: 0 },
        at: { hour: 0, minute: 0, second: 0 },
        year: { year: 2002 },
        yearMonth: { year: 2002, month: 10, tzOffset: 0 },
        month: { month: 5 },
        monthDay: { month: 2, day: 29 },
        day: { day: 31 },
        span: {
          sign: 1,
          years: 1,
          months: 2,
          days: 3,
          hours: 4,
          minutes: 5,
          seconds: 6,
          fraction: "7",
        },
        tags: [
          { year: 2002, month: 10, day: 10 },
          { year: 2003, month: 11, day: 11, tzOffset: 0 },
        ],
        "@kind": { year: 2002, month: 10, day: 10 },
      });

      const serialized = serializeXml(schema, parsed);
      expect(serialized).toBe(
        '<event kind="2002-10-10"><date>2002-10-09Z</date><stamp>2002-10-10T17:00:00Z</stamp>' +
          "<at>00:00:00</at><year>2002</year><yearMonth>2002-10Z</yearMonth><month>--05</month>" +
          "<monthDay>--02-29</monthDay><day>---31</day><span>P1Y2M3DT4H5M6.7S</span>" +
          "<tags>2002-10-10 2003-11-11Z</tags></event>",
      );
      // Fixed point through the full pipeline.
      expect(parseXml(schema, serialized)).toEqual(parsed);
    });
  });

  it("passes plain strings through the serializer unchanged", async () => {
    await withXsd(ALL_TYPES_XSD, async (file) => {
      const { schemas } = irToZod(parseXsd([file]), { datatypes: "structured" });
      const mod = await importGeneratedSchemas(schemas);
      const schema = mod["eventSchema"] as z.ZodType;
      const data = {
        date: "2002-10-10+05:00",
        at: "24:00:00",
        year: { year: 2002 },
        yearMonth: "2002-10",
        month: { month: 5 },
        monthDay: { month: 2, day: 29 },
        day: { day: 31 },
        span: "P1Y",
      };
      const serialized = serializeXml(schema, data);
      expect(serialized).toContain("<date>2002-10-10+05:00</date>");
      expect(serialized).toContain("<at>24:00:00</at>");
      expect(serialized).toContain("<yearMonth>2002-10</yearMonth>");
      expect(serialized).toContain("<span>P1Y</span>");
      expect(serialized).toContain("<year>2002</year>");
    });
  });

  it("substitutes structured fixed/default values with XSD semantics", async () => {
    await withXsd(
      `
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="cfg" type="Cfg"/>
  <xs:complexType name="Cfg">
    <xs:sequence>
      <xs:element name="start" type="xs:date" default="2002-10-10"/>
      <xs:element name="epoch" type="xs:dateTime" fixed="2002-10-10T12:00:00-05:00"/>
    </xs:sequence>
    <xs:attribute name="tz" type="xs:time" default="12:00:00-05:00"/>
  </xs:complexType>
</xs:schema>`,
      async (file) => {
        const { schemas } = irToZod(parseXsd([file]), { datatypes: "structured" });
        const mod = await importGeneratedSchemas(schemas);
        const schema = mod["cfgSchema"] as z.ZodType;
        // Element default on present-but-empty, fixed on the fixed element,
        // attribute default on absence — all arrive as structured values.
        const parsed = parseXml(schema, "<cfg><start/><epoch>2002-10-10T17:00:00Z</epoch></cfg>");
        expect(parsed).toEqual({
          start: { year: 2002, month: 10, day: 10 },
          epoch: { year: 2002, month: 10, day: 10, hour: 17, minute: 0, second: 0, tzOffset: 0 },
          "@tz": { hour: 17, minute: 0, second: 0, tzOffset: 0 },
        });
        expect(parseXml(schema, serializeXml(schema, parsed))).toEqual(parsed);
        // A value other than the fixed one is rejected (canonical refine).
        expect(() => parseXml(schema, "<cfg><epoch>2003-01-01T00:00:00Z</epoch></cfg>")).toThrow();
      },
    );
  });

  it("applies a structured xs:list attribute default as an array of values", async () => {
    await withXsd(
      `
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="cfg" type="Cfg"/>
  <xs:complexType name="Cfg">
    <xs:attribute name="days" default="2002-10-10 2003-11-11">
      <xs:simpleType>
        <xs:list itemType="xs:date"/>
      </xs:simpleType>
    </xs:attribute>
  </xs:complexType>
</xs:schema>`,
      async (file) => {
        const { schemas } = irToZod(parseXsd([file]), { datatypes: "structured" });
        const mod = await importGeneratedSchemas(schemas);
        const schema = mod["cfgSchema"] as z.ZodType;
        const parsed = parseXml(schema, "<cfg/>");
        expect(parsed).toEqual({
          "@days": [
            { year: 2002, month: 10, day: 10 },
            { year: 2003, month: 11, day: 11 },
          ],
        });
        expect(parseXml(schema, serializeXml(schema, parsed))).toEqual(parsed);
      },
    );
  });

  it("applies a structured xs:list attribute fixed value as an array of values", async () => {
    await withXsd(
      `
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="cfg" type="Cfg"/>
  <xs:complexType name="Cfg">
    <xs:attribute name="days" fixed="2002-10-10 2003-11-11">
      <xs:simpleType>
        <xs:list itemType="xs:date"/>
      </xs:simpleType>
    </xs:attribute>
  </xs:complexType>
</xs:schema>`,
      async (file) => {
        const { schemas } = irToZod(parseXsd([file]), { datatypes: "structured" });
        const mod = await importGeneratedSchemas(schemas);
        const schema = mod["cfgSchema"] as z.ZodType;
        // Fixed applies on absence too, as structured values.
        const parsed = parseXml(schema, "<cfg/>");
        expect(parsed).toEqual({
          "@days": [
            { year: 2002, month: 10, day: 10 },
            { year: 2003, month: 11, day: 11 },
          ],
        });
        expect(parseXml(schema, serializeXml(schema, parsed))).toEqual(parsed);
        // A value other than the fixed one is rejected (canonical refine).
        expect(() => parseXml(schema, '<cfg days="2001-01-01"/>')).toThrow();
      },
    );
  });

  it("substitutes a fixed xs:list of primitive items on absence", async () => {
    await withXsd(
      `
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="cfg" type="Cfg"/>
  <xs:complexType name="Cfg">
    <xs:attribute name="dims" fixed="1 2">
      <xs:simpleType>
        <xs:list itemType="xs:int"/>
      </xs:simpleType>
    </xs:attribute>
  </xs:complexType>
</xs:schema>`,
      async (file) => {
        const { schemas } = irToZod(parseXsd([file]), { datatypes: "structured" });
        const mod = await importGeneratedSchemas(schemas);
        const schema = (mod as { cfgSchema: z.ZodType }).cfgSchema;
        const parsed = parseXml(schema, "<cfg/>");
        expect(parsed).toEqual({ "@dims": [1, 2] });
        expect(parseXml(schema, '<cfg dims="1 2"/>')).toEqual({ "@dims": [1, 2] });
        expect(() => parseXml(schema, '<cfg dims="3 4"/>')).toThrow();
        expect(parseXml(schema, serializeXml(schema, parsed))).toEqual(parsed);
      },
    );
  });

  it("substitutes an empty fixed xs:list of dates on absence", async () => {
    await withXsd(
      `
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="cfg" type="Cfg"/>
  <xs:complexType name="Cfg">
    <xs:attribute name="days" fixed="">
      <xs:simpleType>
        <xs:list itemType="xs:date"/>
      </xs:simpleType>
    </xs:attribute>
  </xs:complexType>
</xs:schema>`,
      async (file) => {
        const { schemas } = irToZod(parseXsd([file]), { datatypes: "structured" });
        const mod = await importGeneratedSchemas(schemas);
        const schema = (mod as { cfgSchema: z.ZodType }).cfgSchema;
        expect(parseXml(schema, "<cfg/>")).toEqual({ "@days": [] });
        expect(parseXml(schema, '<cfg days=""/>')).toEqual({ "@days": [] });
        expect(() => parseXml(schema, '<cfg days="2001-01-01"/>')).toThrow();
        expect(parseXml(schema, serializeXml(schema, { "@days": [] }))).toEqual({ "@days": [] });
      },
    );
  });

  it("rejects invalid lexicals through the generated schema", async () => {
    await withXsd(ALL_TYPES_XSD, async (file) => {
      const { schemas } = irToZod(parseXsd([file]), { datatypes: "structured" });
      const mod = await importGeneratedSchemas(schemas);
      const schema = mod["eventSchema"] as z.ZodType;
      const xml =
        "<event><date>2002-13-10</date><at>00:00:00</at><year>2002</year><yearMonth>2002-10</yearMonth>" +
        "<month>--05</month><monthDay>--02-29</monthDay><day>---31</day><span>P1Y</span></event>";
      expect(() => parseXml(schema, xml)).toThrow();
    });
  });
});
