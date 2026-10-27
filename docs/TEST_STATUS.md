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
| **corpus** | `npm run test:corpus` | Merge to main + weekly | Full XSD 1.0 W3C corpus via `suite.xml` discovery — valid instances, invalid instances, and invalid schemas (`tests/corpus/`, excluded from the PR levels) |
| **release** | `npm run test:release` | 0.4.0 release commit | Lint + full suite with coverage thresholds + full corpus |

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

Consumed as a git submodule (pinned commit). The W3C test suite is the authoritative conformance corpus for XSD processors. Test groups are discovered from the suite's `.testSet` metadata files (`tests/w3cDriver.ts`), not hardcoded directories; test names carry the group's XSD spec anchors (from `documentationReference`). The Boeing ipo1–ipo6 datasets run in all levels; a broader valid-instance-only selection (`tests/roundtrip-w3c-extended.test.ts`: 18 sun/ms test sets, the ms schema-composition/annotation sets, and every NIST datatype family — atomic, list and union) runs in the full level, with known failures pinned as `it.fails` in `tests/w3cKnownFailures.ts`. The NIST families generate in the exact integer mapping (`integers: "bigint"`) so 64-bit boundary lexicals round-trip instead of hitting the default number mapping's ±2⁵³ ceiling. Invalid-instance (negative) tests (`tests/roundtrip-w3c-negative.test.ts`) assert the zod tier rejects what the suite marks invalid; where the zod tier is intentionally lenient, the libxml2 tier is the conformance authority and the leniency is recorded in `.xsd-to-zod-tests/w3c-negative-conformance.json`.

Invalid-**schema** tests run in the corpus level (`tests/corpus/schema-validity-*.test.ts`). The driver's `discoverInvalidSchemaCases` selects test groups whose schema the suite marks invalid for XSD 1.0 — version-qualified expectations are resolved per version, so schemas that are only invalid in XSD 1.1 and `indeterminate` (implementation-defined) groups are not selected. `validateSchema` (the libxml2 tier) is the conformance authority: a case passes when the zod tier rejects the schema, whether libxml2 rejects it too or lets it through; where codegen silently accepts an invalid schema that libxml2 rejects, the gap is recorded as leniency in `.xsd-to-zod-tests/w3c-schema-validity-corpus.json`. A schema both tiers accept is an anomaly, pinned as `it.fails` in `tests/w3cCorpusSchemaValidityKnownAnomalies.ts` (362 libxml2 schema-constraint gaps and 30 XSD 1.0-invalid/XSD 1.1-valid expectations).

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
- [x] W3C smoke subset (Boeing ipo1–ipo6, discovered via `.testSet` metadata)
- [x] W3C sun/ms selection + NIST datatypes (13,035 valid-instance cases from 22 test sets, including every NIST datatype family — atomic, list and union; 13,002 passing, 33 pinned as `it.fails` with categorized reasons in `tests/w3cKnownFailures.ts`)
- [x] W3C invalid-instance (negative) tests (10,026 cases, including every NIST datatype family — atomic, list and union: the zod tier rejects what the suite marks invalid or libxml2 confirms the leniency, recorded in the negative conformance report, 6 pinned)
- [x] Spec-section conformance report (`.xsd-to-zod-tests/w3c-conformance.json`, generated each run from `documentationReference` anchors)
- [x] CI workflow (full suite on push/PR, `test:quick` for the dev loop)

## Phase 2 — Extended suite (future)

- [x] Triage the pinned W3C known failures — remaining buckets and their dispositions are tracked in #122. Done so far: `xs:any` wildcards (position-aware extras), `xs:anyType` content, lexical preservation (lexical-space facets enforced by the runtime, lexicals re-emitted on serialize), XSD regex translation (class subtraction, `\p{IsBlock}`), occurrence-aware nested choice, substitution groups (#183), QName-value namespace declarations + repeated-particle merges (#186), XML attribute-value normalization (#187), XML-namespace attributes without a declaration (`xml:base`/`xml:space`; the harness supplies the standard declarations to libxml2) + `xs:list` attribute defaults (#122 `undefinedValue` bucket), root-element `xs:list` `default`/`fixed` values (stZ072), xsi:type derived-type polymorphism (discriminated-union dispatch in codegen + runtime, lossless capture fallback for unknown QNames; cleared `ctA002`/`ctA003`/`ctL022`), simpleContent extension via `simpleContent` derivation (cleared `basetd00101m2`), whitespace-only text nodes survive the parse (cleared `xsd001`, the `reG`/`reI`/`reJ`/`reO`/`reP`/`reQ`/`reR` regex whitespace cases), XML 1.0 line-ending normalization (`errC001`), declared default/fixed lexicals retained on substitution (`valueConstraint00501m*`, `valueConstraint00601m7`), whiteSpace-processed fixed/enum literals (`attO009`–`attO011`), value-space fixed-lexical emission (`stE065`/`stE066`), union memberTypes + inline members (`particlesZ005`/`particlesZ012`), OR-within-step patterns (`p16`/`p17`/`p20`), XSD-regex block-name normalization + full block coverage (`reL*`/`LatinExtended-*`/`ArabicPresentationForms-*`/`reDF*`), per-position fixed constraints for merged same-name siblings (`isDefault079`), same-qname emission dedupe with merged cardinality + document order (`mgO006`/`mgQ003`/`particlesQ030`/`particlesQ032`), position-aware wildcard/field occurrence claiming (`QFE1700c2`), simpleContent text-type resolution across forward-declared bases (`basetd00101m1`), xsi:type preservation on open content (`idF012`–`idF014`).
- [ ] Broader W3C subset (remaining msData Regex/Notations when those features land)
- [ ] UBL CreditNote round-trip
- [ ] Import-resolution failure cases

## Phase 3 — Full conformance (current)

- [x] Full XSD 1.0 corpus via `suite.xml` discovery (on merge to main + weekly, ~3 min: 13,899 valid-instance cases from 34 test sets — 13,879 passing, 20 pinned as `it.fails` in `tests/w3cCorpusKnownFailures.ts`; XSD 1.1 sets excluded — licensing, plus 1.1 features; `common/introspection` excluded — multi-MB metadata documents)
- [x] Full-corpus invalid instances (10,942 cases from the same 34 test sets, sharded ms/sun/nist/misc: 10,916 pass, 26 anomalies pinned as `it.fails` in `tests/w3cCorpusNegativeKnownAnomalies.ts`; per-shard leniency reports merge into `.xsd-to-zod-tests/w3c-negative-corpus.json`)
- [x] Full-corpus invalid schemas (3,329 groups from the same 34 test sets, sharded ms/sun/nist/misc: libxml2 rejects the schema for 2,937 cases — codegen rejects 75 of those and is lenient on 2,862; 392 anomalies both tiers accept are pinned as `it.fails` in `tests/w3cCorpusSchemaValidityKnownAnomalies.ts`; per-shard leniency reports merge into `.xsd-to-zod-tests/w3c-schema-validity-corpus.json`)
- [ ] XSD 1.1 corpus (if licensing clarified)

---

## 0.4.0 test-health audit

Audited on 2026-10-26 against `main` (`f055587`) for the 0.4.0 round. Every
level was green locally on that run:

| Level | Files | Result | Wall time |
|-------|------:|--------|-----------|
| **quick** | 57 | 739 passed | ~17 s |
| **full** | 60 | 4,939 passed, 39 expected failures, 2 skipped | ~50 s |
| **coverage** | 60 | same tests; all thresholds pass | ~54 s |
| **corpus** | 4 | 13,879 passed, 20 expected failures | ~69 s |

Coverage was 93.93% statements, 87.27% branches, 97.37% functions and 93.95%
lines (thresholds 86 / 78 / 89 / 87). No `src/` function is entirely
unexecuted. The remaining uncovered lines are defensive branches, not missing
features:

| Area | Lowest module coverage | Uncovered | Disposition |
|------|------------------------|-----------|-------------|
| Remote schema acquisition | `download.ts` 86.9% lines / 67.9% branches; `remoteSchemaStore.ts` 86.6 / 79.5; `fetchSchema.ts` 91.4 / 89.1 | Rare redirect/URL failures, vendored-name sanitisation and collision handling, cache/lockfile corruption after open, temp-file cleanup | Defensive paths. The remote e2e suite covers the supported flows; add focused failure tests as follow-up, not a release blocker. |
| CLI surface | `cli.ts` 94.2 / 86.6 | Uncommon option and usage-error combinations | Supported flows are covered by CLI e2e; errors stay honest. |
| XSD edge lexicals | `xsdPattern.ts` 89.1 / 85.7; `xsdDateTime.ts` 94.5 / 89.1 | Rare regex-translation and date/time lexical branches | Backstopped by the 13,899-case W3C corpus. |
| Validation reporting | `validate.ts` 100 / 79.4 | Synthetic libxml2 detail shapes and schema-load fallbacks | The success, issue and fallback contracts are tested; branches are defensive. |

### Corpus coverage notes

- **NIST datatype families match the corpus integer mapping.** The PR-level
  NIST datatype selection (positive and negative) covers every family. The
  positive side generates in the exact integer mapping (`integers: "bigint"`),
  as the corpus does, so 64-bit boundary lexicals round-trip instead of hitting
  the default number mapping's ±2⁵³ ceiling. The default mapping's boundary
  divergences stay pinned for the sun/ms selection cases that exercise it.
- **Invalid-schema harness mode.** Its deliverable is a leniency map, not a
  conformance fix; codegen currently accepts most invalid schemas by design
  (2,862 of the 2,937 libxml2-rejected schemas). It shares discovery, sharding,
  pinning and report merging with the corpus negative mode.

### Release gate

0.4.0 ships only from a commit where `npm run test:release` passes. That runs
lint, the full suite with the coverage thresholds, and the full W3C corpus —
`test:quick` is the dev loop and is never the release gate. The corpus
prerequisite fails the gate when the W3C submodule is missing, so a skipped
corpus cannot pass as green. `npm publish` runs the same gate through
`prepublishOnly`; `npm pack` and the publish/tag steps stay in the release
issue.

---

## Pinned known failures

Corpus cases that fail the round-trip are pinned as `it.fails` with a
categorized reason: the case keeps running, and a fix that makes it pass
turns the suite red until the pin is removed in the same PR. Two pin files:
`tests/w3cKnownFailures.ts` (sun/ms selection, 33 pins) and
`tests/w3cCorpusKnownFailures.ts` (full corpus, 20 pins). #122 tracks the
buckets with per-case triage notes; their dispositions:

All former fix buckets are cleared: `needsTriage`, `simpleContentShape`,
`patternOnNonString` (XSD-regex translation gaps), `choiceDocumentOrder` and
the `libxmlRejectsSerialized` document-order cases are fixed — including
whitespace-only text nodes surviving the parse, declared default/fixed
lexicals retained on substitution, per-position fixed constraints for merged
same-name siblings, position-aware wildcard/field occurrence claiming, and
xsi:type preservation on open content. What remains is entirely won't-fix:

- **`libxmlGap` (8 selection + 13 corpus)** — the original W3C
  instance/schema fails libxml2 itself (pre-errata XSD 1.0 gMonth lexical,
  `maxOccurs` beyond libxml2's integer range, libxml2's XSD-regex dialect
  rejecting valid patterns or NameChar editions, `all` with `maxOccurs=0`,
  union fixed-value compared lexically). The zod-tier round-trip succeeds;
  the pin records the libxml2 tier's deviation.
- **`libxmlStrictWildcardXsiType` (1 + 1)** — strict-wildcard item with
  xsi:type but no global element declaration (the original fails libxml2 too).
- **`noRootDeclaration` (6 + 6)** — type-library schemas with no global
  element matching the instance root (instance validity rides xsi:type root
  assessment); the generated artifact has no root schema to parse with.
- **`beyondSafeInteger` (18 selection + 0 corpus)** — the instance carries
  integers beyond ±2⁵³; the default number mapping rejects out-of-safe-range
  lexicals rather than rounding them. The full corpus and the NIST datatype
  selection generate in the exact mapping (`integers: "bigint"`), so the
  bucket exists only for sun/ms selection cases, which exercise the default.

## Definition of done

The goal was never 13,899/13,899 — the corpus contains cases that are
unpassable by design (libxml2 rejects the original instance) or out of the
zod tier's scope. The goal is **zero unexplained failures**: every case
either round-trips or carries a documented, verified reason it can't.
Conformance work on the zod tier is done while these invariants hold — each
enforced by the suite itself, not by review discipline:

1. **Zero unpinned failures.** Every failing corpus case has a pin entry,
   and every pin's reason comes from the closed reason enum in the pin file
   (`tests/w3cPinVerification.test.ts` asserts the closed set).
2. **Pins are self-expiring.** Pins run as `it.fails`, so a fix that makes a
   pinned case pass turns the suite red until the pin is removed in the same
   PR.
3. **Pin claims are re-verified, not just asserted.**
   `tests/w3cPinVerification.test.ts` re-checks each pin's stated reason:
   libxml-deviation pins must still fail libxml2 on the *original* instance
   (a libxml2 upgrade that closes a gap breaks the build and forces an
   unpin), and no-root pins must still have no global element matching the
   instance root.
4. **Scope boundaries are documented once** (see "Intentionally out of
   scope" below): identity constraints and validation conformance belong to
   the libxml2 tier; XSD 1.1 is excluded.
5. **Remaining gaps are feature work, not conformance debt.** e.g. rootless
   xsi:type assessment (`noRootDeclaration`) or XSD 1.1 — if picked up, they
   get their own feature issues, not a place in the failure count.

## Intentionally out of scope (zod tier)

- **Identity constraints** (`xs:key`, `xs:keyref`, `xs:unique`) — cross-document
  referential checks, not shape/type validation; the libxml2 tier
  (`xsd-to-zod/validate`) is the conformance authority and already enforces
  them. Note the two skipped xmlschema collection fixtures
  (`collection2`/`collection3` in `tests/roundtrip-upstream.test.ts`) are
  inherent test-data violations — libxml2 rejects the original XML itself
  (duplicate `xs:key` sequence, unmatched `xs:keyref`) — so they stay skipped
  regardless of feature support.
- **Anything that would compromise the generated API** — the target is
  idiomatic, typed zod schemas. Conformance work that can only succeed by
  emitting un-idiomatic types (e.g. order-preserving content models instead
  of per-element fields) is out of scope for codegen; fidelity improvements
  go into runtime metadata instead.

---

## License summary

| Source | License | How we use it |
|--------|---------|---------------|
| Curated fixtures | CC0-1.0 | Checked into repo |
| xmlschema examples | MIT | Checked into repo, attribution in THIRD_PARTY_NOTICES.md |
| OASIS UBL 2.4 | OASIS RF on Limited Terms | Checked into repo, attribution in THIRD_PARTY_NOTICES.md |
| W3C XSD test suite | W3C Document License | Git submodule (not redistributed), attribution in THIRD_PARTY_NOTICES.md |
