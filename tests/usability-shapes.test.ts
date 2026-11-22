import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { irToZod, parseXsd } from "../src/compiler.js";
import { extractInterfaceBlocks } from "./helpers.js";

// Snapshot the exported interfaces, not the whole generated module. The
// registry metadata changes for correctness reasons; the usability question is
// about the TypeScript shape an application author has to work with.
const interfaceBlocks = (code: string): string =>
  [...extractInterfaceBlocks(code).values()].join("\n\n");

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
