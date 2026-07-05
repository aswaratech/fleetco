import { z } from "zod";

// The document-extraction seam (ADR-0044 c5/c6, ticket V6) — the vision
// counterpart of LlmClient: an abstract class doubling as the DI token, with
// exactly one method, so the agent's turn loop depends on a contract and the
// OCR stack lives behind one implementation file.
//
// TWO-STAGE BY DESIGN (Box B, resolved self-hosted): stage 1 transcribes the
// image on the LOCAL OCR sidecar (pixels never leave FleetCo infrastructure);
// stage 2 structures that transcription into the typed DocumentExtraction via
// the existing text LlmClient. NEITHER stage carries the tool registry — text
// inside an image can never reach a tool-calling context (ADR-0044 c6, the
// structural prompt-injection firewall); whatever a document says, the only
// thing it can become is a typed field in a proposal the user reads.

/** What one attachment yields. Parsed leniently (`.catch`) because stage 2's
 * output is model text: a malformed field degrades to null rather than
 * failing the extraction — the user corrects conversationally (ADR-0044 c7).
 * Money integer paisa, volume integer milliliters (house units); `date` is
 * AS PRINTED with its calendar flagged (the mapping converts BS → ISO/AD). */
export const DocumentExtractionSchema = z
  .object({
    documentType: z
      .enum(["fuel_receipt", "expense_receipt", "vendor_bill", "identity_document", "other"])
      .catch("other"),
    date: z.string().max(32).nullable().catch(null),
    dateCalendar: z.enum(["AD", "BS"]).nullable().catch(null),
    vendor: z.string().max(256).nullable().catch(null),
    litersMl: z.number().int().min(1).max(1_000_000_000).nullable().catch(null),
    pricePerLiterPaisa: z.number().int().min(1).max(10_000_000).nullable().catch(null),
    amountPaisa: z.number().int().min(1).max(10_000_000_000).nullable().catch(null),
    category: z.string().max(64).nullable().catch(null),
    receiptNumber: z.string().max(64).nullable().catch(null),
    // Identity-document fields (ADR-0044 Box A, INCLUDED under local-only
    // processing): extracted locally; they enter the conversation only inside
    // the proposal the user confirms — the dictated-entry equivalence.
    personName: z.string().max(128).nullable().catch(null),
    licenseNumber: z.string().max(64).nullable().catch(null),
    dateOfBirth: z.string().max(32).nullable().catch(null),
    registrationNumber: z.string().max(64).nullable().catch(null),
    /** Stage 1's transcription, bounded — Tier 2 (it is document content). */
    rawText: z.string().max(2_000).catch(""),
  })
  .strict();

export type DocumentExtraction = z.infer<typeof DocumentExtractionSchema>;

/** The bytes handed to an extractor — exactly what the attachment row stores. */
export interface ExtractDocumentInput {
  bytes: Buffer;
  contentType: string;
}

/**
 * The extractor port. `configured` mirrors ObjectStorage.isConfigured's
 * honesty contract: the mock reports false so an unconfigured deployment's
 * attachment turns degrade to a plain notice instead of fabricating an
 * extraction (AGENT_OCR_URL unset = the feature's kill switch).
 */
export abstract class VisionExtractor {
  abstract readonly configured: boolean;

  abstract extractDocument(
    input: ExtractDocumentInput,
    opts?: { signal?: AbortSignal },
  ): Promise<DocumentExtraction>;
}

/**
 * Extraction failures carry ONLY a bare, PII-free category (the LlmCallError
 * posture): "ocr_http_500", "ocr_timeout", "structuring_parse", … — never
 * response bodies (a body can echo document content).
 */
export class VisionExtractionError extends Error {
  constructor(
    readonly category: string,
    options?: { cause?: unknown },
  ) {
    super(`Document extraction failed (${category}).`, options);
    this.name = "VisionExtractionError";
  }
}
