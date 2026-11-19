import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { irToZod, parseXsd } from "../src/compiler.js";

// Snapshot the exported interfaces, not the whole generated module. The
// registry metadata changes for correctness reasons; the usability question is
// about the TypeScript shape an application author has to work with.
const interfaceBlocks = (code: string): string => {
  const lines = code.split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || !line.startsWith("export interface ")) {
      continue;
    }
    let depth = 0;
    const block: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (current === undefined) {
        break;
      }
      block.push(current);
      depth += (current.match(/{/g) ?? []).length;
      depth -= (current.match(/}/g) ?? []).length;
      index++;
      if (depth === 0) {
        break;
      }
    }
    blocks.push(block.join("\n"));
    index--;
  }
  return blocks.join("\n\n");
};

const fixtures = fs
  .readdirSync(path.resolve("testdata/usability"))
  .filter((file) => file.endsWith(".xsd"))
  .sort();

describe("usability fixture shapes", () => {
  for (const fixture of fixtures) {
    it(`keeps the generated shape for ${fixture}`, async () => {
      const ir = await parseXsd([path.resolve("testdata/usability", fixture)]);
      expect(interfaceBlocks(irToZod(ir).schemas)).toMatchSnapshot();
    });
  }
});
