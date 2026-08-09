import { describe, expect, it } from "vitest";
import { xsdPattern } from "../src/index.js";

// Unit tests for the XSD regex dialect translation: anchored whole-lexical
// matching, unicode-aware multi-character escapes, and the raw fallback for
// constructs JavaScript cannot express.
describe("xsdPattern", () => {
  it("anchors the match to the whole lexical (XSD semantics)", () => {
    const re = xsdPattern("[A-Z]{2}");
    expect(re.test("DE")).toBe(true);
    expect(re.test("DEU")).toBe(false);
    expect(re.test("XDE")).toBe(false);
  });

  it("supports alternation across the whole lexical", () => {
    const re = xsdPattern("ab|cd");
    expect(re.test("ab")).toBe(true);
    expect(re.test("cd")).toBe(true);
    expect(re.test("abcd")).toBe(false);
  });

  it("translates \\d to unicode decimal digits", () => {
    const re = xsdPattern("\\d");
    expect(re.test("5")).toBe(true);
    // Extended Arabic-Indic digit: XSD \d covers all of Nd, JS \d does not.
    expect(re.test("٠")).toBe(true);
  });

  it("translates \\s to exactly the four XSD whitespace characters", () => {
    const re = xsdPattern("a\\sb");
    expect(re.test("a b")).toBe(true);
    expect(re.test("a\tb")).toBe(true);
    expect(re.test("a b")).toBe(false);
  });

  it("translates \\w to the XSD word characters", () => {
    const re = xsdPattern("\\w+");
    expect(re.test("abc1")).toBe(true);
    // XSD \w excludes ALL punctuation (incl. '.' and '-'), JS \w does not.
    expect(re.test("abc-1.x")).toBe(false);
    expect(re.test("a b")).toBe(false);
  });

  it("translates \\i and \\c to the XML Name productions", () => {
    expect(xsdPattern("\\i\\c*").test("_x1-y")).toBe(true);
    expect(xsdPattern("\\i\\c*").test("1x")).toBe(false);
    expect(xsdPattern("\\c{3}").test("a-1")).toBe(true);
    expect(xsdPattern("\\c{3}").test("a 1")).toBe(false);
  });

  it("translates the complements \\D \\S \\W \\I \\C", () => {
    expect(xsdPattern("\\D").test("x")).toBe(true);
    expect(xsdPattern("\\D").test("5")).toBe(false);
    expect(xsdPattern("\\S+").test("ab")).toBe(true);
    expect(xsdPattern("\\S+").test("a b")).toBe(false);
    expect(xsdPattern("\\W").test(",")).toBe(true);
    expect(xsdPattern("\\I").test("1")).toBe(true);
    expect(xsdPattern("\\C").test(" ")).toBe(true);
  });

  it("translates escapes inside character classes", () => {
    expect(xsdPattern("[\\d]").test("٣")).toBe(true);
    expect(xsdPattern("[\\i]").test(":")).toBe(true);
    expect(xsdPattern("[ab\\d]").test("7")).toBe(true);
  });

  it("keeps \\p{...} category escapes working", () => {
    expect(xsdPattern("\\p{Nd}{1,3}").test("42")).toBe(true);
    expect(xsdPattern("\\p{Lu}").test("A")).toBe(true);
    expect(xsdPattern("\\p{Lu}").test("a")).toBe(false);
  });

  it("falls back to the raw unanchored form for untranslatable constructs", () => {
    // \p{IsBlock} names have no JS equivalent: the raw form treats the
    // escape leniently (identity characters), like the old codegen did.
    const re = xsdPattern("\\p{IsGreek}");
    expect(re.source).toBe("\\p{IsGreek}");
  });
});
