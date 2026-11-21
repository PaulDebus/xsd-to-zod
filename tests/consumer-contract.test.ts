import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { irToZod, parseXsd } from "../src/compiler.js";
import { extractInterfaceBlocks, withTempDirAsync } from "./helpers.js";

const usabilityDir = path.resolve("testdata/usability");
const generatedDir = path.join(usabilityDir, "generated");

const fixtures = fs
  .readdirSync(usabilityDir)
  .filter((file) => file.endsWith(".xsd"))
  .sort();

const generate = async (xsdFiles: string[]): Promise<string> =>
  irToZod(await parseXsd(xsdFiles)).schemas;

describe("consumer contract", () => {
  it("keeps the committed generated modules in sync with the fixtures", async () => {
    for (const fixture of fixtures) {
      const generated = await generate([path.join(usabilityDir, fixture)]);
      const committedFile = path.join(generatedDir, fixture.replace(/\.xsd$/, ".zod.ts"));
      expect(
        fs.existsSync(committedFile),
        `${fixture} has no generated module: run npm run usability`,
      ).toBe(true);
      const committed = fs.readFileSync(committedFile, "utf8");
      expect(generated, `${fixture} is stale: run npm run usability`).toBe(committed);
    }
  });

  it("typechecks the consumer snippets against the generated modules", () => {
    const result = spawnSync(
      path.resolve("node_modules/.bin/tsc"),
      ["-p", "tsconfig.usability.json", "--noEmit"],
      { encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 60_000);

  it("round-trips a document through the consumer domain model", async () => {
    const consumer = await import("../testdata/usability/consumers/inherited-choices.js");

    const model = consumer.toCollectionModel(consumer.buildCollection());
    const edited = consumer.addItemRef(
      consumer.renameGroup(model, 0, "renamed group"),
      0,
      "item-2",
    );

    const xml = consumer.serializeModel(edited);
    const reparsed = consumer.parseModel(xml);

    expect(reparsed).toEqual(edited);
    expect(consumer.serializeModel(reparsed)).toBe(xml);
    expect(reparsed.groups[0]?.labels[0]?.text).toBe("renamed group");
    expect(reparsed.groups[0]?.itemRefs).toEqual(["item-1", "item-2"]);
    expect(reparsed.items[0]?.limits).toEqual({ min: "0", max: "10" });
  });

  it("keeps existing interfaces stable when an unrelated type is added", async () => {
    const fixture = path.join(usabilityDir, "inherited-choices.xsd");
    const source = fs.readFileSync(fixture, "utf8");
    const extended = source.replace(
      "</xs:schema>",
      `  <xs:complexType name="UnrelatedText">
    <xs:simpleContent>
      <xs:extension base="xs:string">
        <xs:attribute name="lang" type="xs:language"/>
      </xs:extension>
    </xs:simpleContent>
  </xs:complexType>
</xs:schema>`,
    );
    expect(extended).not.toBe(source);

    const baseline = extractInterfaceBlocks(await generate([fixture]));
    let withExtra = new Map<string, string>();
    await withTempDirAsync(async (dir) => {
      const file = path.join(dir, "inherited-choices.xsd");
      fs.writeFileSync(file, extended);
      withExtra = extractInterfaceBlocks(await generate([file]));
    });

    expect(baseline.size).toBeGreaterThan(0);
    for (const [name, block] of baseline) {
      expect(withExtra.get(name), `${name} changed when an unrelated type was added`).toBe(block);
    }
  });
});
