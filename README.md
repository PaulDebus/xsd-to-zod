# xsd-to-zod

[![npm version](https://img.shields.io/npm/v/xsd-to-zod.svg)](https://www.npmjs.com/package/xsd-to-zod)
[![npm downloads](https://img.shields.io/npm/dm/xsd-to-zod.svg)](https://www.npmjs.com/package/xsd-to-zod)
[![Tests](https://github.com/PaulDebus/xsd-to-zod/actions/workflows/test.yml/badge.svg)](https://github.com/PaulDebus/xsd-to-zod/actions/workflows/test.yml)
[![Node.js >= 22.12](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Turn XSD schemas into type-safe Zod parsers for XML.

**xsd-to-zod** reads your XSD files and emits strongly-typed Zod schemas that carry their XML knowledge in a typed Zod registry — **one generated artifact**. Its runtime walks those schemas to `parseXml(xml)` into plain objects and `serializeXml(data)` back out again, with validation enforced by the schemas themselves. An optional libxml2-backed conformance tier covers full XSD semantics.

```
XSD files ──► parseXsd() ──► IR ──► irToZod()
                                        │
                                        ▼
            one .zod.ts: Zod schemas + xmlRegistry entries
                                        │
                                        ▼
            parseXml / safeParseXml / serializeXml   (zod tier)
            validateXml                              (libxml2 tier, optional)
```

## Quick look: XSD → Zod → typed data

Given this `order.xsd`:

```xml
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           targetNamespace="urn:example"
           xmlns="urn:example"
           elementFormDefault="qualified">
  <xs:element name="order" type="OrderType" />
  <xs:complexType name="OrderType">
    <xs:sequence>
      <xs:element name="item" type="xs:string" maxOccurs="unbounded" />
      <xs:element name="sku"  type="xs:string" />
    </xs:sequence>
    <xs:attribute name="id" type="xs:int" use="required" />
  </xs:complexType>
</xs:schema>
```

Generate the code:

```sh
npx xsd-to-zod order.xsd -o src/generated --format
```

The generated `order.zod.ts` looks like:

```ts
import { z } from 'zod';
import { xmlRegistry } from 'xsd-to-zod';

export interface OrderType {
  item: string[];
  sku: string;
  "@id": number;
}
export const OrderTypeSchema: z.ZodType<OrderType> = z.lazy(() => z.object({
  "item": z.array(z.string()),
  "sku": z.string(),
  "@id": z.number().int(),
})).register(xmlRegistry, {
  qname: "{urn:example}OrderType",
  fields: {
    item: { kind: "element", qname: "{urn:example}item" },
    sku:  { kind: "element", qname: "{urn:example}sku" },
    "@id": { kind: "attribute", qname: "id" },
  },
});
export const orderSchema = z.lazy(() => OrderTypeSchema)
  .register(xmlRegistry, { root: "{urn:example}order" });
```

Every complex type becomes an exported interface plus an exported schema.
Non-recursive schemas retain inferred input types; recursive schemas use an
explicit `z.ZodType<Interface>` annotation to break circular inference. Parsed
output remains typed, including for mutually recursive XSD types. Named types from
the schema (simple and complex, e.g. `GuidTypeSchema`) are exported too, so you
can validate fragments or reuse them in your own schemas without going through
the root element. Root-element exports and type exports never share a name;
a collision is resolved with a numeric suffix on the type const.

Use it in TypeScript:

```ts
import { parseXml, serializeXml } from 'xsd-to-zod';
import { orderSchema } from './generated/order.zod.js';

const data = parseXml(orderSchema, `
  <order xmlns="urn:example" id="42">
    <item>widget</item>
    <sku>W-001</sku>
  </order>
`);
// data is fully typed: { item: string[], sku: string, '@id': number }

const xml = serializeXml(orderSchema, data);
```

`parseXml` validates by construction: schema failures throw a `ZodError`;
structural/XML lexical failures can throw a plain `Error`. Use
`safeParseXml(orderSchema, xml)` for a `{ success, data | error }` result object
instead, and narrow its `unknown` error before reading Zod issues.

## Features

- **XSD constructs**: `sequence`, `choice` (→ runtime-enforced from registry metadata), `all`, `attribute`, `simpleContent`, `complexContent` (extension flattening), `xs:group`, `xs:attributeGroup`, `xs:redefine`, substitution groups (a head element's field becomes a union over its member elements), mixed content (`mixed="true"` → optional `_text` field next to the child elements)
- **Simple type restrictions**: facets become Zod checks where Zod can express them — `enumeration` (→ `z.enum` / literal unions), `pattern` (→ `.regex`), length/min/max (→ `.length`/`.min`/`.max`), order facets on `xs:decimal` (→ exact lexical comparison via `xsdDecimalCompare` — boundary digits beyond double precision are not rounded), on the ordered date/time/duration and string-derived builtins (→ value-space comparison via `xsdOrderCompare`; timezone-less vs timezoned and indeterminate duration pairs reject), `totalDigits`/`fractionDigits` (→ digit-count refinements), `whiteSpace` collapse/replace (→ preprocess transform). `xs:list` (→ whitespace-splitting `z.preprocess` + `z.array`) and `xs:union` (→ `z.union`) are supported
- **Namespaces**: Clark notation `{ns}local` throughout, qualified/unqualified form defaults, `xs:include`/`xs:import` across files
- **Chameleon includes**: inherited target namespace for includee schemas without a `targetNamespace`
- **CLI**: directory input (recursive `.xsd` discovery), `--include-libraries` (auto-skip type-definition-only schemas), `--allow-missing-imports` (suppress unresolved ref warnings), `--silent`, and `bundle` subcommand for merging imports into one self-contained XSD
- **Remote schemas**: http(s) URLs accepted directly as CLI input (host allowlists, https-only by default, resource caps, proxy support), `xsd-to-zod.lock.json` integrity pinning with a content cache (`--frozen`, `--offline`), and a `download` subcommand that vendors a remote schema closure to self-contained local files
- **Encoding detection**: BOM and declaration sniffing (UTF-16LE/BE, CP1252, UTF-8) via `iconv-lite`
- **Cardinality**: `minOccurs`/`maxOccurs` → `.optional()` / `z.array()` with `.min()`/`.max()` bounds; defaults/fixed with XSD-correct semantics (attribute defaults on absence, element defaults on present-but-empty)
- **Nillable**: `xsi:nil="true"` → `.nullable()` in schema, round-trips through `serializeXml`
- **Derived-type polymorphism**: a slot whose declared complex type is abstract or has derived types (extension/restriction) in the schema set becomes a discriminated union over the base and derived variants, keyed on a synthetic `xsiType` property — `parseXml` dispatches on the instance's `xsi:type` attribute (derived fields are kept, TS narrows on the discriminant) and `serializeXml` re-emits it. An `xsi:type` naming a type outside the generated set parses as the declared type, with the extra content captured for lossless re-serialization (untyped)
- **Cyclic references**: every emitted complex-type schema is wrapped in `z.lazy(() => ...)` so forward references and true cycles (e.g. `Person.manager: Person`) load without `ReferenceError`
- **Two validation tiers**: the zod tier (typed parse, user-friendly `ZodError`s) and an optional libxml2 conformance tier (full XSD semantics, line-numbered errors)
- **Builtin datatype lexicals**: the zod tier validates the XSD 1.0 lexical space of the date/time set, `duration`, `hexBinary`/`base64Binary`, `language`, and the `Name`/`NCName`/`NMTOKEN` family (values stay the original strings — no canonicalization). Integers map to `z.number().int()` with value-space bounds (exact and JSON-serializable below 2⁵³; zod's int check rejects larger values instead of rounding them). The arbitrary-precision `xs:integer` family and the 64-bit `long`/`unsignedLong` can opt into `z.bigint()` with `--integers bigint` — exact at any magnitude, and the only mode that enforces the 64-bit `long`/`unsignedLong` outer bounds — at the cost of `JSON.stringify` throwing on the parsed data. `xs:decimal` maps to `z.number()` (float64, lossy beyond ~16 significant digits); `--decimal string` keeps the exact canonical decimal lexical instead

## Install

```sh
npm install xsd-to-zod zod
```

`zod` v4 is a **peer dependency**: generated modules import it directly and the runtime parses against that same copy, so install it alongside `xsd-to-zod` (`zod@^4.4.3`). For the optional conformance tier (`xsd-to-zod/validate`), also install:

```sh
npm install libxml2-wasm
```

## Usage

0.4.0 is the last planned 0.x release before the 1.0 ergonomic-output/API
change. It also includes changes from 0.3.1 that require migration; see the
[0.4 → 1.0 migration preview](docs/MIGRATION.md) before regenerating existing
schemas. See the [CHANGELOG](CHANGELOG.md) for the full release notes.

### CLI

```sh
npx xsd-to-zod schema.xsd -o src/generated --format
# → src/generated/schema.zod.ts

npx xsd-to-zod schemas/ -o src/generated --format
# → src/generated/schemas.zod.ts (all .xsd files in the directory)

npx xsd-to-zod types.xsd elements.xsd -o src/generated -n my-api
# → src/generated/my-api.zod.ts

npx xsd-to-zod https://example.com/schema.xsd -o src/generated
# → fetches the schema and its remote imports, then writes schema.zod.ts
```

| Flag | Description |
|------|-------------|
| `-o, --out <dir>` | Output directory (default: current directory) |
| `-n, --name <name>` | Basename for the generated file (required with multiple inputs) |
| `-f, --format` | Run `biome` / `prettier` / `eslint --fix` on the generated file (project config is used when present; biome/prettier otherwise run with defaults). Best-effort: warns when no formatter can process the file or when the formatter exits non-zero |
| `--include-libraries` | Include type-definition-only schemas (those without root elements); skipped by default |
| `--allow-missing-imports` | Suppress warnings for unresolved XSD references; unresolved element refs map to `z.unknown()` in the output instead of being dropped |
| `--silent` | Suppress informational output (warnings are still shown) |
| `--datatypes <mode>` | `string` (default) keeps the XSD date/time builtins as validated strings; `structured` parses them into plain objects (`XsdDateTime` & co.). Date/time instants normalize to UTC; partial dates retain their local fields and actual timezone offset to preserve the XSD value |
| `--integers <mode>` | `number` (default) maps the `xs:integer` family to `z.number().int()` — JSON-safe, exact below 2⁵³ (larger values are rejected, and the 64-bit `long`/`unsignedLong` outer bounds cannot be expressed and are dropped); `bigint` maps them to `z.bigint()`, exact at any magnitude, but `JSON.stringify` throws on parsed data containing them |
| `--decimal <mode>` | `number` (default) maps `xs:decimal` to `z.number()` (float64) — exact only to ~16 significant digits; `string` keeps the exact canonical decimal lexical (leading/trailing zeros normalized, never rounded), so arbitrary-precision financial amounts round-trip losslessly. Facets (`totalDigits`, `fractionDigits`, order bounds, enums) are checked against the exact lexical in both modes |
| `--ergonomic` | Preview the 1.0 output shape: collapse lone-attribute value wrappers (`{ "@value": T }`) to scalars, emit attribute keys without the `@` prefix (`"@id"` → `"id"`; a colliding attribute keeps `@`), and emit repeated `xs:choice` as one array of tagged items (`_choice: ({ a: A } \| { b: B })[]`). Temporary scaffolding flag — not final public API |
| `--fetch` | Resolve remote imports/includes from local schema inputs. Remote entry URLs always fetch; local inputs never use the network without this flag |
| `--no-fetch` | Fetch only a remote entry schema and skip its remote imports/includes |
| `--frozen` | Verify every cached or fetched remote schema against `xsd-to-zod.lock.json`; fail on missing entries or drift and never update the lockfile |
| `--offline` | Resolve remote schemas from the local cache only; fail on a cache miss |
| `--revalidate` | Revalidate cached remote schemas against the server with conditional ETag/`If-None-Match` requests; a 304 serves the integrity-checked cache instead of re-downloading |
| `--allow-http` | Permit insecure `http://` schema URLs (`https://` only by default) |
| `--allow-host <host>` | Repeatable host allowlist for every fetched schema, including the entry URL |

Remote fetches are logged to stderr, use `HTTPS_PROXY`/`HTTP_PROXY` when set, and are capped at 100 files, 10 MB per file, 50 MB total, 32 import levels, and 30 seconds per request. In mixed runs local inputs still stay offline unless `--fetch` is passed.

Successful fetches write `xsd-to-zod.lock.json` in the current directory and populate the user cache; commit the lockfile for reviewable, reproducible remote schemas. Use `--frozen` in CI and `--offline` when network access is unavailable. Entries record the requested URL, final post-redirect URL, SHA-256 digest, fetch timestamp, and optional ETag:

```json
{
  "version": 1,
  "schemas": {
    "https://example.com/schema.xsd": {
      "sha256": "9f2c…",
      "finalUrl": "https://example.com/schema.xsd",
      "fetchedAt": "2026-09-08T12:34:56.000Z",
      "etag": "W/\"abc\""
    }
  }
}
```

The recorded `etag` enables conditional revalidation with `--revalidate`:
cached entries are checked against the server and reused unchanged on a 304.
Revalidation relies on ETags only (`Last-Modified` is not used); entries
without a recorded ETag are fetched in full.

Vendor a remote schema closure to self-contained local files for the
commit-to-repo flow:

```sh
xsd-to-zod download https://example.com/schema.xsd -o vendor/schemas
# → fetches the schema and its remote imports into vendor/schemas,
#   rewriting schemaLocations to relative paths

xsd-to-zod vendor/schemas/example.com/schema.xsd -o src/generated
# → works with zero flags; no network access needed

xsd-to-zod download ./local.xsd -o vendor/schemas   # local entry, remote imports
```

`download` lays remote schemas out by host and URL path (a local entry keeps
its relative structure), accepts `--allow-http`, `--allow-host`, and `--offline`
(vendoring from the local cache), and updates the lockfile on every run.
Re-running always fetches fresh bytes, so upstream changes surface as
reviewable diffs in the vendored files and the lockfile. With `--revalidate`,
repeat runs send `If-None-Match` for entries with a recorded ETag, and a 304
reuses the cache instead of re-downloading full bodies. Locations that
cannot be resolved are left as-is and reported; the output then states the
closure is partial.

Location rewriting is textual, not a full XML re-serialization, so vendored
files keep their original formatting. The trade-off: if a comment or
documentation block quotes an import example with the exact same
`schemaLocation` string as an import that gets relocated, that prose
occurrence is rewritten along with it.

Bundle a compatible same-namespace schema set into a single self-contained XSD:

```sh
xsd-to-zod bundle main.xsd                         # → main.bundled.xsd
xsd-to-zod bundle main.xsd -o dist/schema.xsd      # → dist/schema.xsd
xsd-to-zod bundle main.xsd --format                # formatted output
```

`bundle` fails before writing when namespace contexts, schema defaults,
redefinitions, foreign-namespace imports, or unresolved dependencies cannot be
flattened safely. Use `download` to vendor those closures while preserving their
separate schema documents.

Validate an XML document:

```sh
xsd-to-zod validate data.xml --xsd schema.xsd                    # zod tier (typed parse)
xsd-to-zod validate data.xml --xsd schema.xsd -e libxml2         # conformance tier
```

### Programmatic API

```ts
import { parseXsd, irToZod, runPostGenerationFormatting } from 'xsd-to-zod';
import { writeFileSync } from 'node:fs';

const ir = await parseXsd(['schema.xsd']);
const { schemas } = irToZod(ir);

writeFileSync('schema.zod.ts', schemas);
runPostGenerationFormatting(['schema.zod.ts']);
```

`parseXsd` is asynchronous and never fetches from the network itself. Library
consumers can supply `resolveSchema(location, base)` to materialize an http(s)
entry schema or remote import — `createFetchSchemaResolver` from `'xsd-to-zod'`
provides the same fetching, caps, and host policy the CLI uses; returning
`undefined` preserves the default "remote schemaLocation skipped" diagnostic.

The vendoring flow is available too, with the same lockfile/cache store the CLI
uses:

```ts
import { downloadSchemaClosure, RemoteSchemaStore } from 'xsd-to-zod';

const store = await RemoteSchemaStore.open({ cwd: process.cwd() });
const result = await downloadSchemaClosure('https://example.com/schema.xsd', {
  outDir: 'vendor/schemas',
  store,
});
// result.entry / result.files — vendored paths relative to outDir
// result.unresolved — schemaLocations left as-is (partial closure when non-empty)
```

### Parse and serialize XML

```ts
import { parseXml, safeParseXml, serializeXml } from 'xsd-to-zod';
import { orderSchema } from './generated/order.zod.js';

const order = parseXml(orderSchema, xmlString);          // throws ZodError
const result = safeParseXml(orderSchema, xmlString);     // { success, data | error }
const xml = serializeXml(orderSchema, order);
```

`serializeXml` takes the schema's *input* type: it validates through the schema before walking, so XSD attribute defaults apply and invalid data fails early with a `ZodError`. Generated modules export an input alias per complex type (`OrderTypeIn = z.input<typeof OrderTypeSchema>`) next to the output interface, so hand-building data typechecks with defaulted fields left out. (Recursive types keep an explicit const annotation to break circular inference; no `*In` alias is emitted for them — `z.input` of an annotated schema degrades to `unknown`.)

Primitive QName root strings cannot distinguish identical spellings parsed under
different namespace bindings. The runtime retains a bounded per-value context;
if that context is ambiguous or unavailable, supply it explicitly:
`serializeXml(schema, value, { rootNamespaces: { p: "urn:codes" } })`.
Use the empty key (`""`) for the QName value's default namespace. Ambiguous
values fail serialization instead of silently using another document's bindings.

`safeParseXml(schema, xml, { validate: false })` skips the final schema validation — a fast path for input already checked by the conformance tier.

Lexical retention is **opt-in**. By default `serializeXml` derives each lexical from the parsed value in its shortest round-trip form, so `1.0` serializes as `1` and `001` as `1` (and numeric values never use exponent notation, which `xs:decimal` forbids). Fields whose type carries lexical-space facets (`pattern`, `enumeration`, `whiteSpace`, order/fraction digits) keep their parse-time lexical regardless, so serialized output still satisfies the schema. Pass `{ retainLexicals: true }` to `parseXml`/`safeParseXml` to keep scalar lexical spellings for unchanged values. This does not preserve XML bytes, formatting, comments, namespace spelling, CDATA boundaries, or mixed-content interleaving. Retention never changes the parsed data (it only feeds serialization), and QName prefix bindings are tracked independently.

Identity constraints (`xs:key`, `xs:keyref`, `xs:unique`) are enforced by default: violations fail parsing with a `ZodError` naming the constraint, value, and data path. To parse documents whose referential integrity is knowingly broken (partial exports, data being repaired) while keeping all other validation, use `parseXml(schema, xml, { identityConstraints: false })`.

### Conformance tier (`xsd-to-zod/validate`)

```ts
import { validateXml } from 'xsd-to-zod/validate';

const result = await validateXml(xmlString, xsdString, { url: 'schemas/order.xsd' });
if (!result.valid) {
  console.error(result.issues);  // line-numbered XSD errors
}
```

`validateSchema(xsdString, { url })` checks a schema document itself (returns `{ valid: false, issues }` instead of throwing on compile errors), useful for validating schemas before code generation.

Thin wrapper over [libxml2-wasm](https://www.npmjs.com/package/libxml2-wasm) (the reference libxml2 engine on WebAssembly), loaded via dynamic import — it is an **optional peer dependency**, so browser deployments and zod-tier-only consumers never pay for it. The `url` option lets relative `xs:include`/`xs:import` resolve (from the filesystem in Node).

**Typical upload gate:** `validateXml` first (contract check with line-numbered errors), then `parseXml` (typed data + user-friendly zod issues).

### Working with generated schemas

Every emitted complex-type schema is wrapped in `z.lazy(() => ...)` so cyclic type references and forward references load without errors. `z.infer<typeof FooSchema>` resolves through the lazy wrapper transparently.

Every named type's schema is exported, so a fragment can be validated directly
(`DataTemplateTypeSchema.parse(fragment)`) or embedded in a hand-written schema.
Element-root schemas keep the element's name, while inline element-owned types
carry the `…TypeSchema` infix.

If you need to call `.extend()`, `.pick()`, `.omit()` or any object-only method on a generated schema, unwrap it first via the Zod v4 lazy getter:

```ts
import { orderSchema } from './generated/order.zod.js';

const inner = orderSchema.def.getter().def.getter();   // root lazy → type lazy → ZodObject
const extended = inner.extend({ extra: z.string() });
```

The `xmlRegistry` metadata is inspectable too — e.g. `xmlRegistry.get(orderSchema)?.root` returns the root element QName. Generated schemas register it automatically; the XML runtime requires it. Object composition methods create new schemas: when composing by hand, register the resulting schema with the appropriate root and field metadata before using the XML runtime. A new field needs its own XML mapping; extending a Zod object alone does not define an XML element or attribute.

**Type naming.** A global element with an inline anonymous type lends the type its bare name: `<xs:element name="Library">` with an inline complex type generates `export interface Library`, so `parseXml(LibrarySchema, xml)` is typed `Library`. Nested anonymous types follow the `Parent_Child_Type` scheme. If the friendly name collides with another declaration, the type keeps its synthetic `anonymous_…` name instead — the CLI prints a `naming-collision` warning and the generated file carries a comment at the affected type.

## Why trust this?

We ship a **multi-tier test suite** that exercises the full pipeline on real-world and curated fixtures. Every round-trip test validates: XSD → Zod schemas → parse XML (golden-file compare) → serialize back → re-parse → deep-compare → serialized XML validated against the original XSD using libxml2. A smoke test additionally runs `tsc --noEmit` over the generated output of every curated fixture, so invalid-TypeScript codegen bugs cannot slip through.

Run it locally (`npm run test:quick` runs the dev-loop subset without the heavy upstream round-trips):

```sh
npm test
```

The release gate is `npm run test:release` — lint, the full suite with coverage thresholds, and the full W3C corpus. `test:quick` is for the dev loop only.

**Test matrix** (the full suite includes the complete NIST datatype selection;
the corpus gate adds 13,899 valid-instance, 10,942 invalid-instance, and 3,329
invalid-schema cases). Expected failures are documented pins, not unexplained
failures; two upstream fixtures remain skipped because their original XML is invalid.

| Category | Count | What it covers |
|----------|------:|----------------|
| Curated round-trip | 37 | Declarations, content models, cardinality, types, entities/CDATA, namespaces, imports, cyclic refs, defaults — serialized XML validated against libxml2 |
| Upstream round-trip | 16 (14 ✅, 2 ⏭️) | [`xmlschema`](https://github.com/brunato/xmlschema) examples + OASIS UBL Invoice/Order |
| W3C Boeing | 12 (12 ✅) | ipo1–ipo6 discovered from the `.testSet` metadata of the [w3c/xsdtests](https://github.com/w3c/xsdtests) submodule |
| W3C sun/ms/nist selection | 13,035 (13,002 ✅, 33 ⚠️) | Valid-instance cases from 22 test sets including every NIST datatype family; known failures pinned as `it.fails` with categorized reasons |
| W3C negative (invalid instances) | 10,026 (10,020 ✅, 6 ⚠️) | zod tier must reject; lenient acceptances confirmed invalid by libxml2 and recorded in the negative conformance report |
| W3C full corpus (main + weekly) | 13,899 (13,879 ✅, 20 ⚠️) | All XSD 1.0 test sets via `suite.xml`; known failures pinned as `it.fails` with categorized reasons in `tests/w3cCorpusKnownFailures.ts` |
| W3C full-corpus negative (main + weekly) | 10,942 (10,916 ✅, 26 ⚠️) | Invalid instances across all XSD 1.0 test sets; the zod tier rejects or libxml2 confirms the leniency, recorded in the merged negative conformance report; anomalies pinned in `tests/w3cCorpusNegativeKnownAnomalies.ts` |
| W3C invalid schemas (main + weekly) | 3,329 (392 ⚠️) | Maps generator leniency on invalid schemas; libxml2 is the conformance authority, with known oracle anomalies pinned |
| Pipeline / CLI / runtime | 680+ | Codegen unit tests, runtime coercion, CLI e2e, conformance tier, facet checks |
| Negative | 7 | The zod tier's leniency boundary, pinned (missing required → `ZodError`, foreign root → structural error) |
| Codegen typecheck | 1 | `tsc --noEmit` over all curated fixtures' generated output |

**What the ⚠️ pins mean.** The W3C suites are triaged to closure — the goal is zero unexplained failures, not a perfect raw count (the corpus contains cases that are unpassable by design). Every failing case carries a pin with a categorized reason: either libxml2 itself rejects the *original* instance/schema, or the case exercises a documented out-of-scope feature (e.g. type-library schemas with no global element to generate a root parser from). Pins run as `it.fails`, and their stated reasons are re-verified by the suite (`tests/w3cPinVerification.test.ts`) — a pin that stops being true, e.g. because a libxml2 upgrade closes a gap, breaks the build. See [docs/TEST_STATUS.md](docs/TEST_STATUS.md#definition-of-done) for the full definition of done.

**Test data sources**

- `testdata/curated/` — hand-authored XSD/XML pairs + negative variants (CC0-1.0)
- `testdata/upstream/xmlschema/` — vehicles, collection, stockquote, menù examples from [brunato/xmlschema](https://github.com/brunato/xmlschema) (MIT)
- `testdata/upstream/oasis-ubl-2.4/` — UBL Invoice + Order subset (OASIS RF on Limited Terms)
- `testdata/upstream/w3c-xsdtests/` — git submodule of [w3c/xsdtests](https://github.com/w3c/xsdtests), pinned commit (W3C Document License)

Full license attributions in [`testdata/THIRD_PARTY_NOTICES.md`](testdata/THIRD_PARTY_NOTICES.md). Current suite status and coverage notes live in [`docs/TEST_STATUS.md`](docs/TEST_STATUS.md).

## Limitations

Zod-tier specifics worth knowing:

- **`xs:integer` values are JS numbers by default** (breaking change for JSON interop): `JSON.stringify(parseXml(...))` just works, and values are exact below 2⁵³ — larger lexicals are *rejected* by zod's safe-integer check, not silently rounded, and the 64-bit `long`/`unsignedLong` outer bounds (beyond 2⁵³) are dropped. If your data carries integers that big, generate with `--integers bigint`: every magnitude round-trips exactly, but the parsed objects are no longer JSON-serializable
- **`xs:decimal` values are float64 by default**: decimals beyond ~16 significant digits (common in financial XML such as ISO 20022 amounts) lose precision. Generate with `--decimal string` for an exact canonical lexical string (e.g. `"123456789012345678.9"`); the exact mode normalizes representation (leading `+`, leading integer zeros, and trailing fraction zeros) but never rounds a significant digit
- Identity constraints (`xs:key`, `xs:keyref`, `xs:unique`) are enforced over the parsed tree at the end of `parseXml`/`safeParseXml`, scoped per occurrence of the declaring element. The selector/field xpaths must stay within XSD's restricted subset (no predicates, axes, or `..`) — anything else is dropped with a generation-time warning and a header comment in the generated file; unprefixed xpath steps are in *no* namespace (the XPath 1.0 rule), and constraints on substitution-group *members* (as opposed to the head) are not enforced
- Mixed content: an element's character data segments are concatenated into `_text` — their interleaving with child elements is not preserved on round-trip (also flagged by the generation-time warning)
- `xs:ID`/`xs:IDREF`/`xs:IDREFS`: the lexical shape (NCName) is validated, but the referential semantics are not — ID document-uniqueness and IDREF resolution are not checked (flagged by the generation-time warning; the conformance tier covers them). Prefer `xs:key`/`xs:keyref`, which are enforced
- `xs:any` / `xs:anyAttribute` wildcards are captured in an open shape and round-tripped; namespace constraints (`##other`, `##targetNamespace`, …) are enforced, but wildcard content itself is not validated (lax tier)
- Element order and unexpected elements are not enforced (conformance tier covers them)
- Facets Zod cannot express are not promised (conformance tier covers them)

### Known gaps (tracked as GitHub issues)

- [#10](https://github.com/PaulDebus/xsd-to-zod/issues/10) — element order / unexpected-element enforcement in generated schemas (cardinality bounds are enforced; the rest belongs to the conformance tier)

## Contributing

Issues and PRs are welcome on [GitHub](https://github.com/PaulDebus/xsd-to-zod). Please branch from `main` and make sure `npm test` passes before submitting.

## License

[MIT](LICENSE) © Paul Debus

Code generated by xsd-to-zod belongs to you: generated files carry no licensing obligations from this project.
