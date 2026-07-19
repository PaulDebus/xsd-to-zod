// Optional XSD conformance tier, backed by libxml2-wasm. This is the strict
// tier: full XSD semantics (cardinality bounds, order, identity constraints,
// float/double specials, …) that the zod tier deliberately does not promise.
// libxml2-wasm is an optional peer dependency, loaded via dynamic import so
// browser deployments and zod-tier-only consumers never pay for it.

export type XmlValidationIssue = {
  message: string;
  file?: string;
  line?: number;
  column?: number;
};

export type ValidateXmlResult =
  | { valid: true }
  | { valid: false; issues: XmlValidationIssue[] };

export type ValidateXmlOptions = {
  /**
   * Base URL of the schema source (typically its file path). Enables
   * resolution of relative xs:include/xs:import locations — from the
   * filesystem in Node, where the FS input providers are registered
   * automatically on first use.
   */
  url?: string;
};

type Libxml2 = typeof import('libxml2-wasm');

let libxml2Promise: Promise<Libxml2> | null = null;

const loadLibxml2 = (): Promise<Libxml2> => {
  if (libxml2Promise) {
    return libxml2Promise;
  }
  const promise = (async () => {
    let libxml2: Libxml2;
    try {
      libxml2 = await import('libxml2-wasm');
    } catch {
      throw new Error(
        "xsd-to-zod/validate requires the optional peer dependency 'libxml2-wasm'. Install it with: npm install libxml2-wasm"
      );
    }
    // Filesystem input providers let relative xs:include/xs:import resolve
    // against the schema url. Node-only; best-effort everywhere else.
    try {
      const { xmlRegisterFsInputProviders } = await import('libxml2-wasm/lib/nodejs.mjs');
      xmlRegisterFsInputProviders();
    } catch {
      // Non-Node runtime or bundler without the subpath — schemas with
      // relative includes will fail to resolve, single schemas work.
    }
    return libxml2;
  })();
  // Don't cache a failed load (missing peer dep): the next call retries.
  promise.catch(() => {
    if (libxml2Promise === promise) {
      libxml2Promise = null;
    }
  });
  libxml2Promise = promise;
  return promise;
};

const toIssues = (error: unknown): XmlValidationIssue[] => {
  const details = (error as { details?: unknown } | null)?.details;
  if (Array.isArray(details) && details.length > 0) {
    return details.map((detail) => {
      const d = detail as { message?: unknown; file?: unknown; line?: unknown; col?: unknown };
      return {
        message: String(d.message ?? error),
        ...(typeof d.file === 'string' && d.file !== '' ? { file: d.file } : {}),
        ...(typeof d.line === 'number' && d.line > 0 ? { line: d.line } : {}),
        ...(typeof d.col === 'number' && d.col > 0 ? { column: d.col } : {}),
      };
    });
  }
  return [{ message: error instanceof Error ? error.message : String(error) }];
};

/** Format issues for display: `line L, column C: message` (parts omitted when absent). */
export const formatIssues = (issues: XmlValidationIssue[]): string[] =>
  issues.map((issue) => {
    const where =
      issue.line !== undefined
        ? `line ${issue.line}${issue.column !== undefined ? `, column ${issue.column}` : ''}: `
        : '';
    return `${where}${issue.message}`;
  });

/**
 * Validate an XML document against an XSD schema with full conformance
 * semantics (libxml2). Returns a result object; schema *compile* errors and
 * malformed input XML throw instead (they are not instance-invalidity).
 *
 * Typical upload gate: `validateXml` (contract check, line-numbered errors)
 * → `parseXml` (typed data + zod validation).
 */
export const validateXml = async (xml: string, xsd: string, opts?: ValidateXmlOptions): Promise<ValidateXmlResult> => {
  const { XmlDocument, XsdValidator } = await loadLibxml2();

  let xmlDoc: InstanceType<Libxml2['XmlDocument']> | undefined;
  let schemaDoc: InstanceType<Libxml2['XmlDocument']> | undefined;
  let validator: InstanceType<Libxml2['XsdValidator']> | undefined;
  try {
    schemaDoc = opts?.url ? XmlDocument.fromString(xsd, { url: opts.url }) : XmlDocument.fromString(xsd);
    validator = XsdValidator.fromDoc(schemaDoc);
    xmlDoc = XmlDocument.fromString(xml);
    try {
      validator.validate(xmlDoc);
      return { valid: true };
    } catch (error) {
      return { valid: false, issues: toIssues(error) };
    }
  } finally {
    validator?.dispose();
    schemaDoc?.dispose();
    xmlDoc?.dispose();
  }
};
