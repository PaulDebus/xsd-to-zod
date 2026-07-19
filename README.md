# xsd2zod

[![npm version](https://img.shields.io/npm/v/xsd2zod.svg)](https://www.npmjs.com/package/xsd2zod)
[![Tests](https://github.com/PaulDebus/xsd2zod/actions/workflows/test.yml/badge.svg)](https://github.com/PaulDebus/xsd2zod/actions/workflows/test.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

> Turn XSD schemas into type-safe Zod parsers for XML.

**xsd2zod** reads your XSD files and emits strongly-typed Zod schemas that carry their XML knowledge in a typed Zod registry — **one generated artifact**. Its runtime walks those schemas to `parseXml(xml)` into plain objects and `serializeXml(data)` back out again, with validation enforced by the schemas themselves. An optional libxml2-backed conformance tier covers full XSD semantics.

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
npx xsd2zod order.xsd -o src/generated --format
```

The generated `order.zod.ts` looks like:

```ts
import { z } from 'zod';
import { xmlRegistry } from 'xsd2zod';

const schemas: Record<string, z.ZodTypeAny> = {};
schemas["{urn:example}OrderType"] = z.lazy(() => z.object({
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
export const orderSchema = z.lazy(() => schemas["{urn:example}OrderType"])
  .register(xmlRegistry, { root: "{urn:example}order" });
```

Use it in TypeScript:

```ts
import { parseXml, serializeXml } from 'xsd2zod';
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

- **XSD constructs**: `sequence`, `choice` (→ per-group refine checks), `all`, `attribute`, `simpleContent`, `complexContent` (extension flattening), `xs:group`, `xs:attributeGroup`, `xs:redefine`
- **Simple type restrictions**: facets become Zod checks where Zod can express them — `enumeration` (→ `z.enum` / literal unions), `pattern` (→ `.regex`), length/min/max (→ `.length`/`.min`/`.max`), `totalDigits`/`fractionDigits` (→ digit-count refinements), `whiteSpace` collapse/replace (→ preprocess transform). `xs:list` (→ whitespace-splitting `z.preprocess` + `z.array`) and `xs:union` (→ `z.union`) are supported
- **Namespaces**: Clark notation `{ns}local` throughout, qualified/unqualified form defaults, `xs:include`/`xs:import` across files
- **Chameleon includes**: inherited target namespace for includee schemas without a `targetNamespace`
- **Encoding detection**: BOM and declaration sniffing (UTF-16LE/BE, CP1252, UTF-8) via `iconv-lite`
- **Cardinality**: `minOccurs`/`maxOccurs` → `.optional()` / `z.array()`; defaults/fixed with XSD-correct semantics (attribute defaults on absence, element defaults on present-but-empty)
- **Nillable**: `xsi:nil="true"` → `.nullable()` in schema, round-trips through `serializeXml`
- **Cyclic references**: every emitted complex-type schema is wrapped in `z.lazy(() => ...)` so forward references and true cycles (e.g. `Person.manager: Person`) load without `ReferenceError`
- **Two validation tiers**: the zod tier (typed parse, user-friendly `ZodError`s) and an optional libxml2 conformance tier (full XSD semantics, line-numbered errors)

## Install

```sh
npm install xsd2zod
```

`zod` v4 ships as a regular dependency. For the optional conformance tier (`xsd2zod/validate`), also install:

```sh
npm install libxml2-wasm
```

## Usage

### CLI

```sh
npx xsd2zod schema.xsd -o src/generated --format
# → src/generated/schema.zod.ts

npx xsd2zod types.xsd elements.xsd -o src/generated -n my-api
# → src/generated/my-api.zod.ts
```

| Flag | Description |
|------|-------------|
| `-o, --out <dir>` | Output directory (default: current directory) |
| `-n, --name <name>` | Basename for the generated file (required with multiple inputs) |
| `-f, --format` | Run `biome` / `prettier` / `eslint` on the generated file if configured |

Validate an XML document:

```sh
xsd2zod validate data.xml --xsd schema.xsd                    # zod tier (typed parse)
xsd2zod validate data.xml --xsd schema.xsd -e libxml2         # conformance tier
```

### Programmatic API

```ts
import { parseXsd, irToZod, runPostGenerationFormatting } from 'xsd2zod';
import { writeFileSync } from 'node:fs';

const ir = parseXsd(['schema.xsd']);
const { schemas } = irToZod(ir);

writeFileSync('schema.zod.ts', schemas);
runPostGenerationFormatting(['schema.zod.ts']);
```

### Parse and serialize XML

```ts
import { parseXml, safeParseXml, serializeXml } from 'xsd2zod';
import { orderSchema } from './generated/order.zod.js';

const order = parseXml(orderSchema, xmlString);          // throws ZodError
const result = safeParseXml(orderSchema, xmlString);     // { success, data | error }
const xml = serializeXml(orderSchema, order);
```

`safeParseXml(schema, xml, { validate: false })` skips the final schema validation — a fast path for input already checked by the conformance tier.

### Conformance tier (`xsd2zod/validate`)

```ts
import { validateXml } from 'xsd2zod/validate';

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

## Migrating from the dual-artifact API (pre-1.0)

The `.zod.ts` + `.meta.ts` pair is now a single `.zod.ts`. Removed and changed APIs:

| Removed | Replacement |
|---|---|
| `createRootHelpers(rootMeta, types)` → `parseXml` / `serializeXml` | `parseXml(schema, xml)` / `serializeXml(schema, data)` from `xsd2zod` |
| `parseXmlWithMetadata` / `serializeXmlWithMetadata` | same as above (with `safeParseXml` as the non-throwing variant) |
| `buildRuntimeMetadata(ir)` | gone — metadata lives in `xmlRegistry` entries of the generated schemas |
| `RuntimeMetadata` & friends | `XmlMeta` / `XmlFieldMeta` types |
| `.meta.ts` file / `--metadata` CLI flag | gone — `xsd2zod validate` drives everything from `--xsd` |

Behavioral changes to know about:

- **Validation is enforced**: `parseXml` always ends in schema validation and throws `ZodError`; the old lenient mode is gone. `safeParseXml(..., { validate: false })` is the escape hatch for pre-validated input.
- **Choice**: the `__choice` discriminator key no longer appears in parsed data. Mutual exclusion is enforced by generated refine checks (including multi-group and group-ref choices).
- **Defaults**: attribute-with-default now always appears in parsed output (XSD-correct) and its `z.infer` type is non-optional. Element defaults apply to *present-but-empty* elements, not absent ones.
- **Roots of empty complex types** parse to `{}` (previously a scalar/`{_text}` object).
- **INF/-INF/NaN** lexicals are rejected by the zod tier (Zod cannot express non-finite numbers); the conformance tier accepts them.
- The zod tier is deliberately lenient about cardinality bounds beyond `0/1/unbounded`, element order, and unexpected elements — the conformance tier is the strict one.

## Why trust this?

We ship a **multi-tier test suite** that exercises the full pipeline on real-world and curated fixtures. Every round-trip test validates: XSD → Zod schemas → parse XML (golden-file compare) → serialize back → re-parse → deep-compare → serialized XML validated against the original XSD using libxml2. A smoke test additionally runs `tsc --noEmit` over the generated output of every curated fixture, so invalid-TypeScript codegen bugs cannot slip through.

Run it locally:

```sh
npm test
```

**Test matrix** (~185 tests, ~20 s):

| Category | Count | What it covers |
|----------|------:|----------------|
| Curated round-trip | 37 | Declarations, content models, cardinality, types, entities/CDATA, namespaces, imports, cyclic refs, defaults — serialized XML validated against libxml2 |
| Upstream round-trip | 16 (14 ✅, 2 ⏭️) | [`xmlschema`](https://github.com/brunato/xmlschema) examples + OASIS UBL Invoice/Order |
| W3C smoke | 9 | Boeing IPO variants via [w3c/xsdtests](https://github.com/w3c/xsdtests) submodule |
| Pipeline / CLI / runtime | 90+ | Codegen unit tests, runtime coercion, CLI e2e, conformance tier, facet checks |
| Negative | 7 | The zod tier's leniency boundary, pinned (missing required → `ZodError`, foreign root → structural error) |
| Codegen typecheck | 1 | `tsc --noEmit` over all curated fixtures' generated output |

**Test data sources**

- `testdata/curated/` — hand-authored XSD/XML pairs + negative variants (CC0-1.0)
- `testdata/upstream/xmlschema/` — vehicles, collection, stockquote, menù examples from [brunato/xmlschema](https://github.com/brunato/xmlschema) (MIT)
- `testdata/upstream/oasis-ubl-2.4/` — UBL Invoice + Order subset (OASIS RF on Limited Terms)
- `testdata/upstream/w3c-xsdtests/` — git submodule of [w3c/xsdtests](https://github.com/w3c/xsdtests), pinned commit (W3C Document License)

Full license attributions in [`testdata/THIRD_PARTY_NOTICES.md`](testdata/THIRD_PARTY_NOTICES.md).

## Limitations

Not supported by the generator (the conformance tier validates them anyway):

- Mixed content models
- `xs:any` / `xs:anyAttribute` wildcards
- Identity constraints (`xs:key`, `xs:keyref`, `xs:unique`)
- Substitution groups

Zod-tier specifics worth knowing:

- Cardinality beyond `0/1/unbounded`, element order, and unexpected elements are not enforced (conformance tier covers them)
- Facets Zod cannot express are not promised (conformance tier covers them)
- `xs:float`/`xs:double` specials `INF`/`-INF`/`NaN` are rejected

### Known gaps (tracked as GitHub issues)

- [#10] — cardinality/order/unexpected-element enforcement in generated schemas (re-evaluated after the registry rework)
