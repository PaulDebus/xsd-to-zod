import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const pnpm = process.env.PNPM ?? "pnpm";

const run = (command, args, cwd) => {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
};

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="catalog">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="item" maxOccurs="unbounded">
          <xs:complexType>
            <xs:attribute name="id" type="xs:int" use="required"/>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

const RUNNER = `import { parseXml, safeParseXml } from "xsd-to-zod";
import { catalogSchema } from "./gen/schema.zod.ts";

const parsed = parseXml(catalogSchema, '<catalog><item id="1"/><item id="2"/></catalog>');
if (JSON.stringify(parsed) !== '{"item":[{"@id":1},{"@id":2}]}') {
  throw new Error(\`unexpected parse result: \${JSON.stringify(parsed)}\`);
}

const invalid = safeParseXml(catalogSchema, "<catalog><item/></catalog>");
if (invalid.success) {
  throw new Error("expected invalid XML to fail validation");
}
const issues = (invalid.error as { issues?: unknown }).issues;
if (!Array.isArray(issues) || issues.length === 0) {
  throw new Error("expected a ZodError with issues");
}

console.log("pack smoke: generated module parses and rejects as expected");
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xsd-to-zod-pack-"));
try {
  const packDir = path.join(tmp, "pack");
  fs.mkdirSync(packDir);
  run("npm", ["pack", "--pack-destination", packDir], root);
  const tarball = fs.readdirSync(packDir).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error("npm pack produced no tarball");
  }

  const consumer = path.join(tmp, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "xsd-to-zod-pack-smoke", private: true, type: "module" }, null, 2),
  );
  fs.writeFileSync(
    path.join(consumer, ".npmrc"),
    "node-linker=isolated\nauto-install-peers=false\n",
  );
  fs.writeFileSync(path.join(consumer, "schema.xsd"), XSD);

  run(pnpm, ["add", path.join(packDir, tarball), "zod@^4.4.3"], consumer);
  run(pnpm, ["exec", "xsd-to-zod", "schema.xsd", "-o", "gen"], consumer);

  fs.writeFileSync(path.join(consumer, "run.ts"), RUNNER);
  run(path.join(root, "node_modules", ".bin", "tsx"), ["run.ts"], consumer);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
