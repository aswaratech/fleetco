import { z } from "zod";

import { rupeesToPaisa } from "./money";

// Web-side form schemas + form→wire converters for the Invoices write path
// (Program D / D6 / ADR-0039). Mirrors the API's invoices.schemas.ts at the field
// level; the API is authoritative (it re-validates every body and owns the
// integer-paisa bounds), these give the operator immediate inline feedback before
// a round-trip. Duplication-budget rationale matches jobs-schema.ts /
// customers-schema.ts: a shared workspace package is deferred.
//
// MONEY DISCIPLINE (anti-pattern #14). The operator types rupees decimals at the
// form edge (an `<input type="number">` value is a string); these schemas validate
// the string shape and the converters turn it into the integer paisa the wire
// stores via `rupeesToPaisa` (the same half-up `Math.round` rule the API + the
// fuel-log preview use, so a previewed total matches the persisted one
// bit-for-bit). Paisa stay integers everywhere else in code.

const INVOICE_SERVICE_TYPES = ["VEHICLE_HIRE", "GOODS_TRANSPORT"] as const;

// The int4 / money ceilings the API enforces (apps/api invoices.schemas.ts).
// Mirrored here only to give early inline feedback; the API is the authority.
const LINE_MAX_PAISA = 2_147_483_647; // int4 ceiling on a single line money column
const DISCOUNT_MAX_PAISA = 10_000_000_000; // NPR 100M, the header money cap
const DESCRIPTION_MAX = 1000;

// A non-negative rupees decimal string: digits, optionally a 1–2 place fraction.
// "" is handled separately (optional fields). The paisa bound is checked by the
// callers' `.refine` after conversion.
const RUPEES_RE = /^\d+(\.\d{1,2})?$/;

/** Parse a validated rupees string to integer paisa (half-up). */
export function rupeesStringToPaisa(value: string): number {
  return rupeesToPaisa(Number(value));
}

const RequiredRupees = z
  .string()
  .trim()
  .regex(RUPEES_RE, "Enter an amount in NPR, e.g. 1500 or 1500.50.");

const RequiredUnitPrice = RequiredRupees.refine(
  (v) => rupeesStringToPaisa(v) <= LINE_MAX_PAISA,
  "Unit price is too large (max ≈ NPR 21.47M per line).",
);

// Optional rupees field: empty string means "no value". Used for the header
// discount. When present it must parse and stay within the header money cap.
const OptionalDiscount = z
  .string()
  .trim()
  .refine((v) => v === "" || RUPEES_RE.test(v), "Enter an amount in NPR, e.g. 1500 or 1500.50.")
  .refine(
    (v) => v === "" || rupeesStringToPaisa(v) <= DISCOUNT_MAX_PAISA,
    "Discount is too large.",
  );

const QuantityString = z
  .string()
  .trim()
  .regex(/^\d+$/, "Quantity must be a whole number.")
  .refine((v) => Number(v) >= 1 && Number(v) <= LINE_MAX_PAISA, "Quantity must be at least 1.");

const ServiceTypeField = z
  .string()
  .refine(
    (v) => v === "" || (INVOICE_SERVICE_TYPES as readonly string[]).includes(v),
    "Pick a service type.",
  );

const Description = z
  .string()
  .trim()
  .min(1, "Description is required.")
  .max(DESCRIPTION_MAX, "Description is too long (max 1000 characters).");

// ---------------------------------------------------------------------------
// Header: create + edit.
// ---------------------------------------------------------------------------

// Create a DRAFT invoice header. customerId (a picker) is required; serviceType /
// jobId / discount are optional ("" = unset). serviceType is needed BEFORE issue
// (it selects the TDS rate); the form lets it be set now or on the edit page.
export const CreateInvoiceFormSchema = z.object({
  customerId: z.string().min(1, "Pick a customer."),
  jobId: z.string().optional(), // "" = no job
  serviceType: ServiceTypeField.optional(),
  discount: OptionalDiscount.optional(),
});

export type CreateInvoiceFormValues = z.infer<typeof CreateInvoiceFormSchema>;

// Edit a DRAFT header. customerId is intentionally absent — the UI treats an
// invoice's customer as fixed after creation (changing it would orphan any
// job-tagged lines against the old customer); the API technically allows it, the
// edit form does not surface it. Only the tax-affecting fields are editable here.
export const UpdateInvoiceHeaderFormSchema = z.object({
  jobId: z.string().optional(),
  serviceType: ServiceTypeField.optional(),
  discount: OptionalDiscount.optional(),
});

export type UpdateInvoiceHeaderFormValues = z.infer<typeof UpdateInvoiceHeaderFormSchema>;

// ---------------------------------------------------------------------------
// Lines: add / edit one line; build-from-job batch.
// ---------------------------------------------------------------------------

// Add ONE manual line. unitPrice is rupees → paisa in the action; quantity is a
// whole unit count (tonnes / trips / days). lineAmountPaisa is derived server-side.
export const CreateLineFormSchema = z.object({
  description: Description,
  quantity: QuantityString,
  unitPrice: RequiredUnitPrice,
});

export type CreateLineFormValues = z.infer<typeof CreateLineFormSchema>;

// Edit an existing line. Same fields; the API re-derives lineAmountPaisa.
export const UpdateLineFormSchema = CreateLineFormSchema;
export type UpdateLineFormValues = z.infer<typeof UpdateLineFormSchema>;

// One trip line in a build-from-job batch. The operator picks the trip and keys
// the amount (the schema has NO Trip→Job link, so this is operator-selected, not
// a job traversal — see docs/tech-debt.md "Trip is not linked to Job"). The
// description is optional (the API falls back to the job's description, then
// appends the trip's BS date).
export const BuildFromJobLineFormSchema = z.object({
  tripId: z.string().min(1, "Pick a trip."),
  quantity: QuantityString,
  unitPrice: RequiredUnitPrice,
  description: z.string().trim().max(DESCRIPTION_MAX, "Description is too long.").optional(),
});

export type BuildFromJobLineFormValues = z.infer<typeof BuildFromJobLineFormSchema>;

export const BuildFromJobFormSchema = z.object({
  jobId: z.string().min(1, "Pick a job."),
  lines: z.array(BuildFromJobLineFormSchema).min(1, "Add at least one trip line to build."),
});

export type BuildFromJobFormValues = z.infer<typeof BuildFromJobFormSchema>;
