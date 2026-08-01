# xsd-to-zod

[![npm version](https://img.shields.io/npm/v/xsd-to-zod.svg)](https://www.npmjs.com/package/xsd-to-zod)
[![npm downloads](https://img.shields.io/npm/dm/xsd-to-zod.svg)](https://www.npmjs.com/package/xsd-to-zod)
[![Tests](https://github.com/PaulDebus/xsd-to-zod/actions/workflows/test.yml/badge.svg)](https://github.com/PaulDebus/xsd-to-zod/actions/workflows/test.yml)
[![Node.js >= 22.12](https://img.shields.io/badge/node-%3E%3D22.12-brightgreen.svg)](https://nodejs.org)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

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
const OrderTypeSchema: z.ZodType<OrderType> = z.lazy(() => z.object({
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

Every complex type becomes an exported interface plus a schema const annotated
`z.ZodType<Interface>`, so `z.infer<typeof orderSchema>` is `OrderType` — full
compile-time types, including for mutually recursive XSD types.

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

`parseXml` throws a `ZodError` on validation failure — validation is enforced by construction, not by remembering to call `.parse()`. Use `safeParseXml(orderSchema, xml)` for a `{ success, data | error }` result object instead.

## Features

- **XSD constructs**: `sequence`, `choice` (→ per-group refine checks), `all`, `attribute`, `simpleContent`, `complexContent` (extension flattening), `xs:group`, `xs:attributeGroup`, `xs:redefine`, mixed content (`mixed="true"` → optional `_text` field next to the child elements)
- **Simple type restrictions**: facets become Zod checks where Zod can express them — `enumeration` (→ `z.enum` / literal unions), `pattern` (→ `.regex`), length/min/max (→ `.length`/`.min`/`.max`), order facets on `xs:decimal` (→ exact lexical comparison via `xsdDecimalCompare` — boundary digits beyond double precision are not rounded), `totalDigits`/`fractionDigits` (→ digit-count refinements), `whiteSpace` collapse/replace (→ preprocess transform). `xs:list` (→ whitespace-splitting `z.preprocess` + `z.array`) and `xs:union` (→ `z.union`) are supported
- **Namespaces**: Clark notation `{ns}local` throughout, qualified/unqualified form defaults, `xs:include`/`xs:import` across files
- **Chameleon includes**: inherited target namespace for includee schemas without a `targetNamespace`
- **CLI**: directory input (recursive `.xsd` discovery), `--include-libraries` (auto-skip type-definition-only schemas), `--allow-missing-imports` (suppress unresolved ref warnings), `--silent`, and `bundle` subcommand for merging imports into one self-contained XSD
- **Encoding detection**: BOM and declaration sniffing (UTF-16LE/BE, CP1252, UTF-8) via `iconv-lite`
- **Cardinality**: `minOccurs`/`maxOccurs` → `.optional()` / `z.array()` with `.min()`/`.max()` bounds; defaults/fixed with XSD-correct semantics (attribute defaults on absence, element defaults on present-but-empty)
- **Nillable**: `xsi:nil="true"` → `.nullable()` in schema, round-trips through `serializeXml`
- **Cyclic references**: every emitted complex-type schema is wrapped in `z.lazy(() => ...)` so forward references and true cycles (e.g. `Person.manager: Person`) load without `ReferenceError`
- **Two validation tiers**: the zod tier (typed parse, user-friendly `ZodError`s) and an optional libxml2 conformance tier (full XSD semantics, line-numbered errors)
- **Builtin datatype lexicals**: the zod tier validates the XSD 1.0 lexical space of the date/time set, `duration`, `hexBinary`/`base64Binary`, `language`, and the `Name`/`NCName`/`NMTOKEN` family (values stay the original strings — no canonicalization). Bounded integers that fit a JS number (`byte`, `short`, `int`, the unsigned variants ≤ 32 bit) map to `z.number().int()` with value-space bounds; the arbitrary-precision `xs:integer` family and the 64-bit `long`/`unsignedLong` map to `z.bigint()` so no valid lexical is lost to double rounding

## Install

```sh
npm install xsd-to-zod
```

`zod` v4 ships as a regular dependency. For the optional conformance tier (`xsd-to-zod/validate`), also install:

```sh
npm install libxml2-wasm
```

## Usage

### CLI

```sh
npx xsd-to-zod schema.xsd -o src/generated --format
# → src/generated/schema.zod.ts

npx xsd-to-zod schemas/ -o src/generated --format
# → src/generated/schemas.zod.ts (all .xsd files in the directory)

npx xsd-to-zod types.xsd elements.xsd -o src/generated -n my-api
# → src/generated/my-api.zod.ts
```

| Flag | Description |
|------|-------------|
| `-o, --out <dir>` | Output directory (default: current directory) |
| `-n, --name <name>` | Basename for the generated file (required with multiple inputs) |
| `-f, --format` | Run `biome` / `prettier` / `eslint --fix` on the generated file (project config is used when present; biome/prettier otherwise run with defaults). Warns when no formatter can process the file |
| `--include-libraries` | Include type-definition-only schemas (those without root elements); skipped by default |
| `--allow-missing-imports` | Suppress warnings for unresolved XSD references; unresolved element refs map to `z.unknown()` in the output instead of being dropped |
| `--silent` | Suppress informational output (warnings are still shown) |

Bundle all imports and includes into a single self-contained XSD:

```sh
xsd-to-zod bundle main.xsd                         # → main.bundled.xsd
xsd-to-zod bundle main.xsd -o dist/schema.xsd      # → dist/schema.xsd
xsd-to-zod bundle main.xsd --format                 # formatted output
```

Validate an XML document:

```sh
xsd-to-zod validate data.xml --xsd schema.xsd                    # zod tier (typed parse)
xsd-to-zod validate data.xml --xsd schema.xsd -e libxml2         # conformance tier
```

### Programmatic API

```ts
import { parseXsd, irToZod, runPostGenerationFormatting } from 'xsd-to-zod';
import { writeFileSync } from 'node:fs';

const ir = parseXsd(['schema.xsd']);
const { schemas } = irToZod(ir);

writeFileSync('schema.zod.ts', schemas);
runPostGenerationFormatting(['schema.zod.ts']);
```

### Parse and serialize XML

```ts
import { parseXml, safeParseXml, serializeXml } from 'xsd-to-zod';
import { orderSchema } from './generated/order.zod.js';

const order = parseXml(orderSchema, xmlString);          // throws ZodError
const result = safeParseXml(orderSchema, xmlString);     // { success, data | error }
const xml = serializeXml(orderSchema, order);
```

`safeParseXml(schema, xml, { validate: false })` skips the final schema validation — a fast path for input already checked by the conformance tier.

### Conformance tier (`xsd-to-zod/validate`)

```ts
import { validateXml } from 'xsd-to-zod/validate';

const result = await validateXml(xmlString, xsdString, { url: 'schemas/order.xsd' });
if (!result.valid) {
  console.error(result.issues);  // line-numbered XSD errors
}
```

Thin wrapper over [libxml2-wasm](https://www.npmjs.com/package/libxml2-wasm) (the reference libxml2 engine on WebAssembly), loaded via dynamic import — it is an **optional peer dependency**, so browser deployments and zod-tier-only consumers never pay for it. The `url` option lets relative `xs:include`/`xs:import` resolve (from the filesystem in Node).

**Typical upload gate:** `validateXml` first (contract check with line-numbered errors), then `parseXml` (typed data + user-friendly zod issues).

### Working with generated schemas

Every emitted complex-type schema is wrapped in `z.lazy(() => ...)` so cyclic type references and forward references load without errors. `z.infer<typeof FooSchema>` resolves through the lazy wrapper transparently.

If you need to call `.extend()`, `.pick()`, `.omit()` or any object-only method on a generated schema, unwrap it first via the Zod v4 lazy getter:

```ts
import { orderSchema } from './generated/order.zod.js';

const inner = orderSchema.def.getter().def.getter();   // root lazy → type lazy → ZodObject
const extended = inner.extend({ extra: z.string() });
```

The `xmlRegistry` metadata is inspectable too — e.g. `xmlRegistry.get(orderSchema)?.root` returns the root element QName. Registered metadata is informational; parsing/serialization never requires touching it.

## Why trust this?

We ship a **multi-tier test suite** that exercises the full pipeline on real-world and curated fixtures. Every round-trip test validates: XSD → Zod schemas → parse XML (golden-file compare) → serialize back → re-parse → deep-compare → serialized XML validated against the original XSD using libxml2. A smoke test additionally runs `tsc --noEmit` over the generated output of every curated fixture, so invalid-TypeScript codegen bugs cannot slip through.

Run it locally (`npm run test:quick` runs the dev-loop subset without the heavy upstream round-trips):

```sh
npm test
```

**Test matrix** (~2,580 tests):

| Category | Count | What it covers |
|----------|------:|----------------|
| Curated round-trip | 37 | Declarations, content models, cardinality, types, entities/CDATA, namespaces, imports, cyclic refs, defaults — serialized XML validated against libxml2 |
| Upstream round-trip | 16 (14 ✅, 2 ⏭️) | [`xmlschema`](https://github.com/brunato/xmlschema) examples + OASIS UBL Invoice/Order |
| W3C Boeing | 12 (10 ✅, 2 ⚠️) | ipo1–ipo6 discovered from the `.testSet` metadata of the [w3c/xsdtests](https://github.com/w3c/xsdtests) submodule (ipo6 ⚠️ `it.fails`: substitution groups) |
| W3C sun/ms/nist selection | 2,615 (2,418 ✅, 197 ⚠️) | Valid-instance cases from 22 sun/ms test sets + a group-filtered nist datatype pilot; known failures pinned as `it.fails` with categorized reasons |
| W3C negative (invalid instances) | 1,528 (1,520 ✅, 8 ⚠️) | zod tier must reject; lenient acceptances confirmed invalid by libxml2 and recorded in the negative conformance report |
| W3C full corpus (main + weekly) | 13,899 (11,203 ✅, 2,696 ⚠️) | All XSD 1.0 test sets via `suite.xml`; pins dominated by lexical preservation, regex translation, wildcards and substitution groups |
| Pipeline / CLI / runtime | 90+ | Codegen unit tests, runtime coercion, CLI e2e, conformance tier, facet checks |
| Negative | 7 | The zod tier's leniency boundary, pinned (missing required → `ZodError`, foreign root → structural error) |
| Codegen typecheck | 1 | `tsc --noEmit` over all curated fixtures' generated output |

**Test data sources**

- `testdata/curated/` — hand-authored XSD/XML pairs + negative variants (CC0-1.0)
- `testdata/upstream/xmlschema/` — vehicles, collection, stockquote, menù examples from [brunato/xmlschema](https://github.com/brunato/xmlschema) (MIT)
- `testdata/upstream/oasis-ubl-2.4/` — UBL Invoice + Order subset (OASIS RF on Limited Terms)
- `testdata/upstream/w3c-xsdtests/` — git submodule of [w3c/xsdtests](https://github.com/w3c/xsdtests), pinned commit (W3C Document License)

Full license attributions in [`testdata/THIRD_PARTY_NOTICES.md`](testdata/THIRD_PARTY_NOTICES.md). Current suite status and coverage notes live in [`docs/TEST_STATUS.md`](docs/TEST_STATUS.md).

## Limitations

Not supported by the generator (the conformance tier validates them anyway):

- Identity constraints (`xs:key`, `xs:keyref`, `xs:unique`)
- Substitution groups

Zod-tier specifics worth knowing:

- Mixed content: an element's character data segments are concatenated into `_text` — their interleaving with child elements is not preserved on round-trip
- `xs:any` / `xs:anyAttribute` wildcards are captured in an open shape and round-tripped, not validated (lax tier)
- Element order and unexpected elements are not enforced (conformance tier covers them)
- Facets Zod cannot express are not promised (conformance tier covers them)
- `xs:float`/`xs:double` specials `INF`/`-INF`/`NaN` are rejected

### Known gaps (tracked as GitHub issues)

- [#10](https://github.com/PaulDebus/xsd-to-zod/issues/10) — element order / unexpected-element enforcement in generated schemas (cardinality bounds are enforced; the rest belongs to the conformance tier)

## Contributing

Issues and PRs are welcome on [GitHub](https://github.com/PaulDebus/xsd-to-zod). Please branch from `main` and make sure `npm test` passes before submitting.

## License

[GPL-3.0-only](LICENSE) © Paul Debus
