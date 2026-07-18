import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { readXmlFile } from '../src/index.js';

const withTempFile = (name: string, content: Buffer, fn: (filePath: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readxmlfile-'));
  const filePath = path.join(dir, name);
  try {
    fs.writeFileSync(filePath, content);
    fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe('readXmlFile', () => {
  it('returns UTF-8 content as-is when no encoding is declared', () => {
    const xml = Buffer.from(`<?xml version="1.0"?>\n<root>menù</root>`, 'utf-8');
    withTempFile('no-decl.xml', xml, (filePath) => {
      expect(readXmlFile(filePath)).toBe(`<?xml version="1.0"?>\n<root>menù</root>`);
    });
  });

  it('decodes CP1252 and rewrites the encoding declaration to UTF-8', () => {
    const body = `<?xml version='1.0' encoding='CP1252'?>\n<menù/>`;
    const xml = iconv.encode(body, 'windows-1252');
    withTempFile('cp1252.xml', xml, (filePath) => {
      const result = readXmlFile(filePath);
      expect(result).toContain(`encoding='UTF-8'`);
      expect(result).toContain('<menù/>');
    });
  });

  it('strips a UTF-8 BOM that iconv-lite has already removed', () => {
    const xml = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`<?xml version="1.0"?>\n<root/>`, 'utf-8')
    ]);
    withTempFile('bom.xml', xml, (filePath) => {
      const result = readXmlFile(filePath);
      expect(result.charCodeAt(0)).toBe('<'.charCodeAt(0));
      expect(result).toBe(`<?xml version="1.0"?>\n<root/>`);
    });
  });

  it('strips a surviving BOM character so the encoding declaration is still normalized', () => {
    const xml = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`<?xml version='1.0' encoding='UTF-8'?>\n<root/>`, 'utf-8')
    ]);
    withTempFile('double-bom.xml', xml, (filePath) => {
      const result = readXmlFile(filePath);
      expect(result.charCodeAt(0)).toBe('<'.charCodeAt(0));
      expect(result).toContain(`encoding='UTF-8'`);
    });
  });

  it('falls back to UTF-8 when the declared encoding is unsupported', () => {
    const xml = Buffer.from(`<?xml version='1.0' encoding='KLINGON'?>\n<root/>`, 'utf-8');
    withTempFile('klingon.xml', xml, (filePath) => {
      const result = readXmlFile(filePath);
      expect(result).toContain(`encoding='UTF-8'`);
      expect(result).toContain('<root/>');
    });
  });
});
