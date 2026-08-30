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

  it("expands \\p{IsBlock} names to code-point ranges", () => {
    expect(xsdPattern("\\p{IsBasicLatin}+").test("abc")).toBe(true);
    expect(xsdPattern("\\p{IsBasicLatin}+").test("abç")).toBe(false);
    // "IsGreek" is the ms/libxml2 name for the Greek and Coptic block.
    expect(xsdPattern("\\p{IsGreek}").test("Έ")).toBe(true);
    expect(xsdPattern("\\p{IsGreek}").test("A")).toBe(false);
    expect(xsdPattern("\\p{IsHiragana}").test("あ")).toBe(true);
    expect(xsdPattern("\\p{IsCJKUnifiedIdeographsExtensionB}").test("\u{20001}")).toBe(true);
  });

  it("expands \\P{IsBlock} to the complement of the block", () => {
    expect(xsdPattern("\\P{IsGreek}").test("A")).toBe(true);
    expect(xsdPattern("\\P{IsGreek}").test("Έ")).toBe(false);
  });

  it("translates character class subtraction", () => {
    const re = xsdPattern("[a-z-[aeiou]]+");
    expect(re.test("bcdfg")).toBe(true);
    expect(re.test("abcde")).toBe(false);
    // Quantifiers apply to the whole subtracted class.
    expect(xsdPattern("[0-9-[5]]{2}").test("47")).toBe(true);
    expect(xsdPattern("[0-9-[5]]{2}").test("45")).toBe(false);
  });

  it("translates the [\\i-[:]] NCName idiom as subtraction", () => {
    const re = xsdPattern("[\\i-[:]][\\c-[:]]*");
    expect(re.test("with-dash.and.dots")).toBe(true);
    expect(re.test("has:colon")).toBe(false);
    expect(re.test("1leading-digit")).toBe(false);
  });

  it("translates nested and negated subtraction", () => {
    const re = xsdPattern("[a-z-[a-c-[b]]]+");
    expect(re.test("bdf")).toBe(true);
    expect(re.test("abc")).toBe(false);
    expect(re.test("ac")).toBe(false);
    // Subtraction from a negated class.
    expect(xsdPattern("[^a-z-[x]]").test("A")).toBe(true);
    expect(xsdPattern("[^a-z-[x]]").test("a")).toBe(false);
    expect(xsdPattern("[^a-z-[x]]").test("x")).toBe(false);
  });

  it("translates a lone complement escape inside a class", () => {
    expect(xsdPattern("[\\C]+").test("??*")).toBe(true);
    expect(xsdPattern("[\\C]+").test("ab")).toBe(false);
    // Double negation: [^\P{IsBasicLatin}] is the block itself.
    expect(xsdPattern("[^\\P{IsBasicLatin}]").test("a")).toBe(true);
    expect(xsdPattern("[^\\P{IsBasicLatin}]").test("ç")).toBe(false);
  });

  it("falls back to the raw unanchored form for untranslatable constructs", () => {
    // Unknown Unicode block names have no JS equivalent: the raw form treats
    // the escape leniently (identity characters), like the old codegen did.
    const re = xsdPattern("\\p{IsKlingon}");
    expect(re.source).toBe("\\p{IsKlingon}");
    // Unions mixing complement escapes with other items are inexpressible.
    expect(xsdPattern("[a\\C]").source).toBe("[a\\C]");
  });

  it("normalizes Unicode block names with hyphens/spaces", () => {
    // Latin-1 Supplement with hyphen in XSD name normalizes to table key.
    const re = xsdPattern("\\p{IsLatin-1Supplement}+");
    expect(re.source).toContain("\\u0080-\\u00FF");
    expect(re.test("é")).toBe(true);
    expect(re.test("a")).toBe(false);
    // Arabic Presentation Forms-A and -B resolve to their block ranges.
    const formA = xsdPattern("\\p{IsArabicPresentationForms-A}+");
    expect(formA.source).toContain("\\uFB50-\\uFDFF");
    expect(formA.test("\uFB80")).toBe(true);
    expect(formA.test("a")).toBe(false);
    const formB = xsdPattern("\\p{IsArabicPresentationForms-B}+");
    expect(formB.source).toContain("\\uFE70-\\uFEFF");
    expect(formB.test("\uFE80")).toBe(true);
  });

  it("emits a bare hyphen for the \\- escape outside classes", () => {
    const re = xsdPattern("\\p{Nd}{2}:\\d\\d:\\d\\d(\\-\\d\\d:\\d\\d)?");
    expect(re.flags).toContain("u");
    expect(re.test("12:34:56")).toBe(true);
    expect(re.test("12:34:56-07:00")).toBe(true);
    expect(re.test("12:34")).toBe(false);
    expect(re.test("ab:cd:ef")).toBe(false);
    expect(re.test("12:34:56-")).toBe(false);
  });

  it("keeps the \\- escape inside character classes working", () => {
    expect(xsdPattern("[a\\-z]+").test("a-z")).toBe(true);
    expect(xsdPattern("[a\\-z]+").test("z")).toBe(true);
    expect(xsdPattern("[a\\-z]+").test("a")).toBe(true);
  });
});
