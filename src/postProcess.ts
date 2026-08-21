import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const run = (command: string, args: string[], cwd: string): void => {
  // .cmd shims (Windows) can only be spawned through a shell; quote the path
  // so spaces in it survive the command line.
  const isCmdShim = command.endsWith(".cmd");
  const result = spawnSync(isCmdShim ? `"${command}"` : command, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    shell: isCmdShim,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
};

// Resolve the tool's local bin instead of spawning `npx <tool>`: faster, and
// portable — `npx` is a .cmd shim on Windows and fails there without shell.
// Only spawn what the platform can execute: on Windows the extension-less
// shim is a POSIX shell script and equally fails without a shell, so pick the
// .cmd shim there (spawned with shell in run()).
// Walks up from cwd so a tool installed at a monorepo root is still found
// when the CLI runs in a package subdirectory.
const walkUp = (start: string, test: (dir: string) => string | boolean | undefined): string | boolean | undefined => {
  let dir = start;
  for (;;) {
    const hit = test(dir);
    if (hit) {
      return hit;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
};

const binPath = (cwd: string, binName: string): string | undefined => {
  const fileName = process.platform === "win32" ? `${binName}.cmd` : binName;
  return walkUp(cwd, (dir) => {
    const full = path.join(dir, "node_modules", ".bin", fileName);
    return fs.existsSync(full) ? full : undefined;
  }) as string | undefined;
};

const runTool = (binName: string, args: string[], cwd: string): boolean => {
  const bin = binPath(cwd, binName);
  if (!bin) {
    return false;
  }
  run(bin, args, cwd);
  return true;
};

// ESLint v9 only honours flat config; legacy .eslintrc* files are ignored and
// eslint still exits non-zero, so they must not count as "has config" (#74).
const CONFIG_FILES: Record<"biome" | "prettier" | "eslint", string[]> = {
  biome: ["biome.json", "biome.jsonc"],
  prettier: [
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yml",
    ".prettierrc.yaml",
    ".prettierrc.js",
    ".prettierrc.mjs",
    ".prettierrc.cjs",
    "prettier.config.js",
    "prettier.config.mjs",
    "prettier.config.cjs",
  ],
  eslint: ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"],
};

const hasConfig = (cwd: string, tool: keyof typeof CONFIG_FILES): boolean =>
  (walkUp(cwd, (dir) =>
    CONFIG_FILES[tool].some((name) => fs.existsSync(path.join(dir, name))),
  ) as boolean) ?? false;

// Biome and Prettier exit non-zero on file types they do not support (e.g.
// the bundled .xsd), so only JS/TS output is routed to them.
const JS_TS_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// Returns true when a formatter actually ran, so the CLI can warn that a
// --format request produced no formatting instead of failing silently.
export const runPostGenerationFormatting = (
  generatedFiles: string[],
  cwd = process.cwd(),
): boolean => {
  if (generatedFiles.length === 0) {
    return false;
  }

  const jsTsFiles = generatedFiles.filter((file) => JS_TS_RE.test(file));

  const runBiome = (): boolean => {
    if (jsTsFiles.length === 0 || !runTool("biome", ["format", "--write", ...jsTsFiles], cwd)) {
      return false;
    }
    runTool("biome", ["lint", "--write", ...jsTsFiles], cwd);
    return true;
  };
  const runPrettier = (): boolean =>
    jsTsFiles.length > 0 && runTool("prettier", ["--write", ...jsTsFiles], cwd);

  // A tool with a project config wins over one that would run on defaults, so
  // the output matches the project's style. Biome and Prettier both format
  // fine without a config — the binary alone is enough as a fallback; gating
  // on a config file silently skipped formatting in default setups.
  if (hasConfig(cwd, "biome") && runBiome()) {
    return true;
  }
  if (hasConfig(cwd, "prettier") && runPrettier()) {
    return true;
  }
  if (runBiome() || runPrettier()) {
    return true;
  }

  // ESLint v9 exits non-zero without a config file — only run it when one
  // exists, so a config-less project doesn't crash the CLI after the output
  // files were already written (#74).
  if (hasConfig(cwd, "eslint")) {
    return runTool("eslint", ["--fix", ...generatedFiles], cwd);
  }
  return false;
};
