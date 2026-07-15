# Test Suite Status

All tests run via `npm test` (single `vitest run` — currently ~8s).

| Category | Tests | Description |
|----------|-------|-------------|
| Curated round-trip | 22 | basic, content-models, cardinality, types, namespaces, imports |
| Upstream round-trip | 17 | xmlschema examples (vehicles, collection), UBL Invoice/Order parsing |
| W3C smoke | 8 | Boeing IPO variants (submodule) |
| Benchmark | 1 | parse all upstream XSDs under 5s |
| Negative | 7 | namespace rejection + graceful handling of lenient validation |
| Pipeline | 21 | xsd2zod.test.ts + cli.test.ts |

## Known gaps (issues for tracking)
- **#8**: `serializeXml` — nested complex types produce `[object Object]`
- **#9**: `irToZod` — no runtime metadata for root elements with primitive/simple types
- **#10**: Generated Zod schemas don't enforce cardinality, order, or unexpected elements
