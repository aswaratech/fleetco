import { bsToIsoDate } from "@fleetco/shared";

import { type DocumentExtraction } from "./vision-extractor";

// The pure extraction → proposal-material mapping (ADR-0044 c5, ticket V6).
// No LLM, no I/O: given a DocumentExtraction, produce (a) the ISO/AD date the
// structured record stores (converting a printed Bikram Sambat date via the
// shared calendar competence, ADR-0031/0032), (b) the candidate create tool
// and its ready fields, and (c) honest notes about what could not be mapped.
// V7 embeds this in the extraction block it injects into the turn, anchoring
// the model's field-by-field proposal; the model still asks the user for
// anything missing (the P1 rule) and the write fires only on the confirming
// next turn, through the existing create tools.

export interface ExtractionMapping {
  /** The candidate create tool, or null when no single tool fits
   * (identity documents propose vehicle/driver registration conversationally;
   * "other" proposes nothing). */
  candidateTool: "create_fuel_log" | "create_expense_log" | null;
  /** Ready candidate args for the tool — only fields the extraction actually
   * carried; ids (vehicleId, tripId) are NEVER here (the never-guess-ids rule:
   * the model resolves them with list tools or asks the user). */
  candidateArgs: Record<string, string | number>;
  /** The document date as ISO/AD, BS-converted when flagged BS. Null when
   * absent or unconvertible. */
  isoDate: string | null;
  /** Human-readable mapping caveats for the proposal ("BS date converted",
   * "date not convertible — ask the user", …). */
  notes: string[];
}

export function mapExtraction(extraction: DocumentExtraction): ExtractionMapping {
  const notes: string[] = [];

  let isoDate: string | null = null;
  if (extraction.date !== null) {
    if (extraction.dateCalendar === "BS") {
      isoDate = bsToIsoDate(extraction.date);
      notes.push(
        isoDate !== null
          ? `Printed BS date ${extraction.date} converted to AD ${isoDate}.`
          : `Printed BS date ${extraction.date} could not be converted — confirm the date with the user.`,
      );
    } else {
      // AD, or unflagged: accept only a well-formed ISO day.
      isoDate = /^\d{4}-\d{2}-\d{2}$/.test(extraction.date) ? extraction.date : null;
      if (isoDate === null) {
        notes.push(
          `Printed date "${extraction.date}" is not a usable ISO day — confirm with the user.`,
        );
      }
    }
  }

  const args: Record<string, string | number> = {};
  let candidateTool: ExtractionMapping["candidateTool"] = null;

  switch (extraction.documentType) {
    case "fuel_receipt": {
      candidateTool = "create_fuel_log";
      if (isoDate !== null) args.date = isoDate;
      if (extraction.litersMl !== null) args.litersMl = extraction.litersMl;
      if (extraction.pricePerLiterPaisa !== null) {
        args.pricePerLiterPaisa = extraction.pricePerLiterPaisa;
      }
      if (extraction.vendor !== null) args.station = extraction.vendor;
      if (extraction.receiptNumber !== null) args.receiptNumber = extraction.receiptNumber;
      notes.push("vehicleId is required and never guessed — resolve it or ask the user.");
      break;
    }
    case "expense_receipt":
    case "vendor_bill": {
      candidateTool = "create_expense_log";
      if (isoDate !== null) args.date = isoDate;
      if (extraction.amountPaisa !== null) args.amountPaisa = extraction.amountPaisa;
      if (extraction.vendor !== null) args.vendor = extraction.vendor;
      if (extraction.receiptNumber !== null) args.receiptNumber = extraction.receiptNumber;
      notes.push(
        "category is required (MAINTENANCE/REPAIR/TOLL/PARKING/INSURANCE/PERMIT/FINE/OTHER) — infer it or ask.",
      );
      break;
    }
    case "identity_document": {
      // Box A: extracted locally; the model proposes create_driver /
      // create_vehicle conversationally from these fields — no single
      // candidate tool because the document class does not decide which.
      notes.push(
        "Identity document: propose the matching registration (driver license → create_driver; Bluebook → create_vehicle) from the extracted fields and ask for everything missing.",
      );
      break;
    }
    case "other":
      notes.push(
        "Unrecognized document — summarize the transcription and ask the user what to record.",
      );
      break;
  }

  return { candidateTool, candidateArgs: args, isoDate, notes };
}
