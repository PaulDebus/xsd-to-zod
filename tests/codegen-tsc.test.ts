import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { irToZod, parseXsd } from "../src/index.js";
import { discoverCuratedCases, expectTscPasses } from "./helpers.js";

// Smoke test: generated .zod.ts output must typecheck under the project's strict
// settings for every curated fixture. Catches codegen bugs that produce invalid
// TypeScript which runtime tests only see as dynamic import failures.
// All files are checked in a single tsc invocation — one process for the whole
// corpus keeps this fast, and tsc's output names the offending file on failure.
// Files live in the gitignored .xsd-to-zod-tests dotdir so the `xsd-to-zod` import in
// generated code resolves via package self-reference (not possible from inside
// node_modules).
describe("generated code typechecks", () => {
  const cases = discoverCuratedCases();

  it.each([{ extraFlags: [] }, { extraFlags: ["--exactOptionalPropertyTypes"] }])(
    `tsc --noEmit $extraFlags passes for all ${cases.length} curated cases`,
    async ({ extraFlags }) => {
      const baseDir = path.resolve(".xsd-to-zod-tests");
      fs.mkdirSync(baseDir, { recursive: true });
      const dir = fs.mkdtempSync(path.join(baseDir, "tsc-smoke-"));
      try {
        const files: string[] = [];
        for (const c of cases) {
          const { schemas } = irToZod(await parseXsd(c.xsdFiles));
          const file = path.join(dir, `${c.name.replaceAll("/", "--")}.zod.ts`);
          fs.writeFileSync(file, schemas);
          files.push(file);
        }

        expectTscPasses(files, extraFlags);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
