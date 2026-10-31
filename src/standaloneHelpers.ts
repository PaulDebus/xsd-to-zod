import { STANDALONE_HELPER_SOURCES } from "./standaloneHelperSources.generated.js";

// Helpers that generated standalone modules inline instead of importing from
// this package. The helper sources are embedded at build time by
// scripts/embed-standalone-helpers.mjs, so codegen stays filesystem-free while
// the inlined copy still comes from the runtime implementation.
const MODULES = [
  "xsdLexicals.ts",
  "xsdDateTime.ts",
  "xsdChecks.ts",
  "xsdPattern.ts",
  "choiceCheck.ts",
] as const;

type ModuleName = (typeof MODULES)[number];

// Modules whose code references names from another helper module.
const MODULE_DEPENDENCIES: ReadonlyMap<ModuleName, readonly ModuleName[]> = new Map<
  ModuleName,
  readonly ModuleName[]
>([
  ["xsdDateTime.ts", ["xsdLexicals.ts"]],
  ["xsdChecks.ts", ["xsdDateTime.ts"]],
  ["xsdPattern.ts", ["xsdLexicals.ts"]],
]);

// Names defined in both xsdLexicals.ts and xsdDateTime.ts with different
// definitions; the latter's private regexes get a module prefix when inlined.
const DUPLICATE_DATE_TIME_NAMES = [
  "DATE_RE",
  "DATE_TIME_RE",
  "TIME_RE",
  "G_YEAR_RE",
  "G_YEAR_MONTH_RE",
  "G_MONTH_RE",
  "G_MONTH_DAY_RE",
  "G_DAY_RE",
] as const;

const exportNamesCache = new Map<ModuleName, string[]>();

const moduleSource = (file: ModuleName): string => {
  const source = STANDALONE_HELPER_SOURCES[file];
  if (source === undefined) {
    throw new Error(`missing embedded standalone helper source for ${file}`);
  }
  return source;
};

const EXPORT_DECLARATION =
  /^export\s+(?:const|function|type|interface|class)\s+([A-Za-z_$][\w$]*)/gm;

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

/** Every top-level name the inlined helper modules can introduce. */
export const standaloneHelperExportNames = (): string[] => {
  const names = new Set<string>();
  for (const file of MODULES) {
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

const stripImports = (source: string): string =>
  source.replace(/^import\b[\s\S]*?\bfrom\s+["'][^"']+["'];?[ \t]*\r?\n/gm, "");

const renameDuplicateNames = (source: string): string => {
  let out = source;
  for (const name of DUPLICATE_DATE_TIME_NAMES) {
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), `DT_${name}`);
  }
  return out;
};

const normalizeModule = (file: ModuleName, source: string): string => {
  const stripped = stripImports(source);
  return file === "xsdDateTime.ts" ? renameDuplicateNames(stripped) : stripped;
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
  for (const file of MODULES) {
    if (moduleExportNames(file).some((name) => needed.has(name))) {
      includeModule(file);
    }
  }

  const blocks: string[] = [];
  for (const file of MODULES) {
    if (!included.has(file)) {
      continue;
    }
    if (file === "choiceCheck.ts") {
      blocks.push(CHOICE_META_TYPE);
    }
    blocks.push(normalizeModule(file, moduleSource(file)));
  }
  if (usage.coerceXmlValue) {
    blocks.push(COERCE_XML_VALUE_SOURCE);
  }
  return blocks.join("\n");
};
