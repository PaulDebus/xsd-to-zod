// XSD 1.0 regular expressions → JavaScript RegExp.
//
// XSD patterns are implicitly anchored (the whole lexical must match) and use
// a regex dialect that differs from JavaScript's: \d/\s/\w cover Unicode
// (JS \d is ASCII-only, JS \s matches more than the XSD four), \i and \c are
// the XML Name productions, and \w is punctuation/symbol/control-complement.
// Character classes support subtraction ([a-z-[aeiou]] — emitted as a
// negative lookahead over the subtracted class; the [\i-[:]] idiom is
// subtraction, not a range, since XSD range endpoints are single characters).
// \p{...} takes both Unicode categories (passed through to JS property
// escapes) and \p{IsBlock} names (JS has no block support — blocks are
// expanded to their code-point ranges). Constructs that remain inexpressible
// (unions mixing complement escapes with other items, unknown blocks, …)
// throw during translation and fall back to the historical raw form — lax,
// matching the previous unanchored behavior for those patterns.

import { NAME_CHAR_EXTRA, NAME_START_CHAR } from "./xsdLexicals.js";

const NAME_CHAR = NAME_START_CHAR + NAME_CHAR_EXTRA;

// Multi-character escapes expressible as character-class content (valid both
// standalone — wrapped in a class — and nested inside an existing class).
const CLASS_CONTENT_ESCAPES: Record<string, string> = {
  d: "\\p{Nd}",
  D: "\\P{Nd}",
  s: "\\t\\n\\r ",
  i: NAME_START_CHAR,
  c: NAME_CHAR,
  W: "\\p{P}\\p{Z}\\p{C}",
};

// Complement escapes, as the class content of the set they COMPLEMENT. They
// have no class-content form: standalone they emit a negated class, inside a
// class they are only expressible as the sole item (double negation).
const COMPLEMENT_ESCAPES: Record<string, string> = {
  w: "\\p{P}\\p{Z}\\p{C}",
  S: "\\t\\n\\r ",
  I: NAME_START_CHAR,
  C: NAME_CHAR,
};

// Single-character escapes shared by the XSD and JS dialects (inside and
// outside classes; JS unicode mode accepts each of these escaped).
const SINGLE_CHAR_ESCAPES = new Set("nrt\\|.^?*+{}()[]-".split(""));

// Unicode general categories shared by XSD and JS property escapes (JS has
// no Cn). \P{Cat} works inside JS classes, so both stay class content.
const CATEGORIES = new Set([
  "L",
  "Lu",
  "Ll",
  "Lt",
  "Lm",
  "Lo",
  "M",
  "Mn",
  "Mc",
  "Me",
  "N",
  "Nd",
  "Nl",
  "No",
  "P",
  "Pc",
  "Pd",
  "Ps",
  "Pe",
  "Pi",
  "Pf",
  "Po",
  "Z",
  "Zs",
  "Zl",
  "Zp",
  "S",
  "Sm",
  "Sc",
  "Sk",
  "So",
  "C",
  "Cc",
  "Cf",
  "Co",
  "Cs",
]);

// Unicode block ranges (Blocks.txt), keyed by the lowercased XSD block name
// (the block name with spaces removed, without the "Is" prefix). Only the
// blocks exercised by the W3C regex corpus are listed; unknown names throw
// and take the raw fallback.
const BLOCKS: Record<string, string> = {
  alphabeticpresentationforms: "\\uFB00-\\uFB4F",
  arabic: "\\u0600-\\u06FF",
  armenian: "\\u0530-\\u058F",
  arrows: "\\u2190-\\u21FF",
  basiclatin: "\\u0000-\\u007F",
  bengali: "\\u0980-\\u09FF",
  blockelements: "\\u2580-\\u259F",
  bopomofo: "\\u3100-\\u312F",
  bopomofoextended: "\\u31A0-\\u31BF",
  boxdrawing: "\\u2500-\\u257F",
  braillepatterns: "\\u2800-\\u28FF",
  byzantinemusicalsymbols: "\\u{1D000}-\\u{1D0FF}",
  cherokee: "\\u13A0-\\u13FF",
  cjkcompatibility: "\\u3300-\\u33FF",
  cjkcompatibilityforms: "\\uFE30-\\uFE4F",
  cjkcompatibilityideographs: "\\uF900-\\uFAFF",
  cjkcompatibilityideographssupplement: "\\u{2F800}-\\u{2FA1F}",
  cjkradicalssupplement: "\\u2E80-\\u2EFF",
  cjksymbolsandpunctuation: "\\u3000-\\u303F",
  cjkunifiedideographs: "\\u4E00-\\u9FFF",
  cjkunifiedideographsextensiona: "\\u3400-\\u4DBF",
  cjkunifiedideographsextensionb: "\\u{20000}-\\u{2A6DF}",
  combiningdiacriticalmarks: "\\u0300-\\u036F",
  combininghalfmarks: "\\uFE20-\\uFE2F",
  combiningmarksforsymbols: "\\u20D0-\\u20FF",
  controlpictures: "\\u2400-\\u243F",
  currencysymbols: "\\u20A0-\\u20CF",
  cyrillic: "\\u0400-\\u04FF",
  deseret: "\\u{10400}-\\u{1044F}",
  devanagari: "\\u0900-\\u097F",
  dingbats: "\\u2700-\\u27BF",
  enclosedalphanumerics: "\\u2460-\\u24FF",
  enclosedcjklettersandmonths: "\\u3200-\\u32FF",
  ethiopic: "\\u1200-\\u137F",
  generalpunctuation: "\\u2000-\\u206F",
  geometricshapes: "\\u25A0-\\u25FF",
  georgian: "\\u10A0-\\u10FF",
  gothic: "\\u{10330}-\\u{1034F}",
  // "Greek" is the ms/libxml2 name for the "Greek and Coptic" block.
  greek: "\\u0370-\\u03FF",
  greekandcoptic: "\\u0370-\\u03FF",
  greekextended: "\\u1F00-\\u1FFF",
  gujarati: "\\u0A80-\\u0AFF",
  gurmukhi: "\\u0A00-\\u0A7F",
  halfwidthandfullwidthforms: "\\uFF00-\\uFFEF",
  hangulcompatibilityjamo: "\\u3130-\\u318F",
  hanguljamo: "\\u1100-\\u11FF",
  hangulsyllables: "\\uAC00-\\uD7AF",
  hebrew: "\\u0590-\\u05FF",
  highsurrogates: "\\uD800-\\uDBFF",
  hiragana: "\\u3040-\\u309F",
  ideographicdescriptioncharacters: "\\u2FF0-\\u2FFF",
  ipaextensions: "\\u0250-\\u02AF",
  kanbun: "\\u3190-\\u319F",
  kangxiradicals: "\\u2F00-\\u2FDF",
  kannada: "\\u0C80-\\u0CFF",
  katakana: "\\u30A0-\\u30FF",
  khmer: "\\u1780-\\u17FF",
  lao: "\\u0E80-\\u0EFF",
  latin1supplement: "\\u0080-\\u00FF",
  latinextendedadditional: "\\u1E00-\\u1EFF",
  latinextendeda: "\\u0100-\\u017F",
  latinextendedb: "\\u0180-\\u024F",
  letterlikesymbols: "\\u2100-\\u214F",
  lowsurrogates: "\\uDC00-\\uDFFF",
  malayalam: "\\u0D00-\\u0D7F",
  mathematicalalphanumericsymbols: "\\u{1D400}-\\u{1D7FF}",
  mathematicaloperators: "\\u2200-\\u22FF",
  miscellaneoussymbols: "\\u2600-\\u26FF",
  miscellaneoustechnical: "\\u2300-\\u23FF",
  mongolian: "\\u1800-\\u18AF",
  musicalsymbols: "\\u{1D100}-\\u{1D1FF}",
  myanmar: "\\u1000-\\u109F",
  numberforms: "\\u2150-\\u218F",
  ogham: "\\u1680-\\u169F",
  olditalic: "\\u{10300}-\\u{1032F}",
  opticalcharacterrecognition: "\\u2440-\\u245F",
  oriya: "\\u0B00-\\u0B7F",
  privateuse: "\\uE000-\\uF8FF",
  arabicpresentationformsa: "\\uFB50-\\uFDFF",
  arabicpresentationformsb: "\\uFE70-\\uFEFF",
  runic: "\\u16A0-\\u16FF",
  sinhala: "\\u0D80-\\u0DFF",
  smallformvariants: "\\uFE50-\\uFE6F",
  spacingmodifierletters: "\\u02B0-\\u02FF",
  specials: "\\uFFF0-\\uFFFF",
  superscriptsandsubscripts: "\\u2070-\\u209F",
  syriac: "\\u0700-\\u074F",
  tags: "\\u{E0000}-\\u{E007F}",
  tamil: "\\u0B80-\\u0BFF",
  telugu: "\\u0C00-\\u0C7F",
  thaana: "\\u0780-\\u07BF",
  thai: "\\u0E00-\\u0E7F",
  tibetan: "\\u0F00-\\u0FFF",
  unifiedcanadianaboriginalsyllabics: "\\u1400-\\u167F",
  yiradicals: "\\uA490-\\uA4CF",
  yisyllables: "\\uA000-\\uA48F",
};

// What an escape sequence expands to: class content for the set itself
// ("content"), class content for the set's complement ("complement"), or a
// single character ("single" — kept escaped, usable as a range endpoint).
type Escape =
  | { kind: "content"; content: string }
  | { kind: "complement"; content: string }
  | { kind: "single"; content: string };

const readEscape = (source: string, start: number): Escape & { end: number } => {
  const ch = source[start + 1];
  if (ch === undefined) {
    throw new Error("trailing backslash");
  }
  if (ch === "p" || ch === "P") {
    const close = source.indexOf("}", start + 2);
    if (source[start + 2] !== "{" || close === -1) {
      throw new Error(`malformed \\${ch} escape`);
    }
    const name = source.slice(start + 3, close);
    const block = /^[Ii][Ss](.+)$/.exec(name)?.[1];
    if (block !== undefined) {
      const normalized = block.toLowerCase().replace(/[-_\s]/g, "");
      const range = BLOCKS[normalized];
      if (range === undefined) {
        throw new Error(`unknown Unicode block ${name}`);
      }
      return { kind: ch === "p" ? "content" : "complement", content: range, end: close + 1 };
    }
    if (!CATEGORIES.has(name)) {
      throw new Error(`unsupported Unicode category ${name}`);
    }
    return { kind: "content", content: `\\${ch}{${name}}`, end: close + 1 };
  }
  const content = CLASS_CONTENT_ESCAPES[ch];
  if (content !== undefined) {
    return { kind: "content", content, end: start + 2 };
  }
  const complement = COMPLEMENT_ESCAPES[ch];
  if (complement !== undefined) {
    return { kind: "complement", content: complement, end: start + 2 };
  }
  if (SINGLE_CHAR_ESCAPES.has(ch)) {
    return { kind: "single", content: `\\${ch}`, end: start + 2 };
  }
  throw new Error(`unsupported escape \\${ch}`);
};

// One character usable as a range endpoint: a raw character or a
// single-character escape.
const readSingleChar = (source: string, start: number): { content: string; end: number } => {
  const ch = source[start];
  if (ch === undefined) {
    throw new Error("unexpected end of pattern");
  }
  if (ch === "\\") {
    const esc = readEscape(source, start);
    if (esc.kind !== "single") {
      throw new Error("multi-character escape cannot be a range endpoint");
    }
    return { content: esc.content, end: esc.end };
  }
  return { content: ch, end: start + 1 };
};

// Parses a character class starting at source[start] === "[". Returns the JS
// atom (a class, or a lookahead-wrapped class when subtraction is present)
// and the index just past the closing "]".
const parseClass = (source: string, start: number): { atom: string; end: number } => {
  let i = start + 1;
  let negated = false;
  if (source[i] === "^") {
    negated = true;
    i++;
  }
  const positive: string[] = [];
  const complements: string[] = [];
  const subtractions: string[] = [];
  // Last item when it was a single character: a following '-' opens a range.
  let pending: string | null = null;
  const flushPending = (): void => {
    if (pending !== null) {
      positive.push(pending);
      pending = null;
    }
  };

  for (;;) {
    const ch = source[i];
    if (ch === undefined) {
      throw new Error("unterminated character class");
    }
    if (ch === "]") {
      flushPending();
      break;
    }
    if (ch === "[") {
      throw new Error("nested character classes are not XSD 1.0");
    }
    if (ch === "-") {
      if (source[i + 1] === "[") {
        // Class subtraction: [group-[subtracted]].
        flushPending();
        const sub = parseClass(source, i + 1);
        subtractions.push(sub.atom);
        i = sub.end;
        continue;
      }
      if (pending !== null && source[i + 1] !== undefined && source[i + 1] !== "]") {
        const endpoint = readSingleChar(source, i + 1);
        positive.push(`${pending}-${endpoint.content}`);
        pending = null;
        i = endpoint.end;
        continue;
      }
      // Literal '-' (first/last position).
      flushPending();
      positive.push("\\-");
      i++;
      continue;
    }
    if (ch === "\\") {
      const esc = readEscape(source, i);
      i = esc.end;
      if (esc.kind === "single") {
        flushPending();
        pending = esc.content;
      } else if (esc.kind === "content") {
        flushPending();
        positive.push(esc.content);
      } else {
        flushPending();
        complements.push(esc.content);
      }
      continue;
    }
    flushPending();
    pending = ch;
    i++;
  }

  let cls: string;
  if (complements.length === 0) {
    cls = `[${negated ? "^" : ""}${positive.join("")}]`;
  } else if (positive.length === 0 && complements.length === 1) {
    // A lone complement item: [^X] is the complement, and ^[comp] double-
    // negates back to X itself (e.g. [^\P{IsBasicLatin}]).
    const only = complements[0] as string;
    cls = negated ? `[${only}]` : `[^${only}]`;
  } else {
    throw new Error("union of complement escapes is not expressible");
  }
  if (subtractions.length === 0) {
    return { atom: cls, end: i + 1 };
  }
  // Subtraction as negative lookaheads over the single-character classes.
  const excluded = subtractions.map((sub) => `(?!${sub})`).join("");
  return { atom: `(?:${excluded}${cls})`, end: i + 1 };
};

const translate = (source: string): string => {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === "[") {
      const cls = parseClass(source, i);
      out += cls.atom;
      i = cls.end;
      continue;
    }
    if (ch === "\\") {
      const esc = readEscape(source, i);
      if (esc.kind === "complement") {
        out += `[^${esc.content}]`;
      } else if (esc.kind === "content") {
        out += `[${esc.content}]`;
      } else if (esc.content === "\\-") {
        // \- is not an escapable character outside classes in u-mode.
        out += "-";
      } else {
        out += esc.content;
      }
      i = esc.end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
};

/**
 * Compile an XSD pattern facet to a RegExp testing the WHOLE lexical (XSD
 * patterns are implicitly anchored). Falls back to the raw, unanchored form
 * when the source uses constructs JavaScript cannot express.
 */
export const xsdPattern = (source: string): RegExp => {
  try {
    return new RegExp(`^(?:${translate(source)})$`, "u");
  } catch {
    return new RegExp(source);
  }
};
