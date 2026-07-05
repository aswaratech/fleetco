import {
  VisionExtractionError,
  VisionExtractor,
  type DocumentExtraction,
  type ExtractDocumentInput,
} from "./vision-extractor";

/**
 * The no-network VisionExtractor (the MockLlmClient/MockObjectStorage
 * counterpart, ADR-0044 V6). Two roles:
 *
 *   1. The dev/test/CI default the module wires when AGENT_OCR_URL is unset —
 *      and, deliberately, the production KILL-SWITCH state: `configured`
 *      defaults to FALSE, so the turn loop degrades an attachment to the
 *      honest "extraction is not configured" notice instead of fabricating
 *      an extraction.
 *   2. A test double: construct with `configured: true` and a result QUEUE
 *      (the MockLlmClient shape) to drive the V7 extract→propose→confirm
 *      loop tests; every call is recorded in {@link requests}.
 */
export class MockVisionExtractor extends VisionExtractor {
  readonly configured: boolean;

  /** Every extractDocument call, in order: byte length + sniffed type. */
  readonly requests: { bytesLength: number; contentType: string }[] = [];

  private readonly results: DocumentExtraction[];

  constructor(behavior: { configured?: boolean; results?: DocumentExtraction[] } = {}) {
    super();
    this.configured = behavior.configured ?? false;
    this.results = [...(behavior.results ?? [])];
  }

  extractDocument(input: ExtractDocumentInput): Promise<DocumentExtraction> {
    this.requests.push({ bytesLength: input.bytes.length, contentType: input.contentType });
    const next = this.results.shift();
    if (next === undefined) {
      // An unconfigured (or exhausted) mock never invents an extraction.
      return Promise.reject(new VisionExtractionError("mock_unconfigured"));
    }
    return Promise.resolve(next);
  }
}
