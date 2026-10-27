# Migration preview: 0.3.1 → 0.4 → 1.0

0.4.0 is the last planned 0.x base. It keeps `--ergonomic` opt-in, but is **not
a wholly non-breaking upgrade from 0.3.1**. Regenerate with the version of
`xsd-to-zod` used at runtime, review the generated diff, and run application
tests. To stay on the published behavior, pin both generator and runtime to
`0.3.1`; after migrating to the 0.4 line, pin `~0.4.0` to defer the 1.0 flip.

## Changes already on main for 0.4

- **Programmatic compilation is asynchronous.** Await `parseXsd(files)`.
- **Install Zod explicitly.** `zod@^4.4.3` is a required peer dependency so
  generated modules and the runtime use the consumer's copy. `libxml2-wasm`
  remains optional, needed only for `xsd-to-zod/validate`.
- **Integer output defaults to `number`.** The arbitrary-precision integer
  family and `long`/`unsignedLong` used `bigint` in 0.3.1. Use
  `--integers bigint` / `{ integers: "bigint" }` to retain exact large values.
  Number mode rejects unsafe integers; it does not accept all XSD integer values.
- **Anonymous root type names are friendlier.** Regeneration can rename type
  interfaces; update imports to match the generated exports. Root schemas keep
  the element name; named type exports can acquire numeric collision suffixes.
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
  calendar fields and the actual `tzOffset`. Truncating a UTC conversion changed
  their XSD value. `dateTime` and `time` still normalize to UTC. Structured years
  outside JavaScript's safe-integer range reject instead of rounding; use string
  mode for such years.
- **Validation fixes reject more invalid documents.** Duplicate scalar elements,
  blocked type substitutions, partial optional groups, and additional datatype
  facets are checked. The zod tier still is not a full XSD validator.

Exact decimals are opt-in (`--decimal string`); float64 remains the default.
The ergonomic preview is opt-in (`--ergonomic`) and temporary. Test it on your
own schemas to assess the 1.0 migration, without assuming all 1.0 API decisions
are finalized.

## Planned 1.0 boundary

1. Settle the public API contract before removing exports. Helpers imported by
   generated files are runtime API, even if not individually documented in the
   README, including the branch-agreed default helper `coerceXmlValue`.
   Inventory generated imports across all modes first. Decide whether
   compiler APIs stay at `.` or move to a documented compiler subpath.
2. Make ergonomic output the default: attribute keys without `@` (collision
   fallback keeps it), scalar value wrappers, and ordered tagged arrays for
   supported repeated choices. Delete the temporary flag at that boundary.
   Bare anonymous root names have already landed; do not schedule them as a
   second future naming migration.
3. Apply the API trim and CLI grammar cleanup, regenerate fixtures, and run the
   complete release gate in the final default shape. Keep representative
   generated-import compatibility checks for every datatype mode.
4. Publish migration examples and the changelog, then verify the exact versioned
   release commit and packed package before publishing.

Mixed-content `_text` concatenation remains a deliberate 1.x limitation.
Configurable naming, builder helpers, decimal arithmetic dependencies, and XSD
1.1 are independent features, not prerequisites for the output-default flip.
