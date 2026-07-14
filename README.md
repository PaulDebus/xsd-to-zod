# xsd2zod

TypeScript toolkit for XSD → Zod code generation with metadata-driven XML parsing/serialization.

## API

- `parseXsd(files: string[]) => XsdIr`
- `irToZod(ir: XsdIr) => { schemas: string; metadata: string }`
- `createRootHelpers(metadata) => { parseXml, serializeXml }`
- `runPostGenerationFormatting(generatedFiles, cwd?)`