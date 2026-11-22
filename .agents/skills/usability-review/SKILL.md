---
name: usability-review
description: Review whether generated xsd-to-zod output is usable for application authors. Use before a release, on a schedule, or after changing the output shape. Regenerates the usability fixtures, typechecks the consumer snippets, compares shapes to the last review, and files issues for new friction.
---

Review the **usability** of the generated output, not XSD conformance. The W3C
corpus proves correctness; this review asks whether a person building an
application can use the generated types without contortions.

Read-only for generated code. File issues instead of patching output during a
review.

## Inputs

- `docs/usability/LOG.md` — the last reviewed commit, version, and findings.
- `testdata/usability/` — the fixed schema set.
- `testdata/usability/consumers/` — snippets that perform real authoring tasks.
- `tests/usability-shapes.test.ts` — the generated-shape snapshot guard.
- `tests/consumer-contract.test.ts` — fixture drift, consumer typecheck,
  domain-model round-trip, and shape-stability contract. Runs in the normal
  suite and the release gate; a failure is a finding.

## Process

### 1. Establish the baseline

Read the newest entry in `docs/usability/LOG.md`. Record the last reviewed
commit and generator version. If there is no entry, review the whole fixture
set.

### 2. Find what changed

Review only what can affect usability since the baseline:

```sh
git log --oneline <last>..HEAD
git diff <last>..HEAD -- src/irToZod.ts src/runtime.ts tests/ergonomic.test.ts README.md docs/
```

If nothing relevant changed and this is not a release review, say so and stop.
Do not re-review the same output for the sake of it.

### 3. Run the mechanical checks

```sh
npm run usability
```

This regenerates `testdata/usability/generated/` and typechecks the consumer
snippets. A failure is a finding. The same checks run automatically in
`tests/consumer-contract.test.ts`, including the domain-model round-trip and
the unrelated-type stability assertion, so a red release gate is the first
signal. Also read the diff in
`tests/__snapshots__/usability-shapes.test.ts.snap` when the fixture output
changed.

### 4. Exercise the authoring tasks

Use the generated modules and consumer snippets. Judge each task as **easy**,
**awkward**, or **impossible**, and quote the code that shows why:

- Build a valid document by hand.
- Read an optional field, a repeated field, and a choice branch.
- Add, remove, and reorder a repeated-choice item.
- Construct a datatype with constraints (`MinInclusive`, `DataFormat`, ...).
- Read and write attributes, value wrappers, and dates.
- Import the generated types without casts or `any`.
- Parse XML, serialize it back, and re-parse.

Call out shape instability: if an unrelated schema edit changes an existing
type, that is a finding even when the new shape is convenient.

### 5. Check the docs against the output

The README and `docs/1.0-output-defaults.md` must describe what the generator
actually emits: eligibility rules, synthetic `choice` / `choiceN` names,
attribute key stripping, and date modes. A mismatch is a finding.

### 6. Search, then file

Search existing issues before filing:

```sh
gh issue list --state open --search "<keyword>"
```

File new issues with the `usability` label and the relevant area label
(`area: codegen`, `area: runtime`, `needs-design`). Link related issues. Do not
re-file known friction; add a comment with new evidence instead.

Issue types:

- `bug` — wrong output, silent loss, broken round-trip.
- `usability` — avoidable friction, naming, authoring cost.
- `documentation` — docs do not match the emitted shape.
- no action — record it in the log only.

### 7. Update the log and report

Prepend a dated entry to `docs/usability/LOG.md`:

- date, generator version, reviewed commit
- fixtures exercised
- findings (easy / awkward / impossible)
- filed or updated issues (full URLs)
- verdict: release-blocking, paper cuts, or no findings

Post a short summary in the review thread. If a finding should block a
release, say so and apply `release-blocker`.

## Notes

- Prefer concrete snippets over adjectives. "Adding a `HasPropertyRef` needs
  three spreads and a cast" is a finding; "the API feels awkward" is not.
- Keep the fixture set small. Add a fixture only when it exercises a shape the
  current set cannot.
- Do not add tracker ids to code, test names, or generated output. Issue links
  belong in this skill's log and in GitHub.
