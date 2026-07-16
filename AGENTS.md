# xsd2zod — Agent guide

Convert XSD schemas into typed Zod parsers for XML, with a metadata-driven runtime (`parseXml` / `serializeXml`).

- **Branching**: all PRs must branch from `origin/main` into a new branch. No direct pushes to `main`.
- **Style**: be concise. Prefer short, focused edits over verbose explanations.
- **Testing**: all PRs must pass the full testsuite before they can be submitted for review
- Dont amend commits unless it is not pushed and the change was missing from it. commits show the progress

## Coding standards
- **Strict TypeScript**: `strict: true` in tsconfig. No `any`, no `// @ts-{ignore,expect-error}` — fix the types properly.
