import fs from "node:fs";
import path from "node:path";
import { irToZod, parseXsd } from "../dist/compiler.js";

const fixturesDir = path.resolve("testdata/usability");
const outDir = path.join(fixturesDir, "generated");

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const fixtures = fs
  .readdirSync(fixturesDir)
  .filter((file) => file.endsWith(".xsd"))
  .sort();

for (const fixture of fixtures) {
  const ir = await parseXsd([path.join(fixturesDir, fixture)]);
  const { schemas, warnings } = irToZod(ir);
  const outFile = path.join(outDir, fixture.replace(/\.xsd$/, ".zod.ts"));
  fs.writeFileSync(outFile, schemas);
  console.log(`${fixture} -> ${path.relative(process.cwd(), outFile)}`);
  for (const warning of warnings ?? []) {
    console.log(`  warning: ${warning}`);
  }
}

console.log(`\nGenerated ${fixtures.length} usability module(s).`);
