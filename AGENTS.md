# xsd2zod — Agent guide

Convert XSD schemas into typed Zod parsers for XML. One generated `.zod.ts`
carries its XML knowledge in `xmlRegistry` (zod 4 metadata registry); the
runtime (`parseXml` / `safeParseXml` / `serializeXml`) walks the schemas —
there is no separate metadata artifact. Full XSD conformance lives in the
optional libxml2 tier (`xsd2zod/validate`, optional `libxml2-wasm` peer dep).

- **Branching**: all PRs must branch from `origin/main` into a new branch. No direct pushes to `main`.
- **Style**: be concise. Prefer short, focused edits over verbose explanations.
- **Testing**: all PRs must pass the full testsuite before they can be submitted for review, including test coverage check
- Dont amend commits unless it is not pushed and the change was missing from it. commits show the progress

## Coding standards
- **Strict TypeScript**: `strict: true` in tsconfig. No `any`, no `// @ts-{ignore,expect-error}` — fix the types properly.
