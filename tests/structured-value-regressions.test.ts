import { describe, expect, it } from "vitest";
import { validateXml } from "../src/validate.js";
import { xsdOrderCompare } from "../src/xsdChecks.js";
import {
  parseXsdDate,
  parseXsdGDay,
  parseXsdGMonth,
  parseXsdGMonthDay,
  parseXsdGYear,
  parseXsdGYearMonth,
  writeXsdDate,
  writeXsdGDay,
  writeXsdGMonth,
  writeXsdGMonthDay,
  writeXsdGYear,
  writeXsdGYearMonth,
  type XsdStructuredValue,
} from "../src/xsdDateTime.js";

const roundTrip = <T extends XsdStructuredValue>(
  parse: (value: string) => T,
  write: (value: T) => string,
  lexical: string,
  expected: T,
): void => {
  const value = parse(lexical);
  expect(value).toEqual(expected);
  // The writer keeps the local calendar fields and emits the actual offset,
  // so the XSD value survives the round trip.
  expect(write(value)).toBe(lexical);
  expect(parse(write(value))).toEqual(value);
};

describe("structured partial-date values keep local components and offsets", () => {
  it("xs:date no longer shifts 2000-01-01+05:00 to the previous day", () => {
    roundTrip(parseXsdDate, writeXsdDate, "2000-01-01+05:00", {
      year: 2000,
      month: 1,
      day: 1,
      tzOffset: 300,
    });
  });

  it("xs:date round-trips positive, negative and extreme offsets", () => {
    roundTrip(parseXsdDate, writeXsdDate, "2000-01-01-05:00", {
      year: 2000,
      month: 1,
      day: 1,
      tzOffset: -300,
    });
    roundTrip(parseXsdDate, writeXsdDate, "2000-12-31+14:00", {
      year: 2000,
      month: 12,
      day: 31,
      tzOffset: 840,
    });
    roundTrip(parseXsdDate, writeXsdDate, "2000-01-01-14:00", {
      year: 2000,
      month: 1,
      day: 1,
      tzOffset: -840,
    });
    roundTrip(parseXsdDate, writeXsdDate, "-2002-10-10+05:00", {
      year: -2002,
      month: 10,
      day: 10,
      tzOffset: 300,
    });
  });

  it("xs:date canonicalizes zero offsets to Z and leaves floating values alone", () => {
    for (const lexical of ["2000-01-01Z", "2000-01-01+00:00", "2000-01-01-00:00"]) {
      const value = parseXsdDate(lexical);
      expect(value).toEqual({ year: 2000, month: 1, day: 1, tzOffset: 0 });
      expect(writeXsdDate(value)).toBe("2000-01-01Z");
    }
    roundTrip(parseXsdDate, writeXsdDate, "2000-01-01", {
      year: 2000,
      month: 1,
      day: 1,
    });
  });

  it("xs:gYear", () => {
    roundTrip(parseXsdGYear, writeXsdGYear, "2002+05:00", { year: 2002, tzOffset: 300 });
    roundTrip(parseXsdGYear, writeXsdGYear, "2002-05:00", { year: 2002, tzOffset: -300 });
    roundTrip(parseXsdGYear, writeXsdGYear, "2002+14:00", { year: 2002, tzOffset: 840 });
    roundTrip(parseXsdGYear, writeXsdGYear, "-2002+05:00", { year: -2002, tzOffset: 300 });
  });

  it("xs:gYearMonth", () => {
    roundTrip(parseXsdGYearMonth, writeXsdGYearMonth, "2002-10+05:00", {
      year: 2002,
      month: 10,
      tzOffset: 300,
    });
    roundTrip(parseXsdGYearMonth, writeXsdGYearMonth, "2002-01-14:00", {
      year: 2002,
      month: 1,
      tzOffset: -840,
    });
  });

  it("xs:gMonth", () => {
    roundTrip(parseXsdGMonth, writeXsdGMonth, "--05+14:00", { month: 5, tzOffset: 840 });
    roundTrip(parseXsdGMonth, writeXsdGMonth, "--12-14:00", { month: 12, tzOffset: -840 });
  });

  it("xs:gMonthDay", () => {
    roundTrip(parseXsdGMonthDay, writeXsdGMonthDay, "--05-01+14:00", {
      month: 5,
      day: 1,
      tzOffset: 840,
    });
    roundTrip(parseXsdGMonthDay, writeXsdGMonthDay, "--01-01-14:00", {
      month: 1,
      day: 1,
      tzOffset: -840,
    });
  });

  it("xs:gDay", () => {
    roundTrip(parseXsdGDay, writeXsdGDay, "---01+14:00", { day: 1, tzOffset: 840 });
    roundTrip(parseXsdGDay, writeXsdGDay, "---31-14:00", { day: 31, tzOffset: -840 });
  });
});

describe("order comparison still uses the UTC value space", () => {
  it("orders timezoned partial dates exactly", () => {
    // 2000-01-01T00:00+05:00 is 1999-12-31T19:00Z.
    expect(xsdOrderCompare("date", "2000-01-01+05:00", "2000-01-01Z")).toBe(-1);
    expect(xsdOrderCompare("date", "2002-01-01-14:00", "2002-01-01Z")).toBe(1);
    expect(xsdOrderCompare("date", "2002-01-01", "2002-01-01Z")).toBe(Number.NaN);
    expect(xsdOrderCompare("gYear", "2002+05:00", "2002Z")).toBe(-1);
    expect(xsdOrderCompare("gYear", "2002-05:00", "2002Z")).toBe(1);
    expect(xsdOrderCompare("gYearMonth", "2002-10+05:00", "2002-10Z")).toBe(-1);
    expect(xsdOrderCompare("gYearMonth", "2002-10-05:00", "2002-10Z")).toBe(1);
    expect(xsdOrderCompare("gMonth", "--05+14:00", "--05Z")).toBe(-1);
    expect(xsdOrderCompare("gMonth", "--05-14:00", "--05Z")).toBe(1);
    expect(xsdOrderCompare("gMonthDay", "--05-01+14:00", "--05-01Z")).toBe(-1);
    expect(xsdOrderCompare("gMonthDay", "--05-01-14:00", "--05-01Z")).toBe(1);
    expect(xsdOrderCompare("gDay", "---01+14:00", "---01Z")).toBe(-1);
    expect(xsdOrderCompare("gDay", "---01-14:00", "---01Z")).toBe(1);
    expect(xsdOrderCompare("date", "2000-01-01+05:00", "1999-12-31Z")).toBe(1);
    expect(xsdOrderCompare("date", "2000-01-01+14:00", "1999-12-31-10:00")).toBe(0);
  });

  it("rejects structured years that cannot be represented exactly", () => {
    expect(() => parseXsdDate("9007199254740993-01-01")).toThrow("safe integers");
    expect(() => parseXsdGYear("9007199254740993Z")).toThrow("safe integers");
  });

  it("compares an already parsed value without changing its representation", () => {
    const parsed = parseXsdDate("2000-01-01+05:00");
    expect(parsed).toEqual({ year: 2000, month: 1, day: 1, tzOffset: 300 });
    expect(xsdOrderCompare("date", parsed, "2000-01-01Z")).toBe(-1);
    expect(parsed).toEqual({ year: 2000, month: 1, day: 1, tzOffset: 300 });
  });

  it("keeps exact dateTime instant comparisons", () => {
    expect(xsdOrderCompare("dateTime", "2002-10-10T12:00:00-05:00", "2002-10-10T17:00:00Z")).toBe(
      0,
    );
    expect(xsdOrderCompare("dateTime", "2002-10-10T12:00:00+05:00", "2002-10-10T12:00:00Z")).toBe(
      -1,
    );
  });
});

const enumSchema = (base: string, values: readonly string[]): string =>
  `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="v">
    <xs:simpleType>
      <xs:restriction base="${base}">
        ${values.map((value) => `<xs:enumeration value="${value}"/>`).join("")}
      </xs:restriction>
    </xs:simpleType>
  </xs:element>
</xs:schema>`;

describe("libxml2 value-space round trip", () => {
  it("accepts the serialized form of every affected partial datatype", async () => {
    const cases: ReadonlyArray<{
      base: string;
      lexical: string;
      write: (lexical: string) => string;
    }> = [
      { base: "xs:date", lexical: "2000-01-01+05:00", write: (v) => writeXsdDate(parseXsdDate(v)) },
      {
        base: "xs:gYear",
        lexical: "2002+05:00",
        write: (v) => writeXsdGYear(parseXsdGYear(v)),
      },
      {
        base: "xs:gYearMonth",
        lexical: "2002-10+05:00",
        write: (v) => writeXsdGYearMonth(parseXsdGYearMonth(v)),
      },
      {
        base: "xs:gMonth",
        lexical: "--05+14:00",
        write: (v) => writeXsdGMonth(parseXsdGMonth(v)),
      },
      {
        base: "xs:gMonthDay",
        lexical: "--05-01+14:00",
        write: (v) => writeXsdGMonthDay(parseXsdGMonthDay(v)),
      },
      {
        base: "xs:gDay",
        lexical: "---01+14:00",
        write: (v) => writeXsdGDay(parseXsdGDay(v)),
      },
    ];
    for (const { base, lexical, write } of cases) {
      const written = write(lexical);
      const result = await validateXml(`<v>${written}</v>`, enumSchema(base, [lexical]));
      expect(result, `${base}: ${lexical} serialized as ${written}`).toEqual({ valid: true });
    }
  });
});
