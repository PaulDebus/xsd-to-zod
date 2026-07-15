# xsd2zod

[![npm version](https://img.shields.io/npm/v/xsd2zod.svg)](https://www.npmjs.com/package/xsd2zod)
[![Tests](https://github.com/PaulDebus/xsd2zod/actions/workflows/test.yml/badge.svg)](https://github.com/PaulDebus/xsd2zod/actions/workflows/test.yml)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

> Turn XSD schemas into type-safe Zod parsers for XML.

**xsd2zod** reads your XSD files, emits strongly-typed Zod schemas, and gives you a metadata-driven XML runtime so you can `parseXml(xml)` into plain objects and `serializeXml(data)` back out again.

```
XSD files ──► parseXsd() ──► IR ──► irToZod()
                                        │
                                        ▼
                        { Zod schemas, runtime metadata }
                                        │
                                        ▼
                         createRootHelpers() ──► parseXml / serializeXml
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

Use it in TypeScript:

```ts
import { z } from 'zod';
import { createRootHelpers } from 'xsd2zod';
import { orderSchema } from './generated/order.zod.js';
import { runtimeMetadata } from './generated/order.meta.js';

const orderMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}order'))!;
const { parseXml } = createRootHelpers<z.infer<typeof orderSchema>>(orderMeta);

const data = parseXml(`
  <order xmlns="urn:example" id="42">
    <item>widget</item>
    <sku>W-001</sku>
  </order>
`);

// data is fully typed:
// {
//   item: string[];
//   sku: string;
//   '@id': '42';
// }
```

## Features

- **XSD constructs**: `sequence`, `choice` (→ `z.discriminatedUnion`), `all`, `attribute`, `simpleContent`, `complexContent` (extension flattening)
- **Namespaces**: Clark notation `{ns}local` throughout, qualified/unqualified form defaults, `xs:include`/`xs:import` across files
- **Cardinality**: `minOccurs`/`maxOccurs` → `z.array()` / `.optional()`, `unbounded`
- **Nillable**: `xsi:nil="true"` → `.nullable()` in schema, round-trips through `serializeXml`
- **Element refs**: `<xs:element ref="t:global"/>` resolved via global element declarations
- **Runtime**: metadata-driven XML parsing and serialization with full namespace prefix management

## Install

```sh
npm install xsd2zod
```

No build step is required at runtime. If you want compile-time types, also install:

```sh
npm install -D zod typescript
```

## Usage

### CLI

Generate one file pair per namespace basename:

```sh
npx xsd2zod schema.xsd -o src/generated --format
# → src/generated/schema.zod.ts
# → src/generated/schema.meta.ts
```

Multiple XSDs and a custom basename:

```sh
npx xsd2zod types.xsd elements.xsd -o src/generated -n my-api
# → src/generated/my-api.zod.ts
# → src/generated/my-api.meta.ts
```

| Flag | Description |
|------|-------------|
| `-o, --output <dir>` | Output directory (default: current directory) |
| `-n, --name <name>` | Basename for the generated files |
| `--format` | Run `biome` / `prettier` / `eslint` on generated files if available |

### Programmatic API

```ts
import { parseXsd, irToZod, runPostGenerationFormatting } from 'xsd2zod';
import { writeFileSync } from 'node:fs';

const ir = parseXsd(['schema.xsd']);
const { schemas, metadata } = irToZod(ir);

writeFileSync('schema.zod.ts', schemas);
writeFileSync('schema.meta.ts', metadata);

// Optional: format with a tool already in your project
runPostGenerationFormatting(['schema.zod.ts', 'schema.meta.ts']);
```

### Parse and serialize XML

```ts
import { z } from 'zod';
import { createRootHelpers } from 'xsd2zod';
import { orderSchema } from './schema.zod.js';
import { runtimeMetadata } from './schema.meta.js';

const orderMeta = runtimeMetadata.roots.find(r => r.rootElement.endsWith('}order'))!;
const { parseXml, serializeXml } = createRootHelpers<z.infer<typeof orderSchema>>(orderMeta);

const order = parseXml(`<order xmlns="urn:example" id="42">...</order>`);
const xml = serializeXml(order);
```

## Why trust this?

We ship a **multi-tier test suite** that exercises the full pipeline on real-world and curated fixtures. Every test validates round-trip fidelity: XSD → Zod schemas → parse XML → serialize back → re-parse → deep-compare.

Run it locally:

```sh
npm test
```

**Test matrix** (~80 tests, ~6 s):

| Category | Count | What it covers |
|----------|------:|----------------|
| Curated round-trip | 22 | Basic declarations, content models, cardinality, types, namespaces, imports |
| Upstream round-trip | 17 | [`xmlschema`](https://github.com/brunato/xmlschema) examples + OASIS UBL Invoice/Order |
| W3C smoke | 8 | Boeing IPO variants via [w3c/xsdtests](https://github.com/w3c/xsdtests) submodule |
| Pipeline / CLI | 21 | CLI entry point, code generation, and unit tests |
| Benchmark | 1 | Parses all upstream XSDs in under 5 s |
| Negative | 7 | Namespace rejection and graceful handling of lenient validation |

**Test data sources**

- `testdata/curated/` — 22 hand-authored XSD/XML pairs + 7 negative variants (CC0-1.0)
- `testdata/upstream/xmlschema/` — vehicles, collection, stockquote, menù examples from [brunato/xmlschema](https://github.com/brunato/xmlschema) (MIT)
- `testdata/upstream/oasis-ubl-2.4/` — UBL Invoice + Order subset (OASIS RF on Limited Terms)
- `testdata/upstream/w3c-xsdtests/` — git submodule of [w3c/xsdtests](https://github.com/w3c/xsdtests), pinned commit (W3C Document License)

Full license attributions in [`testdata/THIRD_PARTY_NOTICES.md`](testdata/THIRD_PARTY_NOTICES.md).

## Limitations (v1)

- Simple type restrictions (`enumeration`, `pattern`, etc.) are not modeled — base type is used
- `xs:any` / `xs:anyAttribute` wildcards are not supported
- Attribute `ref` is parsed but type defaults to `xs:string` (global attribute declarations not collected)
- Mixed content models are not supported

### Known gaps (tracked as GitHub issues)

- [#8] — `serializeXml` fails on nested complex types (`[object Object]`)
- [#9] — `irToZod` omits runtime metadata for root elements with primitive/simple types
- [#10] — generated Zod schemas don't enforce cardinality, order, or unexpected elements
