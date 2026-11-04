import {
  STANDALONE_HELPER_MODULE_NAMES,
  STANDALONE_HELPER_SOURCES,
} from "./standaloneHelperSources.generated.js";

// Helpers that generated standalone modules inline instead of importing from
// this package. The helper sources are embedded at build time by
// scripts/embed-standalone-helpers.mjs, so codegen stays filesystem-free while
// the inlined copy still comes from the runtime implementation. The generated
// module list is the single source of truth for which files are embedded.
type ModuleName = (typeof STANDALONE_HELPER_MODULE_NAMES)[number];

// Modules whose code references names from another helper module.
const MODULE_DEPENDENCIES: ReadonlyMap<ModuleName, readonly ModuleName[]> = new Map<
  ModuleName,
  readonly ModuleName[]
>([
  ["xsdDateTime.ts", ["xsdLexicals.ts"]],
  ["xsdChecks.ts", ["xsdDateTime.ts"]],
  ["xsdPattern.ts", ["xsdLexicals.ts"]],
]);

const exportNamesCache = new Map<ModuleName, string[]>();
const topLevelNamesCache = new Map<ModuleName, string[]>();

const moduleSource = (file: ModuleName): string => {
  const source = STANDALONE_HELPER_SOURCES[file];
  if (source === undefined) {
    throw new Error(`missing embedded standalone helper source for ${file}`);
  }
  return source;
};

const EXPORT_DECLARATION =
  /^export\s+(?:const|function|type|interface|class)\s+([A-Za-z_$][\w$]*)/gm;
// Top-level declarations sit at column 0 in these sources; nested ones are
// indented, so the anchor distinguishes them.
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;

const moduleExportNames = (file: ModuleName): string[] => {
  const cached = exportNamesCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const names: string[] = [];
  for (const match of moduleSource(file).matchAll(EXPORT_DECLARATION)) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  exportNamesCache.set(file, names);
  return names;
};

const moduleTopLevelNames = (file: ModuleName): string[] => {
  const cached = topLevelNamesCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const names: string[] = [];
  for (const match of moduleSource(file).matchAll(TOP_LEVEL_DECLARATION)) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  topLevelNamesCache.set(file, names);
  return names;
};

/** Every top-level name the inlined helper modules can introduce. */
export const standaloneHelperExportNames = (): string[] => {
  const names = new Set<string>();
  for (const file of STANDALONE_HELPER_MODULE_NAMES) {
    for (const name of moduleExportNames(file)) {
      names.add(name);
    }
  }
  return [...names];
};

// The fallback coercion for union/list attribute defaults. It probes plausible
// lexical renderings through the schema itself, so it stays zod-only; the
// runtime's full lexical machinery is not available in standalone output.
const COERCE_XML_VALUE_SOURCE = String.raw`
export const coerceXmlValue = <S extends z.ZodType>(lexical: string, schema: S): z.output<S> => {
  const trimmed = lexical.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "");
  const attempts: unknown[] = [lexical];
  if (trimmed !== lexical) {
    attempts.push(trimmed);
  }
  if (trimmed !== "") {
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      attempts.push(numeric);
    }
    if (trimmed === "true" || trimmed === "1") {
      attempts.push(true);
    }
    if (trimmed === "false" || trimmed === "0") {
      attempts.push(false);
    }
    attempts.push(trimmed.split(/[\t\n\r ]+/).filter(Boolean));
  }
  for (const attempt of attempts) {
    const parsed = schema.safeParse(attempt);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return schema.parse(lexical);
};
`;

const CHOICE_META_TYPE = `
type XmlChoiceMeta = {
  required: boolean;
  repeated: boolean;
  message: string;
  branches: { id: string; keys: { key: string; required: boolean }[] }[];
  guard?: { group: string; branch: string };
  wildcard?: true;
  enforce?: true;
};
`;

// Helper modules must use only statement imports (`import ... from "..."`);
// side-effect imports and re-exports have no module graph to resolve against in
// the inlined copy, so fail loudly instead of emitting a broken import.
const stripImports = (source: string): string => {
  const stripped = source.replace(/^import\b[\s\S]*?\bfrom\s+["'][^"']+["'];?[ \t]*\r?\n/gm, "");
  if (/^import\b/m.test(stripped) || /^export\b.*\bfrom\s+["']/m.test(stripped)) {
    throw new Error(
      "standalone helper module contains an import or re-export that cannot be inlined",
    );
  }
  return stripped;
};

const moduleStem = (file: ModuleName): string =>
  file.replace(/\.ts$/, "").replace(/[^A-Za-z0-9_]/g, "_");

const uniqueReplacement = (base: string, taken: ReadonlySet<string>): string => {
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}${n}`;
    n += 1;
  }
  return candidate;
};

export type StandaloneHelperUsage = {
  totalDigits: boolean;
  fractionDigits: boolean;
  coerceXmlValue: boolean;
  choices: boolean;
};

/**
 * Source block to inline into a standalone generated module. Includes only the
 * helper modules the generated code references, plus their dependencies.
 */
export const standaloneHelperSource = (
  usedHelpers: ReadonlySet<string>,
  usage: StandaloneHelperUsage,
): string => {
  const needed = new Set(usedHelpers);
  needed.delete("coerceXmlValue");
  if (usage.totalDigits) {
    needed.add("xsdTotalDigits");
  }
  if (usage.fractionDigits) {
    needed.add("xsdFractionDigits");
  }
  if (usage.choices) {
    needed.add("choiceGroupIssues");
  }

  const included = new Set<ModuleName>();
  const includeModule = (file: ModuleName): void => {
    if (included.has(file)) {
      return;
    }
    included.add(file);
    for (const dependency of MODULE_DEPENDENCIES.get(file) ?? []) {
      includeModule(dependency);
    }
  };
  for (const file of STANDALONE_HELPER_MODULE_NAMES) {
    if (moduleExportNames(file).some((name) => needed.has(name))) {
      includeModule(file);
    }
  }

  const blocks: string[] = [];
  // Concatenated modules share one scope. Rename later modules' private
  // top-level declarations that collide with an already-inlined name so that
  // inlining never produces a duplicate identifier. Exported names cannot be
  // renamed safely (generated code refers to them), so a collision there is a
  // hard error rather than a silent break.
  const seen = new Set<string>();
  for (const file of STANDALONE_HELPER_MODULE_NAMES) {
    if (!included.has(file)) {
      continue;
    }
    if (file === "choiceCheck.ts") {
      blocks.push(CHOICE_META_TYPE);
      seen.add("XmlChoiceMeta");
    }
    const exported = new Set(moduleExportNames(file));
    const declarations = moduleTopLevelNames(file);
    const renames = new Map<string, string>();
    const taken = new Set([...seen, ...declarations]);
    for (const name of declarations) {
      if (!seen.has(name)) {
        continue;
      }
      if (exported.has(name)) {
        throw new Error(
          `standalone helper module ${file} exports "${name}", which collides with an earlier inlined module`,
        );
      }
      const replacement = uniqueReplacement(`__${moduleStem(file)}_${name}`, taken);
      renames.set(name, replacement);
      taken.add(replacement);
    }
    let block = stripImports(moduleSource(file));
    for (const [from, to] of renames) {
      block = block.replace(new RegExp(`\\b${from}\\b`, "g"), to);
    }
    for (const name of declarations) {
      seen.add(renames.get(name) ?? name);
    }
    blocks.push(block);
  }
  if (usage.coerceXmlValue) {
    blocks.push(COERCE_XML_VALUE_SOURCE);
  }
  return blocks.join("\n");
};
