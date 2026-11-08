# Changelog

All notable changes to `xsd-to-zod` are documented here. This project follows
[Semantic Versioning](https://semver.org/); the 0.x line made no API-stability
promise, and generated files must be regenerated with the version you run.

## 1.0.0 — 2026-11-07

1.0 is a deliberate clean break. The 0.4 `--ergonomic` preview is now the only
output shape, generated identifiers follow the new naming defaults, and the
package is split into a runtime entry and a build-time compiler entry. There is
no `--compat` mode: regenerate artifacts with the version you run at runtime.
Read the [migration guide](docs/MIGRATION.md) for the full upgrade path from
0.3.1 and 0.4.

### Breaking changes

- **Ergonomic output is the default and only shape.** Element types with no
  element content and a single simple attribute collapse to scalar fields;
  attribute keys lose their `@` prefix (a colliding attribute keeps it, with a warning
  and a generated comment); an eligible repeated `xs:choice` becomes one
  ordered array of tagged items; root anonymous types take the bare element
  name (`anonymous_Library_Type` → `Library`), while nested anonymous types
  keep `Parent_Child_Type`. The `--ergonomic` flag and
  `{ ergonomic: true }` option are removed.
- **Runtime and build-time APIs are separate entry points.** `xsd-to-zod`
  exports the runtime (`parseXml`, `safeParseXml`, `serializeXml`,
  `xmlRegistry`, and the helpers generated modules import) plus the optional
  `xsd-to-zod/validate` tier. `parseXsd`, `irToZod`, `IrToZodOptions`,
  `ParseXsdOptions`, the IR types, `runPostGenerationFormatting`,
  `readXmlFile`, `Xsd2ZodError`, and the remote fetch/download helpers moved
  to `xsd-to-zod/compiler`; internal helpers are no longer exported from the
  package root.
- **CLI.** A real `generate` subcommand now exists alongside the default
  positional form. `--ergonomic` is removed.

### Features

- **Standalone output.** `--standalone` / `{ standalone: true }` emits a module
  that imports only `zod`: no `xmlRegistry` and no `xsd-to-zod` import, with
  helper checks inlined and `xs:choice` enforced by generated refinements.
  `parseXml`/`serializeXml` do not apply to these schemas.
- **Compiler entry point.** `xsd-to-zod/compiler` exposes the build-time API
  for programmatic generation in the CLI and in consumer build scripts.
- **`serializeXml` prefix preferences.** Prefixes declared by the source
  schemas are inferred and reused, and explicit prefix preferences can
  override them.

### Coming from 0.3.1

The 0.4 line also requires regeneration and review. In summary (the migration
guide has the details):

- Programmatic compilation is asynchronous: `await parseXsd(...)`.
- `zod@^4.4.3` is a required peer dependency; `libxml2-wasm` stays optional.
- Integers default to `number`; use `--integers bigint` for exact large values.
- Decimals default to float64 `number`; use `--decimal string` for exact
  canonical lexicals.
- Identity constraints are enforced by default (opt out with
  `{ identityConstraints: false }`).
- Lexical retention is opt-in via `{ retainLexicals: true }`.
- Absent optional repeated elements are omitted instead of becoming `[]`.
- `serializeXml` validates input and applies defaults.
- Structured partial dates preserve their timezone offset.

### Testing

- A new API-surface test pins the runtime/compiler export split, and the
  packed-consumer smoke test and golden fixtures cover the 1.0 output shape.

## 0.4.0 — 2026-10-27

0.4.0 is the **last planned 0.x release before the 1.0 flip**. It keeps the
pre-1.0 output shape by default and leaves the deliberate breaking change
(ergonomic output + naming + public API) to 1.0.

**This is not a wholly non-breaking upgrade from 0.3.1.** Regenerate artifacts
and review the diff; several defaults changed. Read the
[0.3.1 → 0.4 → 1.0 migration preview](docs/MIGRATION.md) before upgrading. To
stay on published behavior, pin both generator and runtime to `0.3.1`; after
migrating, pin `~0.4.0` to defer 1.0.

### Highlights

- **`--ergonomic` preview** of the 1.0 output shape: scalar value-wrapper
  collapse, attribute keys without `@` (with collision fallback), and repeated
  `xs:choice` as one ordered array of tagged items.
- **Exact decimal mode** (`--decimal string`): arbitrary-precision `xs:decimal`
  as its canonical lexical, never rounded.
- **Identity constraints enforced by default**: `xs:key`, `xs:unique`, and
  `xs:keyref`, with opt-out for intentionally partial documents.
- **Remote schema support**: `http(s)` inputs, resolver API, integrity-pinned
  lockfile and cache, conditional revalidation, and a `download` subcommand for
  vendoring schema closures.
- **Pre-1.0 review and optimization round**: correctness fixes across parser,
  generator, and runtime, plus smaller generated output and a faster runtime
  hot path.

### Features

- Remote schemas: http(s) entry points and imports, host allowlists, resource
  caps, proxy support, `xsd-to-zod.lock.json` pinning with `--frozen` /
  `--offline`, ETag revalidation (`--revalidate`), and `download` for offline
  vendoring.
- Ergonomic preview: wrapper collapse, `@`-stripped attribute keys, and
  document-ordered tagged arrays for supported repeated choices; identity
  constraints work with the ergonomic shape.
- Exact `xs:decimal` via `--decimal string` / `{ decimal: "string" }`; float64
  remains the default.
- Lexical retention is now opt-in via
  `parseXml(schema, xml, { retainLexicals: true })`; lexical-space-constrained
  fields still retain automatically.
- `xs:integer` defaults to `z.number().int()` (JSON-safe, exact below 2^53);
  `--integers bigint` restores the previous exact mapping.
- Named-type schemas are exported from generated files, and `serializeXml`
  accepts generated input types and applies defaults.
- Facet and validation coverage: order facets on ordered date/time/duration and
  string types, QName lexicals, `fractionDigits` on integer-derived types,
  value-space enum comparison, `block`/`blockDefault` against `xsi:type`,
  optional-group particles as a unit, wildcard occurrence budgets, and rejection
  of duplicate `maxOccurs=1` elements.
- Generator version stamp with a runtime-mismatch warning, friendly anonymous
  root type names, and generation-time warnings for constructs the zod tier
  drops.
- New conformance coverage: full-corpus invalid-instance runs, an
  invalid-schema harness mode, and the NIST datatype pilot widened to all
  datatype families.
- Documentation: 1.0 output-default decisions, mixed-content `_text`
  concatenation recorded as a permanent 1.x decision, and the migration preview.
- Relicensed under MIT.

### Fixes

- Parser: inheritance of required attributes and simple-content attributes,
  global attribute `fixed`/`default`, chameleon redefine namespaces, whitespace
  in `memberTypes`, local namespace propagation, simple-content restriction
  facets, and synthetic-name / redefine collisions.
- Generator: singleton-union metadata clobbering, union default selection,
  strict TypeScript validity for supported constructs, exact-lexical decimal
  facet checks, UTF-16 vs Unicode length counting, structured-list
  serialization, and shared cycle-tracking state.
- Runtime: text/CDATA ordering, per-occurrence `xsi:type` replay, QName
  namespace context across documents, structured partial-date timezone
  preservation, identity value spaces and descendant paths, numeric lexical
  checks, ergonomic-choice lexical retention, namespace-value escaping,
  ordered substitution arrays, and wildcard namespace/occurrence accounting.
- Remote fetch: cache hits now respect resource caps, rejected responses are
  drained, and redirects no longer reuse another URL's ETag.
- CLI: bundle validation rejects incompatible or lossy closures instead of
  emitting an invalid schema; validation no longer writes inside the installed
  package; malformed prefixed/unprefixed bundles and misspelled engines are
  rejected.
- XML names that collide with runtime/Zod keys (`__proto__`, `xsiType`, and
  namespace prefixes) are handled without data loss.

### Performance

- Extension-derived shapes use `.extend()` instead of repeating base
  properties; shared registry metadata is hoisted and trivial unions deduped;
  choice metadata is shared; zod's cached lazy schemas are reused on the runtime
  hot path.

### Testing

- Full W3C XSD 1.0 corpus round-trips, the invalid-instance corpus, the
  invalid-schema mode, and the widened NIST datatype pilot all run in CI
  alongside the curated fixtures, strict generated-TypeScript smoke test, and
  packed-consumer test.
- New regression suites cover parser, generator, runtime, identity, structured
  values, CLI, and remote-fetch behavior.

### Breaking changes and migration

See the [migration preview](docs/MIGRATION.md) for details. In summary:

- Programmatic `parseXsd(files)` is asynchronous.
- `zod@^4.4.3` is a required peer dependency.
- Integer output defaults to `number`; use `--integers bigint` for exact large
  values.
- Anonymous root types use friendlier names (import updates may be needed).
- Absent optional repeated elements are omitted instead of becoming `[]`.
- Identity constraints and stricter validation can reject previously accepted
  documents.
- Lexical retention defaults off (opt in with `{ retainLexicals: true }`).
- `serializeXml` validates input and applies defaults.
- Structured partial dates preserve their timezone offset.

`--ergonomic` and `--decimal string` were opt-in in 0.4. 1.0.0 made ergonomic
output the default and removed the flag; `--decimal string` stays opt-in.
