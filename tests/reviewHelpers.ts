import fs from "node:fs";
import path from "node:path";
import type { IrToZodOptions } from "../src/irToZod.js";
import { irToZod } from "../src/irToZod.js";
import { parseXsd } from "../src/parseXsd.js";
import { findRootSchemas, importGeneratedSchemas, withTempDirAsync } from "./helpers.js";

export const compileReviewSchema = async (
  body: string,
  options?: IrToZodOptions,
  attributes = "",
) => {
  const xsd = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" ${attributes}>${body}</xs:schema>`;
  const ir = await parseXsd(["schema.xsd"], {
    resolveSchema: async () => ({ content: xsd, url: "https://example.com/schema.xsd" }),
  });
  const generated = irToZod(ir, options);
  const mod = await importGeneratedSchemas(generated.schemas);
  const root = findRootSchemas(mod).find((entry) => entry.rootQName.endsWith("}root"));
  if (root === undefined) {
    throw new Error("review fixture has no root element");
  }
  return { xsd, ir, generated, mod, schema: root.schema };
};

export const withReviewFiles = async (
  files: Record<string, string>,
  run: (entries: string[]) => Promise<void>,
) =>
  withTempDirAsync(async (dir) => {
    const entries = Object.entries(files).map(([name, content]) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      return file;
    });
    await run(entries);
  });
