import { describe, expect, test, vi } from "vitest";

import { bsToIsoDate } from "@fleetco/shared";

import { visionExtractorFactory } from "../src/modules/agent/agent.module";
import { MockLlmClient } from "../src/modules/agent/mock-llm.client";
import { mapExtraction } from "../src/modules/agent/vision/extraction-mapping";
import { LocalOcrExtractor } from "../src/modules/agent/vision/local-ocr.extractor";
import { MockVisionExtractor } from "../src/modules/agent/vision/mock.vision-extractor";
import {
  DocumentExtractionSchema,
  VisionExtractionError,
  type DocumentExtraction,
} from "../src/modules/agent/vision/vision-extractor";

// The V6 vision seam (ADR-0044 c5/c6/Box B), PURE — no network, no DB. The
// sidecar is a fake fetch; stage 2 rides MockLlmClient's result queue. The
// live path is exercised end-to-end by the V7 photo eval on the real stack.

function extraction(overrides: Partial<DocumentExtraction> = {}): DocumentExtraction {
  return DocumentExtractionSchema.parse({
    documentType: "other",
    date: null,
    dateCalendar: null,
    vendor: null,
    litersMl: null,
    pricePerLiterPaisa: null,
    amountPaisa: null,
    category: null,
    receiptNumber: null,
    personName: null,
    licenseNumber: null,
    dateOfBirth: null,
    registrationNumber: null,
    rawText: "",
    ...overrides,
  });
}

function llmReply(content: string): {
  message: { role: "assistant"; content: string };
  finishReason: "stop";
} {
  return { message: { role: "assistant", content }, finishReason: "stop" };
}

describe("bsToIsoDate (shared, ADR-0031/0032 — first V6 consumer)", () => {
  test("converts BS new year 2080-01-01 to AD 2023-04-14, any delimiter", () => {
    expect(bsToIsoDate("2080-01-01")).toBe("2023-04-14");
    expect(bsToIsoDate("2080/01/01")).toBe("2023-04-14");
    expect(bsToIsoDate("2080 1 1")).toBe("2023-04-14");
  });

  test("rejects malformed or out-of-table input with null, never throwing", () => {
    expect(bsToIsoDate("not a date")).toBeNull();
    expect(bsToIsoDate("9999-01-01")).toBeNull();
    expect(bsToIsoDate(null)).toBeNull();
  });
});

describe("mapExtraction (pure extraction → proposal material)", () => {
  test("fuel receipt with a BS date maps to create_fuel_log with the AD-converted date", () => {
    const mapping = mapExtraction(
      extraction({
        documentType: "fuel_receipt",
        date: "2080-01-01",
        dateCalendar: "BS",
        vendor: "Sajha Petrol Pump",
        litersMl: 45_500,
        pricePerLiterPaisa: 16_550,
        receiptNumber: "RC-1234",
      }),
    );
    expect(mapping.candidateTool).toBe("create_fuel_log");
    expect(mapping.isoDate).toBe("2023-04-14");
    expect(mapping.candidateArgs).toEqual({
      date: "2023-04-14",
      litersMl: 45_500,
      pricePerLiterPaisa: 16_550,
      station: "Sajha Petrol Pump",
      receiptNumber: "RC-1234",
    });
    expect(mapping.notes.join(" ")).toContain("converted to AD 2023-04-14");
    // The never-guess-ids rule survives the mapping: no vehicleId candidate.
    expect("vehicleId" in mapping.candidateArgs).toBe(false);
  });

  test("an unconvertible BS date degrades to a note, not a throw", () => {
    const mapping = mapExtraction(
      extraction({ documentType: "fuel_receipt", date: "9999-13-45", dateCalendar: "BS" }),
    );
    expect(mapping.isoDate).toBeNull();
    expect(mapping.candidateArgs.date).toBeUndefined();
    expect(mapping.notes.join(" ")).toContain("could not be converted");
  });

  test("vendor bill maps to create_expense_log with the amount authoritative", () => {
    const mapping = mapExtraction(
      extraction({
        documentType: "vendor_bill",
        date: "2026-07-01",
        dateCalendar: "AD",
        vendor: "Shikhar Suppliers",
        amountPaisa: 1_750_000,
      }),
    );
    expect(mapping.candidateTool).toBe("create_expense_log");
    expect(mapping.candidateArgs).toEqual({
      date: "2026-07-01",
      amountPaisa: 1_750_000,
      vendor: "Shikhar Suppliers",
    });
  });

  test("identity documents carry no candidate tool — the proposal is conversational (Box A)", () => {
    const mapping = mapExtraction(
      extraction({
        documentType: "identity_document",
        personName: "Ram Bahadur Shrestha",
        licenseNumber: "03-06-041999",
      }),
    );
    expect(mapping.candidateTool).toBeNull();
    expect(mapping.notes.join(" ")).toContain("create_driver");
  });
});

describe("LocalOcrExtractor (two-stage, fake sidecar + MockLlmClient)", () => {
  const PNG = Buffer.from("89504e47", "hex");
  const GOOD_JSON = JSON.stringify({
    documentType: "fuel_receipt",
    date: "2082-03-21",
    dateCalendar: "BS",
    vendor: "Sajha",
    litersMl: 40_000,
    pricePerLiterPaisa: 16_500,
    amountPaisa: 660_000,
    category: null,
    receiptNumber: "A-99",
    personName: null,
    licenseNumber: null,
    dateOfBirth: null,
    registrationNumber: null,
    rawText: "ignored — the extractor injects stage 1's transcription",
  });

  function fakeSidecar(reply: string, status = 200) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(
        status === 200
          ? JSON.stringify({ choices: [{ message: { content: reply } }] })
          : "upstream error body that must never surface",
        { status },
      );
    });
    return { calls, impl: impl as unknown as typeof fetch };
  }

  test("stage 1 posts the data URI to the sidecar; stage 2 structures via the LLM; rawText is stage 1's", async () => {
    const sidecar = fakeSidecar("सझा पेट्रोल पम्प — RC A-99 — ४० लिटर");
    const llm = new MockLlmClient({ results: [llmReply(GOOD_JSON)] });
    const extractor = new LocalOcrExtractor(llm, {
      url: "http://sidecar.local/v1",
      model: "test-ocr",
      fetchImpl: sidecar.impl,
    });

    const result = await extractor.extractDocument({ bytes: PNG, contentType: "image/png" });

    expect(sidecar.calls).toHaveLength(1);
    expect(sidecar.calls[0]?.url).toBe("http://sidecar.local/v1/chat/completions");
    const content = (sidecar.calls[0]?.body.messages as { content: unknown[] }[])[0]?.content as {
      type: string;
      image_url?: { url: string };
    }[];
    expect(content[1]?.image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.documentType).toBe("fuel_receipt");
    expect(result.litersMl).toBe(40_000);
    // Stage 1's transcription wins the rawText slot, whatever stage 2 echoed.
    expect(result.rawText).toContain("पेट्रोल");
  });

  test("a non-JSON structuring reply gets ONE repair retry, then parses", async () => {
    const sidecar = fakeSidecar("some receipt text");
    const llm = new MockLlmClient({
      results: [llmReply("Sure! Here is the extraction you asked for."), llmReply(GOOD_JSON)],
    });
    const extractor = new LocalOcrExtractor(llm, {
      url: "http://sidecar.local/v1",
      model: "test-ocr",
      fetchImpl: sidecar.impl,
    });
    const result = await extractor.extractDocument({ bytes: PNG, contentType: "image/png" });
    expect(result.documentType).toBe("fuel_receipt");
  });

  test("a sidecar HTTP failure surfaces as a bare category — never the body", async () => {
    const sidecar = fakeSidecar("", 500);
    const llm = new MockLlmClient({ results: [] });
    const extractor = new LocalOcrExtractor(llm, {
      url: "http://sidecar.local/v1",
      model: "test-ocr",
      fetchImpl: sidecar.impl,
    });
    const error = await extractor
      .extractDocument({ bytes: PNG, contentType: "image/png" })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(VisionExtractionError);
    expect((error as VisionExtractionError).message).toContain("ocr_http_500");
    expect((error as VisionExtractionError).message).not.toContain("upstream error body");
  });
});

describe("MockVisionExtractor + the factory (the kill-switch semantics)", () => {
  test("unconfigured mock rejects rather than fabricating an extraction", async () => {
    const mock = new MockVisionExtractor();
    expect(mock.configured).toBe(false);
    await expect(
      mock.extractDocument({ bytes: Buffer.from("x"), contentType: "image/png" }),
    ).rejects.toBeInstanceOf(VisionExtractionError);
  });

  test("a configured mock serves its result queue and records requests", async () => {
    const canned = extraction({ documentType: "fuel_receipt", litersMl: 1_000 });
    const mock = new MockVisionExtractor({ configured: true, results: [canned] });
    const result = await mock.extractDocument({
      bytes: Buffer.from("abc"),
      contentType: "image/jpeg",
    });
    expect(result.litersMl).toBe(1_000);
    expect(mock.requests).toEqual([{ bytesLength: 3, contentType: "image/jpeg" }]);
  });

  test("visionExtractorFactory: URL set → configured local extractor; unset → unconfigured mock", () => {
    const llm = new MockLlmClient({ results: [] });
    expect(visionExtractorFactory("http://x/v1", "m", llm)).toBeInstanceOf(LocalOcrExtractor);
    expect(visionExtractorFactory("http://x/v1", "m", llm).configured).toBe(true);
    expect(visionExtractorFactory(undefined, "m", llm)).toBeInstanceOf(MockVisionExtractor);
    expect(visionExtractorFactory(undefined, "m", llm).configured).toBe(false);
    expect(visionExtractorFactory("", "m", llm).configured).toBe(false);
  });
});
