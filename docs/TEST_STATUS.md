# Test Suite Status

## Overview

xsd-to-zod is tested against a corpus of real-world XSD schemas with corresponding XML instance files. The primary test is a **round-trip**: parse the XSD → generate Zod schemas → parse the XML → serialize back to XML → re-parse → deep-compare the two parsed objects. This ensures the generated Zod schemas and runtime metadata correctly handle real-world XML.

Round-trip tests additionally:

- compare the first parse against a checked-in **golden file** (`*.expected.json` next to each curated XML fixture), so symmetric silent data loss cannot pass undetected
- validate the `parseXml` output against the **generated Zod schema** for the root element
- validate the serialized XML against the **XSD whose targetNamespace matches the root element** (not just any candidate schema)

Negative fixtures (`testdata/curated/negative/`) pin the exact lenient parse result, so changes in error handling are visible.

---

## Test Levels

| Level | Command | When | Scope | Est. Time |
|-------|---------|------|-------|-----------|
| **fast** | `npm test` | Every push/PR | Curated fixtures + xmlschema examples + UBL examples + W3C smoke tests | ~5s |

Extended and nightly conformance levels (full W3C corpus) are future work; the W3C smoke subset (`tests/roundtrip-w3c.test.ts`) already runs as part of `npm test`.

---

## Test Data Sources

### Curated in-house fixtures (`testdata/curated/`)

**License:** CC0-1.0 (dedicated to public domain)

Small, hand-authored XSD+XML pairs covering specific XSD constructs. Each file is named after the behavior it tests. Negative test variants change exactly one property to produce invalid XML.

| Group | Files | What it tests |
|-------|-------|---------------|
| Basic declarations | `simple-element`, `attributes`, `simpleType`, `complexType` | Element/attribute/type declarations |
| Content models | `sequence`, `choice`, `all`, `nested-sequence` | Particle compositors |
| Cardinality | `required`, `optional`, `unbounded`, `min-occurs-zero` | minOccurs/maxOccurs |
| Primitive types | `string`, `boolean`, `decimal`, `integer` | XSD type→Zod type mapping |
| Entities | `entities-text`, `entities-attr`, `numeric-refs`, `cdata`, `leading-comment` | Entity decoding, CDATA, comments/PIs |
| Namespaces | `qualified`, `unqualified`, `multi-ns` | elementFormDefault, namespace resolution |
| Imports | `include`, `import`, `chained-imports` | xs:include, xs:import, multi-file schemas |
| Annotations | `documentation` | xs:annotation/xs:documentation → `.describe()` |
| Negative | 7+ invalid XML variants | Round-trip error handling |

### xmlschema examples (`testdata/upstream/xmlschema/`)

**License:** MIT — from [sissaschool/xmlschema](https://github.com/sissaschool/xmlschema)

Four example sets from the Python xmlschema library. These are small, well-structured schemas with known-valid XML instances, useful as quick smoke tests.

| Set | Files | Features exercised |
|-----|-------|-------------------|
| vehicles | 4 XSD + 4 XML | Imports, namespaces, multiple types, error cases |
| collection | 6 XSD + 7 XML | Nested sequences, choice, redefinitions, defaults |
| stockquote | 1 XSD + 1 XML | Simple types, attributes |
| menù | 1 XSD + 1 XML | Choice, nested elements |

### OASIS UBL 2.4 (`testdata/upstream/oasis-ubl-2.4/`)

**License:** OASIS IPR Policy, RF on Limited Terms — from [oasis-open.org](https://docs.oasis-open.org/ubl/os-UBL-2.4/UBL-2.4.html)

Real-world business document schemas (Invoice, Order, CreditNote, etc.) with a large modular XSD graph. Tests:
- Multi-file schema loading with numerous local imports/includes
- Shared component schemas and cross-namespace references
- Extension types (complexContent extension chains)
- Large documents with optional/repeated structures
- Code lists and enumerated values

### W3C XML Schema Test Suite (`testdata/upstream/w3c-xsdtests/`)

**License:** W3C Document License — from [w3.org](https://www.w3.org/XML/2004/xml-schema-test-suite/)

Consumed as a git submodule (pinned commit). The W3C test suite is the authoritative conformance corpus for XSD processors. A small smoke subset (the Boeing ipo1–ipo4 datasets) runs in the fast suite; running the full corpus is future work.

Features tested include:
- Built-in datatypes and facets
- xs:sequence, xs:choice, xs:all
- Derivation by extension and restriction
- Namespaces, imports, includes
- xsi:type, xsi:nil
- Schema validity errors and instance validity errors

---

## Phase 1 — Fast suite (current)

- [x] Basic declarations (element, attribute, complexType, simpleType)
- [x] Content models (sequence, choice, all)
- [x] Cardinality (required, optional, unbounded)
- [x] Primitive types (string, boolean, decimal, integer)
- [x] Entities, CDATA, comments
- [x] Namespaces (qualified, unqualified, multi-ns)
- [x] Imports/includes
- [x] Negative test variants (7, with pinned lenient results)
- [x] xmlschema examples (vehicles, collection, stockquote, menù)
- [x] UBL Invoice + Order round-trips
- [x] W3C smoke subset (Boeing ipo1–ipo4)
- [x] CI workflow (fast on push/PR)

## Phase 2 — Extended suite (future)

- [ ] Larger W3C XSD 1.0 subset (50-100 cases)
- [ ] UBL CreditNote round-trip
- [ ] Import-resolution failure cases

## Phase 3 — Full conformance (future)

- [ ] Full W3C XSD 1.0 corpus
- [ ] XSD 1.1 corpus (if licensing clarified)

---

## Known gaps (not yet supported by xsd-to-zod)

These features exist in the test corpus but are skipped because the tool doesn't support them yet:

- Mixed content models
- `xs:any` / `xs:anyAttribute` wildcards
- Identity constraints (`xs:key`, `xs:keyref`, `xs:unique`)
- Substitution groups
- Attribute groups

---

## License summary

| Source | License | How we use it |
|--------|---------|---------------|
| Curated fixtures | CC0-1.0 | Checked into repo |
| xmlschema examples | MIT | Checked into repo, attribution in THIRD_PARTY_NOTICES.md |
| OASIS UBL 2.4 | OASIS RF on Limited Terms | Checked into repo, attribution in THIRD_PARTY_NOTICES.md |
| W3C XSD test suite | W3C Document License | Git submodule (not redistributed), attribution in THIRD_PARTY_NOTICES.md |
