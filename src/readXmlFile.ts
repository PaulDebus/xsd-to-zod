import fs from 'node:fs';
import iconv from 'iconv-lite';

// UTF-16 detection: the BOM check comes first; without a BOM, XML documents
// start with '<', so a NUL in byte 1 (LE) or byte 0 (BE) gives it away. In
// UTF-16 the XML declaration is interleaved with NUL bytes, so the ASCII
// declaration regex below can never match it (#81).
const sniffUtf16 = (raw: Buffer): 'utf16-le' | 'utf16-be' | undefined => {
  if (raw.length < 2) {
    return undefined;
  }
  if (raw[0] === 0xff && raw[1] === 0xfe) return 'utf16-le';
  if (raw[0] === 0xfe && raw[1] === 0xff) return 'utf16-be';
  if (raw[0] === 0x3c && raw[1] === 0x00) return 'utf16-le';
  if (raw[0] === 0x00 && raw[1] === 0x3c) return 'utf16-be';
  return undefined;
};

const declaredEncoding = (raw: Buffer): string | undefined =>
  raw.toString('ascii', 0, Math.min(raw.length, 200)).match(/<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']+)["']/)?.[1];

export const readXmlFile = (filePath: string): string => {
  const raw = fs.readFileSync(filePath);
  const encoding = sniffUtf16(raw) ?? declaredEncoding(raw) ?? 'utf-8';
  let content: string;
  try {
    content = iconv.decode(raw, encoding);
  } catch {
    content = raw.toString('utf-8');
  }
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  // After iconv.decode the string is a JavaScript Unicode string. Rewrite the
  // encoding attribute to UTF-8 so downstream consumers (e.g. libxml2-wasm,
  // which would otherwise re-encode already-decoded content and produce
  // double-encoded garbage) treat the document as UTF-8. Matched on the
  // decoded content so UTF-16 declarations are rewritten too (#81).
  return content.replace(
    /^(<\?xml\s+[^>]*?)(encoding\s*=\s*["'])([^"']+)(["'][^>]*?\?>)/,
    (_, pre, attr, _enc, rest) => `${pre}${attr}UTF-8${rest}`
  );
};
