# Migrating to 1.0

1.0 is a deliberate clean break. There is no `--compat` mode: the 0.4
`--ergonomic` preview is now the only output shape, and the public API is
trimmed.

**Support contract:** regenerate generated modules with the version of
`xsd-to-zod` you run at runtime. Generated files are not supported across
runtime versions. If you cannot migrate yet, pin both generator and runtime to
`@0.x` — that reproduces the old output and old runtime behavior.

## Coming from 0.4

The 1.0 output shape is now the default and only shape:

- **Value wrappers collapse.** A complex type with no element content and a
  single required simple attribute becomes a scalar field rather than
  `{ "@value": T }`.
- **Attribute keys lose `@`.** `"@id"` is emitted as `"id"`. If the bare key
  would shadow a sibling element, the element keeps the bare name and the
  attribute keeps `@`; generation warns and comments in the generated file.
- **Repeated choices are ordered arrays.** An eligible `xs:choice` with
  `maxOccurs > 1` becomes `choice: ({ a: A } | { b: B })[]` instead of
  parallel optional arrays. Document order is part of the data, so edits and
  hand-built values serialize in array order.
- **Root anonymous type names are friendly.** A top-level element with an
  inline type exports the bare element name (`anonymous_Library_Type` →
  `Library`); nested anonymous types keep `Parent_Child_Type`. A collision
  keeps the synthetic name with a warning and a generated comment.

The `--ergonomic` flag and the `{ ergonomic: true }` compiler option are gone.
Remove them; there is nothing to replace them with.

## Package entry points

- `xsd-to-zod` is the runtime surface only: `parseXml`, `safeParseXml`,
  `serializeXml`, `xmlRegistry`, and the helpers generated modules import.
- Build-time APIs moved to `xsd-to-zod/compiler`: `parseXsd`, `irToZod`,
  `IrToZodOptions`, `ParseXsdOptions`, the IR types,
  `runPostGenerationFormatting`, `readXmlFile`, `Xsd2ZodError`, and the remote
  fetch/download helpers. Programmatic consumers change one import path.
- Internals with no external consumers are no longer exported from the package
  root. The per-datatype `parseXsd…` / `writeXsd…` helpers remain because
  generated modules import them.

## CLI

- A real `generate` subcommand now exists alongside the default positional
  command; `xsd-to-zod generate schema.xsd` works.
- `--ergonomic` is removed.

## Changes already in 0.4

If you are coming from 0.3.1, the 0.4 line also requires regeneration and
review:

- **Programmatic compilation is asynchronous.** Await `parseXsd(files)`.
- **Install Zod explicitly.** `zod@^4.4.3` is a required peer dependency so
  generated modules and the runtime use the consumer's copy. `libxml2-wasm`
  remains optional, needed only for `xsd-to-zod/validate`.
- **Integer output defaults to `number`.** The arbitrary-precision integer
  family and `long`/`unsignedLong` used `bigint` in 0.3.1. Use
  `--integers bigint` / `{ integers: "bigint" }` to retain exact large values.
  Number mode rejects unsafe integers; it does not accept all XSD integer values.
- **Absent optional repeated elements are omitted**, rather than synthesized
  as empty arrays. Handle `undefined` or explicitly normalize in application code.
- **Identity constraints are enforced by default.** Previously accepted XML
  with duplicate keys or dangling references can now fail. For partial exports
  intentionally lacking integrity, use `{ identityConstraints: false }`.
- **Lexical retention defaults off.** Use `{ retainLexicals: true }` when
  original lexical spelling matters. This retains scalar spellings, not XML
  byte identity: comments, processing instructions, namespace spelling, CDATA
  boundaries, and mixed-content interleaving are not preserved.
- **Serialization validates input and applies defaults.** Invalid hand-built
  data can now fail before XML is emitted. Use generated input aliases where
  available, or `z.input<typeof schema>`.
- **Structured partial dates preserve their offset.** In the optional
  `--datatypes structured` mode, `xs:date` and the `g*` types retain local
  calendar fields and the actual `tzOffset`. `dateTime` and `time` still
  normalize to UTC. Structured years outside JavaScript's safe-integer range
  reject instead of rounding; use string mode for such years.
- **Validation fixes reject more invalid documents.** Duplicate scalar elements,
  blocked type substitutions, partial optional groups, and additional datatype
  facets are checked. The zod tier still is not a full XSD validator.

Mixed-content `_text` concatenation remains a deliberate 1.x limitation:
character-data segments are concatenated, and their interleaving with child
elements is not preserved.
