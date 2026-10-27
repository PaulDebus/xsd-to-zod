# Changelog

All notable changes to `xsd-to-zod` are documented here. This project follows
[Semantic Versioning](https://semver.org/); the 0.x line makes no API-stability
promise, and generated files must be regenerated with the version you run.

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

`--ergonomic` and `--decimal string` remain opt-in. The 1.0 release will make
ergonomic output the default and remove the temporary flag.
