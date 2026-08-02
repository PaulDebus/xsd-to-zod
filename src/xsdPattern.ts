// XSD 1.0 regular expressions → JavaScript RegExp.
//
// XSD patterns are implicitly anchored (the whole lexical must match) and use
// a regex dialect that differs from JavaScript's: \d/\s/\w cover Unicode
// (JS \d is ASCII-only, JS \s matches more than the XSD four), \i and \c are
// the XML Name productions, and \w is punctuation/symbol/control-complement.
// The multi-character escapes are translated here and the result compiled in
// unicode mode. Constructs with no JS equivalent (class subtraction,
// \p{IsBlock} names, multi-char escapes inside a negated class, …) fail the
// unicode compile and fall back to the historical raw form — lax, matching
// the previous unanchored behavior for those patterns.

import { NAME_CHAR_EXTRA, NAME_START_CHAR } from "./xsdLexicals.js";

// Multi-character escapes expressible as character-class content (valid both
// standalone — wrapped in a class — and nested inside an existing class).
const CLASS_CONTENT_ESCAPES: Record<string, string> = {
  d: "\\p{Nd}",
  D: "\\P{Nd}",
  s: "\\t\\n\\r ",
  i: NAME_START_CHAR,
  c: NAME_START_CHAR + NAME_CHAR_EXTRA,
  W: "\\p{P}\\p{Z}\\p{C}",
};

// Complements have no class-content form; standalone only.
const STANDALONE_ESCAPES: Record<string, string> = {
  w: "[^\\p{P}\\p{Z}\\p{C}]",
  S: "[^\\t\\n\\r ]",
  I: `[^${NAME_START_CHAR}]`,
  C: `[^${NAME_START_CHAR}${NAME_CHAR_EXTRA}]`,
};

const translate = (source: string): string => {
  let out = "";
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\" && i + 1 < source.length) {
      const next = source[i + 1] as string;
      const content = CLASS_CONTENT_ESCAPES[next];
      if (content !== undefined) {
        out += inClass ? content : `[${content}]`;
        i++;
        continue;
      }
      const standalone = STANDALONE_ESCAPES[next];
      if (standalone !== undefined) {
        if (inClass) {
          throw new Error(`\\${next} is not expressible inside a character class`);
        }
        out += standalone;
        i++;
        continue;
      }
      out += `${ch}${next}`;
      i++;
      continue;
    }
    if (ch === "[") {
      inClass = true;
    } else if (ch === "]") {
      inClass = false;
    }
    out += ch;
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
