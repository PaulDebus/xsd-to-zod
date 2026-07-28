import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  discoverDependencies,
  expandDirectories,
  isDirectInvocation,
  isLibrary,
  main,
  stripImports,
} from "../src/cli.js";
import { withTempDir, withTempDirAsync } from "./helpers.js";

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="hello" type="xs:string"/>
</xs:schema>`;

// Runs the CLI in-process, capturing console output — much faster and less
// fragile than spawning `npx tsx` per test (#83).
const runCli = async (
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
  try {
    return {
      code: await main(args),
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
    };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
};

// Helper: suppress expected exit errors so `main()` doesn't log them via
// commander's own output path (which writes to stderr/stdout itself).
const runCliQuiet = async (
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  });
  try {
    return {
      code: await main(args),
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
    };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
};

describe("isLibrary", () => {
  it("returns false for a file with root elements", () =>
    withTempDir((dir) => {
      const file = path.join(dir, "roots.xsd");
      fs.writeFileSync(
        file,
        `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="hello" type="xs:string"/>
</xs:schema>`,
      );
      expect(isLibrary(file)).toBe(false);
    }));

  it("returns true for a type-definition-only schema", () =>
    withTempDir((dir) => {
      const file = path.join(dir, "lib.xsd");
      fs.writeFileSync(
        file,
        `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="Foo"><xs:sequence><xs:element name="bar" type="xs:string"/></xs:sequence></xs:complexType>
</xs:schema>`,
      );
      expect(isLibrary(file)).toBe(true);
    }));

  it("returns false when file does not exist", () =>
    withTempDir((dir) => {
      expect(isLibrary(path.join(dir, "missing.xsd"))).toBe(false);
    }));

  it("returns false for a file without a schema tag", () =>
    withTempDir((dir) => {
      const file = path.join(dir, "nope.xml");
      fs.writeFileSync(file, "<root/>");
      expect(isLibrary(file)).toBe(false);
    }));

  it("returns false for a truncated/malformed file", () =>
    withTempDir((dir) => {
      const file = path.join(dir, "broken.xsd");
      fs.writeFileSync(file, '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element');
      expect(isLibrary(file)).toBe(false);
    }));

  it("handles namespace-prefixed schema tags", () =>
    withTempDir((dir) => {
      const file = path.join(dir, "prefixed.xsd");
      fs.writeFileSync(
        file,
        `<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <xsd:complexType name="Bar"/>
</xsd:schema>`,
      );
      expect(isLibrary(file)).toBe(true);
    }));

  it("returns true for empty schema with no children", () =>
    withTempDir((dir) => {
      const file = path.join(dir, "empty.xsd");
      fs.writeFileSync(
        file,
        `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
</xs:schema>`,
      );
      expect(isLibrary(file)).toBe(true);
    }));
});

describe("CLI e2e", () => {
  it("prints help on --help", async () => {
    const r = await runCliQuiet(["--help"]);
    expect(r.code).toBe(0);
  });

  it("exits with error when no files given", async () => {
    const r = await runCliQuiet([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no .xsd files found");
  });

  it("creates output directory if it does not exist", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      fs.writeFileSync(xsdFile, XSD);
      const outDir = path.join(dir, "does-not-exist");
      const r = await runCli([xsdFile, "-o", outDir]);
      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(outDir, "test.zod.ts"))).toBe(true);
    });
  });

  it("generates a single .zod.ts artifact (no .meta.ts)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      fs.writeFileSync(xsdFile, XSD);
      const r = await runCli([xsdFile, "-o", dir, "--name", "my"]);

      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Wrote");
      expect(fs.existsSync(path.join(dir, "my.zod.ts"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "my.meta.ts"))).toBe(false);
    });
  });

  it("defaults output name to input file stem", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "my-stem.xsd");
      fs.writeFileSync(xsdFile, XSD);
      const r = await runCli([xsdFile, "-o", dir]);

      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(dir, "my-stem.zod.ts"))).toBe(true);
    });
  });

  it("reports missing input files in the CLI error style instead of a stack trace (#82)", async () => {
    await withTempDirAsync(async (dir) => {
      const r = await runCli([path.join(dir, "missing.xsd"), "-o", dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^error: /);
      expect(r.stderr).not.toContain("at ");
    });
  });

  it("reports malformed XML in the CLI error style (#82)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "broken.xsd");
      fs.writeFileSync(
        xsdFile,
        '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element',
      );
      const r = await runCli([xsdFile, "-o", dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^error: /);
    });
  });

  it("warns about schema references that could not be resolved (#77)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      fs.writeFileSync(
        xsdFile,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="t:missing"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
      );
      const r = await runCli([xsdFile, "-o", dir]);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('warning: unresolved element ref "{urn:test}missing"');
    });
  });

  it("prints file context and error code for typed errors (#84)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "not-a-schema.xsd");
      fs.writeFileSync(xsdFile, '<?xml version="1.0"?><notschema/>');
      const r = await runCli([xsdFile, "-o", dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`${xsdFile}: No schema root found`);
      expect(r.stderr).toContain("[no-schema-root]");
    });
  });

  it("expands a directory argument into .xsd files (#34)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsd1 = path.join(dir, "first.xsd");
      const xsd2 = path.join(dir, "second.xsd");
      fs.writeFileSync(xsd1, XSD);
      fs.writeFileSync(xsd2, XSD);
      const outDir = path.join(dir, "out");
      const r = await runCli([dir, "-o", outDir, "--name", "all"]);
      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(outDir, "all.zod.ts"))).toBe(true);
    });
  });

  it("skips non-.xsd files when expanding directories (#34)", async () => {
    await withTempDirAsync(async (dir) => {
      fs.writeFileSync(path.join(dir, "schema.xsd"), XSD);
      fs.writeFileSync(path.join(dir, "readme.txt"), "not an xsd");
      fs.writeFileSync(path.join(dir, "data.xml"), "<root/>");
      const outDir = path.join(dir, "out");
      const r = await runCli([dir, "-o", outDir, "--name", "my"]);
      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(outDir, "my.zod.ts"))).toBe(true);
    });
  });

  it("errors when directory contains no .xsd files (#34)", async () => {
    await withTempDirAsync(async (dir) => {
      fs.writeFileSync(path.join(dir, "readme.txt"), "no xsd here");
      const r = await runCli([dir, "-o", dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("no .xsd files found");
    });
  });

  it("requires --name when processing multiple inputs (#82)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsd1 = path.join(dir, "a.xsd");
      const xsd2 = path.join(dir, "b.xsd");
      fs.writeFileSync(xsd1, XSD);
      fs.writeFileSync(xsd2, XSD);
      const r = await runCli([xsd1, xsd2, "-o", dir]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--name/-n is required when processing multiple XSD files");
    });
  });

  it("derives the output name from a single directory input (#34)", async () => {
    await withTempDirAsync(async (dir) => {
      const schemaDir = path.join(dir, "schemas");
      fs.mkdirSync(schemaDir);
      fs.writeFileSync(path.join(schemaDir, "one.xsd"), XSD);
      fs.writeFileSync(path.join(schemaDir, "two.xsd"), XSD);
      const outDir = path.join(dir, "out");
      const r = await runCli([schemaDir, "-o", outDir]);
      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(outDir, "schemas.zod.ts"))).toBe(true);
    });
  });

  it("does not recurse infinitely into symlinked directories (#34)", async () => {
    await withTempDirAsync(async (dir) => {
      fs.writeFileSync(path.join(dir, "schema.xsd"), XSD);
      fs.symlinkSync(dir, path.join(dir, "loop"));
      const outDir = path.join(dir, "out");
      const r = await runCli([dir, "-o", outDir, "--name", "all"]);
      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(outDir, "all.zod.ts"))).toBe(true);
    });
  });

  it("writes no output files when any XSD in a directory is invalid (#34)", async () => {
    await withTempDirAsync(async (dir) => {
      const validFile = path.join(dir, "valid.xsd");
      const brokenFile = path.join(dir, "broken.xsd");
      fs.writeFileSync(validFile, XSD);
      fs.writeFileSync(
        brokenFile,
        '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element',
      );
      const outDir = path.join(dir, "out");
      fs.mkdirSync(outDir);
      const r = await runCli([dir, "-o", outDir, "--name", "all"]);
      expect(r.code).toBe(1);
      expect(fs.existsSync(path.join(outDir, "all.zod.ts"))).toBe(false);
    });
  });

  it("skips type-definition libraries by default (#34)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "lib.xsd");
      fs.writeFileSync(
        xsdFile,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:complexType name="Orphan">
    <xs:sequence>
      <xs:element name="field" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`,
      );
      const r = await runCli([xsdFile, "-o", dir]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Skipped");
      expect(r.stdout).toContain("type-definition library");
      expect(fs.existsSync(path.join(dir, "lib.zod.ts"))).toBe(false);
    });
  });

  it("includes type-definition libraries with --include-libraries (#34)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "lib.xsd");
      fs.writeFileSync(
        xsdFile,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:complexType name="Orphan">
    <xs:sequence>
      <xs:element name="field" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`,
      );
      const r = await runCli([xsdFile, "-o", dir, "--include-libraries"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Wrote");
      expect(fs.existsSync(path.join(dir, "lib.zod.ts"))).toBe(true);
    });
  });

  it("suppresses unresolved ref warnings with --allow-missing-imports (#34)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      fs.writeFileSync(
        xsdFile,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="t:missing"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
      );
      const r = await runCli([xsdFile, "-o", dir, "--allow-missing-imports"]);
      expect(r.code).toBe(0);
      expect(r.stderr).not.toContain("warning:");
      const output = fs.readFileSync(path.join(dir, "test.zod.ts"), "utf8");
      expect(output).toContain("z.unknown()");
    });
  });

  it("suppresses informational output with --silent (#34)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      fs.writeFileSync(xsdFile, XSD);
      const r = await runCli([xsdFile, "-o", dir, "--silent"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(fs.existsSync(path.join(dir, "test.zod.ts"))).toBe(true);
    });
  });

  it("still shows warnings with --silent (#34)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      fs.writeFileSync(
        xsdFile,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element ref="t:missing"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
      );
      const r = await runCli([xsdFile, "-o", dir, "--silent"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("warning:");
    });
  });
});

describe("isDirectInvocation (#80)", () => {
  it("resolves symlinks before comparing", () => {
    withTempDir((dir) => {
      const real = path.join(dir, "cli.js");
      fs.writeFileSync(real, "// bin\n");
      const link = path.join(dir, "xsd-to-zod");
      fs.symlinkSync(real, link);
      expect(isDirectInvocation(link, pathToFileURL(real).href)).toBe(true);
      expect(isDirectInvocation(real, pathToFileURL(real).href)).toBe(true);
    });
  });

  it("returns false for other scripts, missing argv1 and dangling paths", () => {
    withTempDir((dir) => {
      const real = path.join(dir, "cli.js");
      const other = path.join(dir, "other.js");
      fs.writeFileSync(real, "// bin\n");
      fs.writeFileSync(other, "// other\n");
      expect(isDirectInvocation(other, pathToFileURL(real).href)).toBe(false);
      expect(isDirectInvocation(undefined, pathToFileURL(real).href)).toBe(false);
      expect(isDirectInvocation(path.join(dir, "gone.js"), pathToFileURL(real).href)).toBe(false);
    });
  });
});

describe("CLI validate e2e", () => {
  it("prints help on validate --help", async () => {
    const r = await runCliQuiet(["validate", "--help"]);
    expect(r.code).toBe(0);
  });

  it("validates XML against XSD (success)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      const xmlFile = path.join(dir, "test.xml");
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><root xmlns="urn:test">hello</root>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);

      const r = await runCli(["validate", xmlFile, "-x", xsdFile]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Validation passed");
      expect(r.stdout).toContain("hello");
    });
  });

  it("validates XML against XSD (failure — wrong root element)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      const xmlFile = path.join(dir, "test.xml");
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><wrong xmlns="urn:test">hello</wrong>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);

      const r = await runCli(["validate", xmlFile, "-x", xsdFile]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Validation failed");
    });
  });

  it("validates with --engine libxml2 (success)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      const xmlFile = path.join(dir, "test.xml");
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><root xmlns="urn:test">hello</root>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);

      const r = await runCli(["validate", xmlFile, "-x", xsdFile, "--engine", "libxml2"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Validation passed");
    });
  });

  it("validates with --engine libxml2 (failure — line-numbered error)", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      const xmlFile = path.join(dir, "test.xml");
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="root" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><wrong xmlns="urn:test">hello</wrong>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);

      const r = await runCli(["validate", xmlFile, "-x", xsdFile, "--engine", "libxml2"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Validation failed");
      expect(r.stderr).toMatch(/line \d+/);
    });
  });

  it("fails when xml file does not exist", async () => {
    const r = await runCli(["validate", "/nonexistent.xml", "-x", "/nonexistent.xsd"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("xml file not found");
  });

  it("fails when xsd file does not exist", async () => {
    await withTempDirAsync(async (dir) => {
      const xmlFile = path.join(dir, "test.xml");
      fs.writeFileSync(xmlFile, "<root/>");
      const r = await runCli(["validate", xmlFile, "-x", "/nonexistent.xsd"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("xsd file not found");
    });
  });

  it("fails with multiple root elements and no --root", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      const xmlFile = path.join(dir, "test.xml");
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="foo" type="xs:string"/>
  <xs:element name="bar" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><foo xmlns="urn:test">hi</foo>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);
      const r = await runCli(["validate", xmlFile, "-x", xsdFile]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("multiple root elements found");
    });
  });

  it("validates with --root selecting among multiple roots", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      const xmlFile = path.join(dir, "test.xml");
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="foo" type="xs:string"/>
  <xs:element name="bar" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><bar xmlns="urn:test">hi</bar>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);
      const r = await runCli(["validate", xmlFile, "-x", xsdFile, "--root", "{urn:test}bar"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Validation passed");
    });
  });

  it("fails when --root does not match any schema root", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      const xmlFile = path.join(dir, "test.xml");
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:element name="foo" type="xs:string"/>
</xs:schema>`;
      const xml = '<?xml version="1.0"?><foo xmlns="urn:test">hi</foo>';
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, xml);
      const r = await runCli(["validate", xmlFile, "-x", xsdFile, "--root", "{urn:test}baz"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("root element {urn:test}baz not found");
    });
  });

  it("fails when the schema declares no root elements", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "test.xsd");
      const xmlFile = path.join(dir, "test.xml");
      const xsd = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:complexType name="Orphan">
    <xs:sequence>
      <xs:element name="field" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`;
      fs.writeFileSync(xsdFile, xsd);
      fs.writeFileSync(xmlFile, "<root/>");
      const r = await runCli(["validate", xmlFile, "-x", xsdFile]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("no root elements found in schema");
    });
  });
});

describe("CLI bundle e2e", () => {
  it("prints help on bundle --help", async () => {
    const r = await runCliQuiet(["bundle", "--help"]);
    expect(r.code).toBe(0);
  });

  it("bundles a single XSD with no imports", async () => {
    await withTempDirAsync(async (dir) => {
      const xsdFile = path.join(dir, "schema.xsd");
      fs.writeFileSync(xsdFile, XSD);
      const outFile = path.join(dir, "out", "bundled.xsd");
      const r = await runCli(["bundle", xsdFile, "-o", outFile]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Bundled");
      expect(fs.existsSync(outFile)).toBe(true);
      const content = fs.readFileSync(outFile, "utf8");
      expect(content).toContain("xs:schema");
      expect(content).toContain("xs:element");
    });
  });

  it("bundles XSD with xs:include", async () => {
    await withTempDirAsync(async (dir) => {
      const typesFile = path.join(dir, "types.xsd");
      const mainFile = path.join(dir, "main.xsd");
      fs.writeFileSync(
        typesFile,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:complexType name="ItemType">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`,
      );
      fs.writeFileSync(
        mainFile,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" elementFormDefault="qualified">
  <xs:include schemaLocation="types.xsd"/>
  <xs:element name="order">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="item" type="t:ItemType"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
      );
      const outFile = path.join(dir, "bundled.xsd");
      const r = await runCli(["bundle", mainFile, "-o", outFile]);
      expect(r.code).toBe(0);
      const content = fs.readFileSync(outFile, "utf8");
      expect(content).toContain("ItemType");
      expect(content).toContain("xs:element");
      // Should not contain include elements.
      expect(content).not.toMatch(/xs:include/);
    });
  });

  it("bundles XSD with xs:import", async () => {
    await withTempDirAsync(async (dir) => {
      const libFile = path.join(dir, "lib.xsd");
      const mainFile = path.join(dir, "main.xsd");
      fs.writeFileSync(
        libFile,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:lib" xmlns:lib="urn:lib" elementFormDefault="qualified">
  <xs:complexType name="AddressType">
    <xs:sequence>
      <xs:element name="street" type="xs:string"/>
    </xs:sequence>
  </xs:complexType>
</xs:schema>`,
      );
      fs.writeFileSync(
        mainFile,
        `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:test" xmlns:t="urn:test" xmlns:lib="urn:lib" elementFormDefault="qualified">
  <xs:import namespace="urn:lib" schemaLocation="lib.xsd"/>
  <xs:element name="person">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="name" type="xs:string"/>
        <xs:element name="addr" type="lib:AddressType"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`,
      );
      const outFile = path.join(dir, "bundled.xsd");
      const r = await runCli(["bundle", mainFile, "-o", outFile]);
      expect(r.code).toBe(0);
      const content = fs.readFileSync(outFile, "utf8");
      expect(content).toContain("AddressType");
      expect(content).not.toMatch(/xs:import/);
    });
  });

  it("fails for nonexistent entry file", async () => {
    const r = await runCli(["bundle", "/nonexistent/schema.xsd"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("entry file not found");
  });
});

describe("recursive directory expansion", () => {
  it("recursively finds .xsd files in subdirectories", async () => {
    await withTempDirAsync(async (dir) => {
      const subDir = path.join(dir, "sub");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(dir, "top.xsd"), XSD);
      fs.writeFileSync(path.join(subDir, "nested.xsd"), XSD);
      fs.writeFileSync(path.join(subDir, "readme.txt"), "not xsd");
      const outDir = path.join(dir, "out");
      const r = await runCli([dir, "-o", outDir, "--name", "all"]);
      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(outDir, "all.zod.ts"))).toBe(true);
    });
  });

  it("handles a mix of files and directories", async () => {
    await withTempDirAsync(async (dir) => {
      const subDir = path.join(dir, "schemas");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(dir, "standalone.xsd"), XSD);
      fs.writeFileSync(path.join(subDir, "nested.xsd"), XSD);
      const outDir = path.join(dir, "out");
      const r = await runCli([
        path.join(dir, "standalone.xsd"),
        subDir,
        "-o",
        outDir,
        "--name",
        "all",
      ]);
      expect(r.code).toBe(0);
      expect(fs.existsSync(path.join(outDir, "all.zod.ts"))).toBe(true);
    });
  });
});

describe("expandDirectories (unit)", () => {
  it("expands a directory recursively", () => {
    withTempDir((dir) => {
      const sub = path.join(dir, "sub");
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(dir, "a.xsd"), "");
      fs.writeFileSync(path.join(sub, "b.xsd"), "");
      fs.writeFileSync(path.join(dir, "readme.txt"), "");
      expect(expandDirectories([dir])).toEqual([path.join(dir, "a.xsd"), path.join(sub, "b.xsd")]);
    });
  });

  it("returns non-existent paths as-is", () => {
    expect(expandDirectories(["nope.xsd"])).toEqual(["nope.xsd"]);
  });
});

describe("discoverDependencies (unit)", () => {
  it("finds transitive include dependencies", () => {
    withTempDir((dir) => {
      const leaf = path.join(dir, "leaf.xsd");
      const main = path.join(dir, "main.xsd");
      fs.writeFileSync(
        leaf,
        '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:element name="x" type="xs:string"/></xs:schema>',
      );
      fs.writeFileSync(
        main,
        `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:include schemaLocation="leaf.xsd"/></xs:schema>`,
      );
      const deps = discoverDependencies(main);
      expect(deps).toContain(main);
      expect(deps).toContain(leaf);
    });
  });
});

describe("stripImports (unit)", () => {
  it("removes import/include/redefine tags", () => {
    const xsd = `<xs:schema>
  <xs:import namespace="urn:lib" schemaLocation="lib.xsd"/>
  <xs:include schemaLocation="types.xsd"/>
  <xs:element name="root"/>
</xs:schema>`;
    const result = stripImports(xsd);
    expect(result).not.toMatch(/xs:import/);
    expect(result).not.toMatch(/xs:include/);
    expect(result).toContain('xs:element name="root"');
  });
});
