import { beforeEach, describe, expect, it, vi } from "vitest";
import type { W3cInvalidSchemaCase } from "./w3cDriver.js";

vi.mock("../src/index.js", () => ({
  parseXsd: vi.fn(),
  readXmlFile: vi.fn(() => '<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"/>'),
}));

vi.mock("../src/validate.js", () => ({
  validateSchema: vi.fn(),
}));

import { parseXsd } from "../src/index.js";
import { validateSchema } from "../src/validate.js";
import { evaluateInvalidSchemaCase } from "./w3cSchemaValidity.js";

const CASE: W3cInvalidSchemaCase = {
  name: "groupA",
  testSet: "testSet.xml",
  xsdFiles: ["testdata/curated/imports/include.xsd"],
  specRefs: [],
};

const codegen = vi.mocked(parseXsd);
const libxml = vi.mocked(validateSchema);

const codegenRejects = (): void => {
  codegen.mockRejectedValue(new Error("invalid schema"));
};

const codegenAccepts = (): void => {
  codegen.mockResolvedValue(undefined as unknown as Awaited<ReturnType<typeof parseXsd>>);
};

const libxmlRejects = (): void => {
  libxml.mockResolvedValue({ valid: false, issues: [] });
};

const libxmlAccepts = (): void => {
  libxml.mockResolvedValue({ valid: true });
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("evaluateInvalidSchemaCase", () => {
  it("passes as rejected when both tiers reject", async () => {
    libxmlRejects();
    codegenRejects();
    await expect(evaluateInvalidSchemaCase(CASE)).resolves.toBe("rejected");
  });

  it("records leniency when the zod tier accepts and libxml2 rejects", async () => {
    libxmlRejects();
    codegenAccepts();
    await expect(evaluateInvalidSchemaCase(CASE)).resolves.toBe("lenient");
  });

  it("passes as rejected when libxml2 accepts but the zod tier rejects", async () => {
    libxmlAccepts();
    codegenRejects();
    await expect(evaluateInvalidSchemaCase(CASE)).resolves.toBe("rejected");
  });

  it("flags an anomaly only when both tiers accept", async () => {
    libxmlAccepts();
    codegenAccepts();
    await expect(evaluateInvalidSchemaCase(CASE)).resolves.toBe("anomaly");
  });
});
