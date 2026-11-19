# Usability review log

One entry per review, newest first. Record the generator version, the commit
reviewed, the fixtures exercised, the friction found, and links to filed
issues. "No findings" is a valid entry.

The process lives in `.agents/skills/usability-review/SKILL.md`. `npm run
usability` regenerates the fixtures and typechecks the consumer snippets; the
judgement part is the review itself.

## Template

```md
## YYYY-MM-DD — <short title>

- Generator: xsd-to-zod@<version>
- Commit: <sha>
- Fixtures: simple, inherited-choices
- Findings:
  - ...
- Issues: <full URLs>
- Verdict: release-blocking | paper cuts | no findings
```

## 2026-11-18 — baseline

- Generator: xsd-to-zod@1.0.1
- Commit: initial usability-review scaffold
- Fixtures: simple, inherited-choices
- Findings:
  - The inherited-choice fixture reproduces the hybrid repeated-choice shape
    observed in the ISO 23387 probe: base choices stay flat while extension
    choices become `choice` / `choice2`.
  - Synthetic choice field names carry no branch information.
  - Structured dates add authoring friction; string mode is simpler for an
    editor.
  - A complex simpleContent `xsi:type` on a simple-typed slot loses its
    attributes on round-trip.
- Issues:
  - https://github.com/PaulDebus/xsd-to-zod/issues/353
  - https://github.com/PaulDebus/xsd-to-zod/issues/354
  - https://github.com/PaulDebus/xsd-to-zod/issues/355
  - https://github.com/PaulDebus/xsd-to-zod/issues/356
  - https://github.com/PaulDebus/xsd-to-zod/issues/357
- Verdict: paper cuts plus one shape-stability issue; the next review should
  check whether #353 changed the fixture shape.
