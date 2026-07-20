// Typed error for xsd-to-zod diagnostics (#84): a machine-readable `code` plus
// optional source-file context, so the CLI can print clean one-line errors
// instead of bare generic Errors.
export class Xsd2ZodError extends Error {
  readonly code: string;
  readonly file?: string;

  constructor(code: string, message: string, options?: { file?: string }) {
    super(message);
    this.name = 'Xsd2ZodError';
    this.code = code;
    this.file = options?.file;
  }
}
