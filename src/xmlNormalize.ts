// XML attribute-value normalization (XML 1.0 §3.3.3): a parser must replace
// literal TAB/LF/CR in attribute values with spaces before the application
// sees them — only character references (&#9; etc.) carry control characters
// through. flexible-xml-parser passes raw bytes, so without this pass a
// literal tab survives into the retained lexical and the serializer re-emits
// it as &#9;, which a conforming processor reads as a real tab — a different
// value than the original literal tab normalizes to (RegexTest_21).
export const normalizeAttributeWhitespace = (xml: string): string => {
  let out = "";
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      out += xml.slice(i);
      break;
    }
    out += xml.slice(i, lt);
    // Comments, CDATA and PIs pass through verbatim; their contents are not
    // attribute text.
    const verbatimClose = xml.startsWith("<!--", lt)
      ? "-->"
      : xml.startsWith("<![CDATA[", lt)
        ? "]]>"
        : xml.startsWith("<?", lt)
          ? "?>"
          : undefined;
    if (verbatimClose !== undefined) {
      const end = xml.indexOf(verbatimClose, lt + verbatimClose.length + 1);
      const stop = end === -1 ? n : end + verbatimClose.length;
      out += xml.slice(lt, stop);
      i = stop;
      continue;
    }
    const rest = xml.slice(lt);
    if (rest.startsWith("<!")) {
      // DOCTYPE and other declarations: runs to '>' outside quotes and any
      // bracketed internal subset.
      let j = lt + 2;
      let quote = "";
      let depth = 0;
      while (j < n) {
        const c = xml[j]!;
        if (quote !== "") {
          if (c === quote) {
            quote = "";
          }
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === "[") {
          depth++;
        } else if (c === "]") {
          depth--;
        } else if (c === ">" && depth === 0) {
          j++;
          break;
        }
        j++;
      }
      out += xml.slice(lt, j);
      i = j;
      continue;
    }
    // A '<' not starting a name is literal text (lenient input) — pass through.
    const next = xml[lt + 1] ?? "";
    if (!/[A-Za-z_:/]/.test(next)) {
      out += "<";
      i = lt + 1;
      continue;
    }
    // Start/end tag: normalize whitespace inside quoted attribute values.
    out += "<";
    let j = lt + 1;
    let quote = "";
    while (j < n) {
      const c = xml[j]!;
      if (quote !== "") {
        if (c === quote) {
          quote = "";
        } else if (c === "\t" || c === "\n" || c === "\r") {
          out += " ";
          j++;
          continue;
        }
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        out += c;
        j++;
        break;
      }
      out += c;
      j++;
    }
    i = j;
  }
  return out;
};
