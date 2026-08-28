import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defineConfig,
  findConfigFile,
  loadConfig,
  loadConfigFile,
  mergeConfig,
} from "../src/config.js";
import { Xsd2ZodError } from "../src/errors.js";
import { withTempDir, withTempDirAsync } from "./helpers.js";

const expectErrorCode = async (fn: () => Promise<unknown>, code: string): Promise<Xsd2ZodError> => {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Xsd2ZodError);
    expect((e as Xsd2ZodError).code).toBe(code);
    return e as Xsd2ZodError;
  }
  throw new Error(`expected Xsd2ZodError with code ${code}`);
};

describe("loadConfigFile", () => {
  it("loads a JSON config", () =>
    withTempDirAsync(async (dir) => {
      const file = path.join(dir, "xsd-to-zod.config.json");
      fs.writeFileSync(file, JSON.stringify({ datatypes: "structured", silent: true }));
      const config = await loadConfigFile(file);
      expect(config).toEqual({ datatypes: "structured", silent: true });
    }));

  it("loads a JS config with a default export", () =>
    withTempDirAsync(async (dir) => {
      const file = path.join(dir, "xsd-to-zod.config.mjs");
      fs.writeFileSync(file, 'export default { out: "gen", format: true };\n');
      const config = await loadConfigFile(file);
      expect(config).toEqual({ out: "gen", format: true });
    }));

  it("loads the xsd-to-zod field of a package.json", () =>
    withTempDirAsync(async (dir) => {
      const file = path.join(dir, "package.json");
      fs.writeFileSync(
        file,
        JSON.stringify({ name: "app", "xsd-to-zod": { allowMissingImports: true } }),
      );
      const config = await loadConfigFile(file);
      expect(config).toEqual({ allowMissingImports: true });
    }));

  it("rejects malformed JSON", () =>
    withTempDirAsync(async (dir) => {
      const file = path.join(dir, "xsd-to-zod.config.json");
      fs.writeFileSync(file, "{ nope");
      const e = await expectErrorCode(() => loadConfigFile(file), "config-invalid");
      expect(e.file).toBe(file);
    }));

  it("rejects unknown keys and wrong types", () =>
    withTempDirAsync(async (dir) => {
      const unknownKey = path.join(dir, "xsd-to-zod.config.json");
      fs.writeFileSync(unknownKey, JSON.stringify({ cosmeticNamez: true }));
      await expectErrorCode(() => loadConfigFile(unknownKey), "config-invalid");

      const wrongType = path.join(dir, "other.config.json");
      fs.writeFileSync(wrongType, JSON.stringify({ silent: "yes" }));
      await expectErrorCode(() => loadConfigFile(wrongType), "config-invalid");

      const badEnum = path.join(dir, "enum.config.json");
      fs.writeFileSync(badEnum, JSON.stringify({ datatypes: "yaml" }));
      await expectErrorCode(() => loadConfigFile(badEnum), "config-invalid");
    }));

  it("rejects a JS config without a default export", () =>
    withTempDirAsync(async (dir) => {
      const file = path.join(dir, "xsd-to-zod.config.mjs");
      fs.writeFileSync(file, "export const out = 1;\n");
      const e = await expectErrorCode(() => loadConfigFile(file), "config-invalid");
      expect(e.message).toContain("default export");
    }));

  it("reports JS configs that fail to load", () =>
    withTempDirAsync(async (dir) => {
      const file = path.join(dir, "xsd-to-zod.config.mjs");
      fs.writeFileSync(file, 'throw new Error("boom");\n');
      await expectErrorCode(() => loadConfigFile(file), "config-load-failed");
    }));
});

describe("findConfigFile", () => {
  it("returns undefined when no config exists", () =>
    withTempDir((dir) => {
      expect(findConfigFile(dir)).toBeUndefined();
    }));

  it("finds a config in the given directory", () =>
    withTempDir((dir) => {
      const file = path.join(dir, "xsd-to-zod.config.json");
      fs.writeFileSync(file, "{}");
      expect(findConfigFile(dir)).toEqual({ path: file, kind: "file" });
    }));

  it("walks up to a parent directory", () =>
    withTempDir((dir) => {
      const file = path.join(dir, "xsd-to-zod.config.json");
      fs.writeFileSync(file, "{}");
      const nested = path.join(dir, "a", "b");
      fs.mkdirSync(nested, { recursive: true });
      expect(findConfigFile(nested)?.path).toBe(file);
    }));

  it("prefers a dedicated config over package.json, and .js over .json", () =>
    withTempDir((dir) => {
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ "xsd-to-zod": { silent: true } }),
      );
      const jsonConfig = path.join(dir, "xsd-to-zod.config.json");
      fs.writeFileSync(jsonConfig, "{}");
      expect(findConfigFile(dir)).toEqual({ path: jsonConfig, kind: "file" });

      const jsConfig = path.join(dir, "xsd-to-zod.config.js");
      fs.writeFileSync(jsConfig, "export default {};\n");
      expect(findConfigFile(dir)).toEqual({ path: jsConfig, kind: "file" });
    }));

  it("falls back to package.json with an xsd-to-zod field", () =>
    withTempDir((dir) => {
      const pkg = path.join(dir, "package.json");
      fs.writeFileSync(pkg, JSON.stringify({ "xsd-to-zod": { silent: true } }));
      expect(findConfigFile(dir)).toEqual({ path: pkg, kind: "packageJson" });
    }));

  it("ignores a package.json without an xsd-to-zod field", () =>
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app" }));
      expect(findConfigFile(dir)).toBeUndefined();
    }));
});

describe("loadConfig", () => {
  it("returns an empty config when nothing is found", () =>
    withTempDirAsync(async (dir) => {
      expect(await loadConfig({ cwd: dir })).toEqual({ config: {} });
    }));

  it("auto-discovers the nearest config", () =>
    withTempDirAsync(async (dir) => {
      const file = path.join(dir, "xsd-to-zod.config.json");
      fs.writeFileSync(file, JSON.stringify({ silent: true }));
      const loaded = await loadConfig({ cwd: dir });
      expect(loaded.config).toEqual({ silent: true });
      expect(loaded.source).toBe(file);
    }));

  it("ignores discovery with noConfig", () =>
    withTempDirAsync(async (dir) => {
      fs.writeFileSync(path.join(dir, "xsd-to-zod.config.json"), JSON.stringify({ silent: true }));
      expect(await loadConfig({ cwd: dir, noConfig: true })).toEqual({ config: {} });
    }));

  it("loads an explicit configPath (relative to cwd)", () =>
    withTempDirAsync(async (dir) => {
      fs.writeFileSync(path.join(dir, "xsd-to-zod.config.json"), JSON.stringify({ silent: true }));
      fs.writeFileSync(path.join(dir, "custom.json"), JSON.stringify({ format: true }));
      const loaded = await loadConfig({ cwd: dir, configPath: "custom.json" });
      expect(loaded.config).toEqual({ format: true });
      expect(loaded.source).toBe(path.join(dir, "custom.json"));
    }));

  it("throws config-not-found for a missing explicit configPath", () =>
    withTempDirAsync(async (dir) => {
      await expectErrorCode(
        () => loadConfig({ cwd: dir, configPath: "gone.json" }),
        "config-not-found",
      );
    }));
});

describe("mergeConfig", () => {
  it("lets overrides win when defined", () => {
    expect(mergeConfig({ silent: true, out: "a" }, { out: "b" })).toEqual({
      silent: true,
      out: "b",
    });
  });

  it("does not clobber base values with undefined overrides", () => {
    expect(mergeConfig({ silent: true }, { silent: undefined, out: "b" })).toEqual({
      silent: true,
      out: "b",
    });
  });
});

describe("defineConfig", () => {
  it("returns its argument unchanged", () => {
    const config = { datatypes: "structured" as const };
    expect(defineConfig(config)).toBe(config);
  });
});
