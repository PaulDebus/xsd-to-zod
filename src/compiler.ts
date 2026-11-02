// Build-time compiler API: XSD parsing, IR → Zod code generation, remote
// schema acquisition, and post-generation formatting.
//
// This entry is separate from the package root on purpose. Generated modules
// import the root runtime (`.`) and must keep working across 1.x; the compiler
// is a build-time tool that may be Node-only, may pull in network/filesystem
// dependencies, and may gain new output targets without expanding the runtime
// surface. Import from `xsd-to-zod` for `parseXml`/`serializeXml`/`xmlRegistry`
// and from `xsd-to-zod/compiler` for code generation.

export type { DownloadedSchemaClosure, DownloadSchemaOptions } from "./download.js";
export { downloadSchemaClosure } from "./download.js";
export { Xsd2ZodError } from "./errors.js";
export type { FetchSchemaResolver, FetchSchemaResolverOptions } from "./fetchSchema.js";
export { createFetchSchemaResolver, describeSchemaBase } from "./fetchSchema.js";
export type { IrToZodOptions } from "./irToZod.js";
export { irToZod } from "./irToZod.js";
export type {
  ParseXsdOptions,
  ResolvedSchema,
  ResolveSchema,
  SchemaResolutionBase,
} from "./parseXsd.js";
export { parseXsd } from "./parseXsd.js";
export { runPostGenerationFormatting } from "./postProcess.js";
export { readXmlFile } from "./readXmlFile.js";
export type {
  CachedRemoteSchema,
  FetchedRemoteSchema,
  RemoteSchemaLockEntry,
  RemoteSchemaStoreOptions,
} from "./remoteSchemaStore.js";
export { REMOTE_SCHEMA_LOCKFILE, RemoteSchemaStore } from "./remoteSchemaStore.js";
export type {
  Cardinality,
  ChoiceArrayBranch,
  ChoiceArrayField,
  ChoiceGroupGuard,
  ComplexTypeDef,
  Diagnostic,
  DiagnosticKind,
  ElementDef,
  Facet,
  FieldKind,
  IdentityConstraint,
  IdentityPath,
  IdentityStep,
  IrField,
  QName,
  SimpleTypeDef,
  WildcardDef,
  XsdIr,
} from "./types.js";
