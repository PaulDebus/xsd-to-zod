// Project configuration for xsd-to-zod: an optional config file the CLI
// discovers by walking up from the working directory (same pattern as
// postProcess.ts uses for formatter configs). Only the CLI auto-loads it —
// the programmatic API takes explicit options, so library consumers are never
// surprised by files on disk.
//
// Precedence (highest wins): CLI flags > --config file > auto-discovered
// config > built-in defaults. Every key mirrors an existing generate-command
// flag; opt-in codegen features add their key here when they land.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Xsd2ZodError } from "./errors.js";

export const xsdToZodConfigSchema = z
  .object({
    /** Output directory (CLI: -o/--out). */
    out: z.string().optional(),
    /** Basename for the generated file (CLI: -n/--name). */
    name: z.string().optional(),
    /** Run formatter on the generated file (CLI: -f/--format). */
    format: z.boolean().optional(),
    /** Include type-definition-only schemas (CLI: --include-libraries). */
    includeLibraries: z.boolean().optional(),
    /** Suppress warnings for unresolved XSD references (CLI: --allow-missing-imports). */
    allowMissingImports: z.boolean().optional(),
    /** Suppress informational output (CLI: --silent). */
    silent: z.boolean().optional(),
    /** Mapping for the XSD date/time builtins (CLI: --datatypes). */
    datatypes: z.enum(["string", "structured"]).optional(),
  })
  // Unknown keys are rejected so typos fail loud instead of being ignored.
  .strict();

export type XsdToZodConfig = z.infer<typeof xsdToZodConfigSchema>;

/** Identity helper for typed config files (`// @ts-check` / TS language server). */
export const defineConfig = (config: XsdToZodConfig): XsdToZodConfig => config;

// Dedicated files win over the package.json field within one directory; the
// order inside CONFIG_FILE_NAMES decides between dedicated candidates.
const CONFIG_FILE_NAMES = [
  "xsd-to-zod.config.js",
  "xsd-to-zod.config.mjs",
  "xsd-to-zod.config.cjs",
  "xsd-to-zod.config.json",
];

type ConfigKind = "file" | "packageJson";

type FoundConfig = { path: string; kind: ConfigKind };

const configKindFor = (path: string): ConfigKind =>
  path.endsWith("package.json") ? "packageJson" : "file";

const packageJsonConfigPath = (dir: string): string | undefined => {
  const candidate = join(dir, "package.json");
  if (!existsSync(candidate)) {
    return undefined;
  }
  let content: string;
  try {
    content = readFileSync(candidate, "utf8");
  } catch {
    // An unreadable package.json is not a config source; keep walking up.
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // Malformed JSON that mentions our key should fail loudly instead of
    // being silently ignored while walking up.
    if (content.includes("xsd-to-zod")) {
      throw new Xsd2ZodError(
        "config-invalid",
        `Invalid config in ${candidate}: ${e instanceof Error ? e.message : String(e)}`,
        { file: candidate },
      );
    }
    return undefined;
  }
  if (parsed !== null && typeof parsed === "object" && "xsd-to-zod" in parsed) {
    return candidate;
  }
  return undefined;
};

/** Find the nearest config by walking up from `cwd`; undefined when none exists. */
export const findConfigFile = (cwd: string): FoundConfig | undefined => {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return { path: candidate, kind: "file" };
      }
    }
    const pkg = packageJsonConfigPath(dir);
    if (pkg !== undefined) {
      return { path: pkg, kind: "packageJson" };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
};

const invalidConfig = (path: string, detail: string): Xsd2ZodError =>
  new Xsd2ZodError("config-invalid", `Invalid config in ${path}: ${detail}`, { file: path });

/** Read and validate one config source (dedicated file or package.json field). */
export const loadConfigFile = async (
  path: string,
  kind: ConfigKind = configKindFor(path),
): Promise<XsdToZodConfig> => {
  let raw: unknown;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    let mod: { default?: unknown };
    try {
      // Bust the ESM cache so repeated loads of the same temp file pick up
      // fresh content (tests reuse paths across cases in the same process).
      const url = `${pathToFileURL(path).href}?t=${Date.now()}`;
      mod = (await import(url)) as { default?: unknown };
    } catch (e) {
      throw new Xsd2ZodError(
        "config-load-failed",
        `Failed to load config ${path}: ${e instanceof Error ? e.message : String(e)}`,
        { file: path },
      );
    }
    if (mod.default === undefined) {
      throw invalidConfig(path, "JS config must have a default export");
    }
    raw = mod.default;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw invalidConfig(path, e instanceof Error ? e.message : String(e));
    }
    raw =
      kind === "packageJson" && parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)["xsd-to-zod"]
        : parsed;
  }
  const result = xsdToZodConfigSchema.safeParse(raw);
  if (!result.success) {
    throw invalidConfig(path, z.prettifyError(result.error));
  }
  return result.data;
};

export type LoadedConfig = {
  config: XsdToZodConfig;
  /** The file the config came from; undefined when no config was found or loading was disabled. */
  source?: string;
};

/**
 * Resolve the effective config for a CLI run: an explicit --config path (which
 * must exist), the nearest auto-discovered config, or nothing when --no-config
 * is set or no config exists.
 */
export const loadConfig = async (opts: {
  cwd: string;
  configPath?: string | undefined;
  noConfig?: boolean | undefined;
}): Promise<LoadedConfig> => {
  if (opts.noConfig) {
    return { config: {} };
  }
  if (opts.configPath !== undefined) {
    const path = resolve(opts.cwd, opts.configPath);
    if (!existsSync(path)) {
      throw new Xsd2ZodError("config-not-found", `Config file not found: ${path}`, {
        file: path,
      });
    }
    return { config: await loadConfigFile(path), source: path };
  }
  const found = findConfigFile(opts.cwd);
  if (found === undefined) {
    return { config: {} };
  }
  return { config: await loadConfigFile(found.path, found.kind), source: found.path };
};

// Copy only defined values: an absent CLI flag must not clobber a configured
// value with undefined (commander leaves unparsed flags undefined).
const definedOnly = <T extends object>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;

/** Merge config layers; values from `overrides` win when defined. */
export const mergeConfig = (
  base: XsdToZodConfig,
  overrides: Partial<XsdToZodConfig>,
): XsdToZodConfig => ({ ...base, ...definedOnly(overrides) });
