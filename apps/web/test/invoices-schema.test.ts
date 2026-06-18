import { describe, expect, test } from "vitest";

import {
  BuildFromJobFormSchema,
  CreateInvoiceFormSchema,
  CreateLineFormSchema,
  rupeesStringToPaisa,
} from "../src/lib/invoices-schema";

/**
 * Pins the Invoices form schemas + the rupees→paisa converter (D6 / ADR-0039).
 * The API is authoritative (it re-validates every body and owns the integer-paisa
 * bounds); these lock the client mirror so an operator gets inline feedback that
 * matches what the API accepts, and so the money converter stays half-up integer
 * paisa (anti-pattern #14, never a float on the wire).
 */
describe("rupeesStringToPaisa", () => {
  test("whole rupees → paisa (×100)", () => {
    expect(rupeesStringToPaisa("1500")).toBe(150_000);
  });
  test("two-decimal rupees → paisa", () => {
    expect(rupeesStringToPaisa("1500.50")).toBe(150_050);
  });
  test("one paisa", () => {
    expect(rupeesStringToPaisa("0.01")).toBe(1);
  });
  test("zero", () => {
    expect(rupeesStringToPaisa("0")).toBe(0);
  });
});

describe("CreateInvoiceFormSchema", () => {
  test("requires a customer", () => {
    const r = CreateInvoiceFormSchema.safeParse({ customerId: "" });
    expect(r.success).toBe(false);
  });
  test("accepts a customer with everything else unset", () => {
    const r = CreateInvoiceFormSchema.safeParse({ customerId: "c1" });
    expect(r.success).toBe(true);
  });
  test("accepts an optional service type + discount", () => {
    const r = CreateInvoiceFormSchema.safeParse({
      customerId: "c1",
      serviceType: "VEHICLE_HIRE",
      discount: "1000.00",
    });
    expect(r.success).toBe(true);
  });
  test("accepts an empty service type + empty discount (unset)", () => {
    const r = CreateInvoiceFormSchema.safeParse({
      customerId: "c1",
      serviceType: "",
      discount: "",
    });
    expect(r.success).toBe(true);
  });
  test("rejects a non-numeric discount", () => {
    const r = CreateInvoiceFormSchema.safeParse({ customerId: "c1", discount: "lots" });
    expect(r.success).toBe(false);
  });
  test("rejects an unknown service type", () => {
    const r = CreateInvoiceFormSchema.safeParse({ customerId: "c1", serviceType: "AIR_FREIGHT" });
    expect(r.success).toBe(false);
  });
});

describe("CreateLineFormSchema", () => {
  test("accepts a valid manual line", () => {
    const r = CreateLineFormSchema.safeParse({
      description: "Mobilization fee",
      quantity: "1",
      unitPrice: "5000.00",
    });
    expect(r.success).toBe(true);
  });
  test("rejects a blank description", () => {
    const r = CreateLineFormSchema.safeParse({
      description: "  ",
      quantity: "1",
      unitPrice: "5000",
    });
    expect(r.success).toBe(false);
  });
  test("rejects a fractional quantity", () => {
    const r = CreateLineFormSchema.safeParse({
      description: "Haul",
      quantity: "1.5",
      unitPrice: "5000",
    });
    expect(r.success).toBe(false);
  });
  test("rejects a unit price above the int4 line ceiling", () => {
    const r = CreateLineFormSchema.safeParse({
      description: "Haul",
      quantity: "1",
      unitPrice: "21474837", // > NPR 21.47M → > int4 paisa
    });
    expect(r.success).toBe(false);
  });
});

describe("BuildFromJobFormSchema", () => {
  test("accepts a job with at least one trip line", () => {
    const r = BuildFromJobFormSchema.safeParse({
      jobId: "j1",
      lines: [{ tripId: "t1", quantity: "2", unitPrice: "12000.00" }],
    });
    expect(r.success).toBe(true);
  });
  test("rejects an empty line set", () => {
    const r = BuildFromJobFormSchema.safeParse({ jobId: "j1", lines: [] });
    expect(r.success).toBe(false);
  });
  test("rejects a line with no trip picked", () => {
    const r = BuildFromJobFormSchema.safeParse({
      jobId: "j1",
      lines: [{ tripId: "", quantity: "1", unitPrice: "100" }],
    });
    expect(r.success).toBe(false);
  });
});
