import fs from 'node:fs';
import iconv from 'iconv-lite';

export const readXmlFile = (filePath: string): string => {
  const raw = fs.readFileSync(filePath);
  const declMatch = raw.toString('ascii', 0, Math.min(raw.length, 200)).match(/<\?xml\b[^>]*?\bencoding\s*=\s*["']([^"']+)["']/);
  const encoding = declMatch ? declMatch[1] : 'utf-8';
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
  // double-encoded garbage) treat the document as UTF-8.
  return declMatch
    ? content.replace(
        /^(<\?xml\s+[^>]*?)(encoding\s*=\s*["'])([^"']+)(["'][^>]*?\?>)/,
        (_, pre, attr, _enc, rest) => `${pre}${attr}UTF-8${rest}`
      )
    : content;
};
