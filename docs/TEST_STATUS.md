# Test Suite Status

## Overview

xsd-to-zod is tested against a corpus of real-world XSD schemas with corresponding XML instance files. The primary test is a **round-trip**: parse the XSD → generate Zod schemas → parse the XML → serialize back to XML → re-parse → deep-compare the two parsed objects. This ensures the generated Zod schemas and runtime metadata correctly handle real-world XML.

Round-trip tests additionally:

- compare the first parse against a checked-in **golden file** (`*.expected.json` next to each curated XML fixture), so symmetric silent data loss cannot pass undetected
- validate the `parseXml` output against the **generated Zod schema** for the root element
- validate the serialized XML against the **XSD whose targetNamespace matches the root element** (not just any candidate schema)

Negative fixtures (`testdata/curated/negative/`) pin the exact lenient parse result, so changes in error handling are visible.

Codegen output itself is pinned by **golden snapshots** (`tests/golden.test.ts`): the full generated module for one representative case per curated category, so every change to the emitted code is a reviewable diff.

---

## Test Levels

| Level | Command | When | Scope |
|-------|---------|------|-------|
| **quick** | `npm run test:quick` | Dev loop | Curated fixtures + unit tests + golden snapshots + W3C Boeing smoke |
| **full** | `npm test` | Every push/PR (CI) | Everything, incl. xmlschema examples, UBL examples and the expanded W3C selection |
| **corpus** | `npm run test:corpus` | Merge to main + weekly | Full XSD 1.0 W3C corpus via `suite.xml` discovery (`tests/corpus/`, excluded from the PR levels) |

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

Consumed as a git submodule (pinned commit). The W3C test suite is the authoritative conformance corpus for XSD processors. Test groups are discovered from the suite's `.testSet` metadata files (`tests/w3cDriver.ts`), not hardcoded directories; test names carry the group's XSD spec anchors (from `documentationReference`). The Boeing ipo1–ipo6 datasets run in all levels (ipo6 pinned as `it.fails`: substitution groups unsupported); a broader valid-instance-only selection (`tests/roundtrip-w3c-extended.test.ts`: 18 sun/ms test sets, the ms schema-composition/annotation sets, and a group-filtered nist datatype pilot) runs in the full level, with known failures pinned as `it.fails` in `tests/w3cKnownFailures.ts`. Invalid-instance (negative) tests (`tests/roundtrip-w3c-negative.test.ts`) assert the zod tier rejects what the suite marks invalid; where the zod tier is intentionally lenient, the libxml2 tier is the conformance authority and the leniency is recorded in `.xsd-to-zod-tests/w3c-negative-conformance.json`.

Note: the pre-errata sun tests use relative namespace URIs (e.g. `targetNamespace="SType/ST_facets"`), which libxml2 refuses to load — for those cases the libxml2 cross-validation of the serialized XML is skipped (the zod-tier round-trip still runs in full).

Features tested include:
- Built-in datatypes and facets
- xs:sequence, xs:choice, xs:all
- Derivation by extension and restriction
- Namespaces, imports, includes
- xsi:type, xsi:nil
- Schema validity errors and instance validity errors

---

## Phase 1 — Current suite

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
- [x] W3C smoke subset (Boeing ipo1–ipo6, discovered via `.testSet` metadata; ipo6 pinned as `it.fails` — substitution groups)
- [x] W3C sun/ms selection + Phase 2 expansion (2,615 valid-instance cases from 22 test sets + a group-filtered nist pilot; 2,404 passing, 219 pinned as `it.fails` with categorized reasons in `tests/w3cKnownFailures.ts`)
- [x] W3C sun/ms selection + Phase 2 expansion (2,615 valid-instance cases from 22 test sets + a group-filtered nist pilot; 2,287 passing, 327 pinned as `it.fails` with categorized reasons in `tests/w3cKnownFailures.ts`)
- [x] W3C invalid-instance (negative) tests (1,528 cases: 1,139 rejected by the zod tier, 574 accepted leniently — libxml2 confirms invalid, recorded in the negative conformance report, 7 pinned)
- [x] Spec-section conformance report (`.xsd-to-zod-tests/w3c-conformance.json`, generated each run from `documentationReference` anchors)
- [x] CI workflow (full suite on push/PR, `test:quick` for the dev loop)

## Phase 2 — Extended suite (future)

- [ ] Triage the pinned W3C known failures (largest buckets: `xs:anyType` content, `xs:any` wildcards, libxml2-rejected serializations, lexical preservation for enum/pattern, nested choice groups)
- [ ] Broader W3C subset (more nistData datatype groups via the group filter; remaining msData Regex/Notations when those features land)
- [ ] UBL CreditNote round-trip
- [ ] Import-resolution failure cases

## Phase 3 — Full conformance (current)

- [x] Full XSD 1.0 corpus via `suite.xml` discovery (on merge to main + weekly, ~3 min: 13,899 valid-instance cases from 34 test sets — 11,203 passing, 2,696 pinned as `it.fails` in `tests/w3cCorpusKnownFailures.ts`, dominated by lexical preservation for enum/pattern, XSD regex translation, wildcards and substitution groups; XSD 1.1 sets excluded — licensing, plus 1.1 features; `common/introspection` excluded — multi-MB metadata documents)
- [ ] XSD 1.1 corpus (if licensing clarified)

---

## Known gaps (not yet supported by xsd-to-zod)

These features exist in the test corpus but are skipped because the tool doesn't support them yet:

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
