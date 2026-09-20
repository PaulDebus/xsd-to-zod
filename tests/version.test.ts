import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PACKAGE_VERSION } from "../src/version.js";

// The mismatch warning fires once per process — reset modules for a fresh
// runtime instance per test. xmlRegistry is a globalThis singleton, so
// registrations survive the reset.
const freshRuntime = async (): Promise<typeof import("../src/runtime.js")> => {
  vi.resetModules();
  return import("../src/runtime.js");
};

const stampedRootSchema = async (stamp?: string): Promise<z.ZodString> => {
  const { xmlRegistry } = await import("../src/xmlMeta.js");
  const schema = z.string();
  schema.register(xmlRegistry, {
    root: "{}root",
    ...(stamp === undefined ? {} : { generatedBy: stamp }),
  });
  return schema;
};

describe("PACKAGE_VERSION", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});

describe("generator version mismatch warning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns once per process on a major mismatch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { safeParseXml } = await freshRuntime();
    const schema = await stampedRootSchema("xsd-to-zod@0.1.0");
    expect(safeParseXml(schema, "<root>hi</root>").success).toBe(true);
    expect(safeParseXml(schema, "<root>hi</root>").success).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("xsd-to-zod@0.1.0");
    expect(warn.mock.calls[0]?.[0]).toContain("regenerate");
  });

  it("warns on serializeXml too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serializeXml } = await freshRuntime();
    const schema = await stampedRootSchema("xsd-to-zod@99.0.0");
    serializeXml(schema, "hi");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays silent for the current version", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { safeParseXml } = await freshRuntime();
    const schema = await stampedRootSchema(`xsd-to-zod@${PACKAGE_VERSION}`);
    safeParseXml(schema, "<root>hi</root>");
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent without a stamp (hand-written schemas)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { safeParseXml } = await freshRuntime();
    const schema = await stampedRootSchema();
    safeParseXml(schema, "<root>hi</root>");
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent within a nonzero major", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { safeParseXml } = await freshRuntime();
    const major = PACKAGE_VERSION.split(".")[0] ?? "0";
    const schema = await stampedRootSchema(`xsd-to-zod@${major}.0.0`);
    safeParseXml(schema, "<root>hi</root>");
    // 0.x versions promise nothing even across minors; from 1.0 on, an older
    // same-major version stays silent.
    if (major === "0") {
      expect(warn).toHaveBeenCalledTimes(1);
    } else {
      expect(warn).not.toHaveBeenCalled();
    }
  });
});
