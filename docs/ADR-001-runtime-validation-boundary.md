# ADR-001: Runtime and validation boundary

- **Status:** Accepted (pre-1.0); shared checker implemented in `src/identityCheck.ts`
- **Date:** 2026-11-02
- **Related:** #340 (standalone target), #341 (types target), #342 (compiler
  split), `docs/1.0-output-defaults.md`, `docs/MIGRATION.md`

## Context

The compiler split established two entry points: the root runtime and
`xsd-to-zod/compiler`. The standalone target showed a remaining coupling: the
identity-constraint pass is data-shape validation living inside the XML runtime.
As a result, standalone output silently dropped `xs:key`, `xs:unique`, and
`xs:keyref`.

The same question applies to other checks. Before 1.0 freezes the generated
schema and runtime API, we need a stable boundary between:

- what is true of the **data shape**, and
- what is true of the **XML representation**.

## Decision

Split responsibilities as follows:

| Layer | Owns |
|---|---|
| Compiler (`xsd-to-zod/compiler`) | XSD → IR → codegen; no XML runtime |
| Generated schema + types | Data model |
| Shared validation module | Pure data-shape checks over the data + generated descriptors: choice exclusivity, identity constraints, value-expressible facets |
| Runtime (`xsd-to-zod`) | XML ↔ data; calls shared checks where appropriate; representation checks: lexicals, namespaces, tag matching, document order, mixed-content interleaving, `xsi:type`, element defaults, serialization |
| Standalone output | Generated schema + shared checks; no XML metadata, no `xsd-to-zod` import |
| Types output | Types only; no checks, no runtime |

The generated schema is the **data contract**. The runtime is the **XML
adapter**, not a second data validator.

The shared validation module is the seam: both the schema and the runtime use
the same pure checks. The default runtime keeps its `identityConstraints: false`
opt-out; that is why the checks must remain callable/skippable rather than being
unconditionally embedded in `.parse`.

Standalone diagnostics are **warnings, not hard errors**. When a schema uses a
feature the standalone target cannot enforce, generation names the feature and
points at the default runtime-backed output. Users decide whether the narrower
target is acceptable; the tool does not silently drop a check and does not
refuse to generate.

## Non-goals

- Do not move XML-representation checks (lexicals, namespaces, order, mixed
  content, `xsi:type` spelling) into the generated schema. That would require
  carrying an XML tree and recreate the current coupling.
- Do not inline the whole runtime into standalone output.
- Do not keep a second implementation of choice or identity validation.
- Do not change default `parseXml` / `serializeXml` results as part of this
  refactor. A behavior change there is a bug, not the intent.

## User impact

- **Default runtime users:** no API or behavior change. `parseXml`,
  `serializeXml`, and `xmlRegistry` stay. `identityConstraints: false` still
  works. The root entry no longer pulls in Node-only dependencies.
- **Standalone users:** identity constraints are enforced when they are
  data-shape constraints. The generated module uses the shared checker with a
  data-shape value fallback; QName/lexical provenance is unavailable, so those
  comparisons can differ from the XML runtime. XML I/O remains unavailable.
  Users decide whether the narrower target is acceptable.
- **Programmatic compiler users:** import from `xsd-to-zod/compiler`.
- **Generated-code users:** regenerate. Default output should stay
  behaviorally equivalent; standalone output gains identity validation.
- **Types users:** new future target with no runtime dependency.
- **Error-message consumers:** standalone identity errors are new and need a
  documented path/message contract. Default runtime errors stay stable.

## Sequencing

1. Compiler split: #342.
2. Standalone target: #340, initially with an explicit identity warning while
   the checker was still runtime-only.
3. Refactor: `src/schemaUtils.ts` holds the pure zod-schema helpers;
   `src/identityCheck.ts` is the shared data-shape engine. The runtime supplies
   parsed-tree provenance; standalone supplies a data-shape fallback and a
   generated meta map.
4. Standalone identity is enforced; the temporary identity warning is removed.
5. Ergonomic output flip and the 1.0 release gate.

## Open questions

- Which identity constraints are purely data-shape, and which still need XML
  provenance (expanded QNames, lexical exactness, `xsi:type`, nil attributes)?
  Those that need provenance must stay runtime-only and warn in standalone.
- How should `identityConstraints: false` interact with the shared checker in
  each target?
- Does `xmlRegistry` keep identity metadata for inspection/compatibility, or
  does the runtime read generated descriptors instead?
- How do standalone identity error paths and messages relate to the runtime
  ones?
- Does the types target (#341) share the same descriptor/type allocation path?
