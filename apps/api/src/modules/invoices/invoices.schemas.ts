import { z } from "zod";

// Zod schemas for the Invoices slice (Program D / ADR-0039). D1 shipped the READ
// path (`ListInvoicesQuerySchema`); D3 (this slice) adds the write path —
// `CreateInvoiceSchema` (a DRAFT header) and `UpdateInvoiceSchema` (a partial
// DRAFT edit). Build-from-trips (the LINE assembly) is D4; the PDF/R2 is D5; the
// web surface is D6. The mechanics mirror the Jobs iter-17 → iter-18 staging.
//
// Mirrors apps/api/src/modules/jobs/jobs.schemas.ts and
// apps/api/src/modules/customers/customers.schemas.ts in shape and convention:
// enum lists duplicated from the Prisma enums (so this file does not pull the
// Prisma runtime), `.strict()` on the object so a typo'd query key surfaces as
// HTTP 400, comma-separated multi-value enum filters via `csvEnum`, an `IdFilter`
// for the `customerId` filter, and an explicit pagination ceiling mirrored from
// the service-side LIST_TAKE_MAX constant.

// InvoiceStatus enum — must mirror InvoiceStatus in prisma/schema.prisma. Order
// matches the Prisma enum so an audit grep finds both lists side by side; the
// order has no runtime significance.
const INVOICE_STATUSES = ["DRAFT", "ISSUED", "CANCELLED"] as const;

// DocumentType enum — must mirror DocumentType in prisma/schema.prisma. The
// credit-note discriminator; a CREDIT_NOTE corrects an ISSUED invoice (D3). Read-
// filterable from D1 so the future web surface can show invoices vs credit notes
// separately.
const DOCUMENT_TYPES = ["INVOICE", "CREDIT_NOTE"] as const;

// InvoiceServiceType enum — must mirror InvoiceServiceType in prisma/schema.prisma.
// Selects the applicable TDS rate at issue (D2 calculator); nullable on a DRAFT,
// required at issue. WHICH service maps to WHICH rate is the accountant-verified
// detail the agent must not assume (ADR-0039 c9).
const INVOICE_SERVICE_TYPES = ["VEHICLE_HIRE", "GOODS_TRANSPORT"] as const;

// GET /api/v1/invoices query parameters (D1 — read path).
// Filter / sort / pagination contract mirrors the Jobs and Customers list
// endpoints so the web client's URL-searchParams convention (paginator,
// sortable-header, filter-toolbar idioms) transfers without surprises.
//
// Wire conventions:
//   - `status` accepts a single value (`?status=DRAFT`) or a comma-separated list
//     (`?status=DRAFT,ISSUED`). Normalizes to a deduplicated array; the service
//     builds a Prisma `in:` filter. An empty string after splitting is treated as
//     "no filter". Same shape as Jobs.
//   - `documentType` accepts a single value or comma-separated list, same csvEnum
//     shape as `status`.
//   - `customerId` accepts a single string. We do NOT parse it as a cuid: the
//     iter-8 / iter-15 / iter-17 precedent is "accept any string and let the
//     service no-op" — an unknown id simply yields an empty result set, the right
//     shape for an "invoices for this customer" URL that survives a stale
//     bookmark. Tightening to a cuid format would need an ADR per CLAUDE.md.
//   - `sortBy` is restricted to a whitelist (createdAt / number). The D1 ticket
//     spells this out. Allowing arbitrary columns would invite expensive sorts
//     and accidental information disclosure (e.g. ordering by a frozen money
//     column would leak amount ordering) — the same defense the Jobs schema
//     documents for `sortBy=description`.
//   - `sortDir` defaults to `desc` because "most recent first" is the common case
//     for both `createdAt` and `number`. Consistency across surfaces wins over
//     per-column defaults.
//   - `skip` defaults to 0; `take` defaults to 20. The schema's `take` ceiling
//     mirrors the service's LIST_TAKE_MAX so an over-large `take` surfaces as HTTP
//     400 with a clear message rather than being silently clamped.
const SORTABLE_COLUMNS = ["createdAt", "number"] as const;
export type InvoiceSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type InvoiceSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from invoices.service.ts on purpose: the service
// is the runtime authority (the schema can only validate what the client sent; it
// cannot speak for the database). Both constants must move together when one
// changes; the same coupling the Jobs / Customers schemas document.
const QUERY_MAX_TAKE = 200;

// Helper: turn a single-string-or-comma-separated query value into a validated,
// deduplicated array of enum members. Reused by `status` and `documentType`. An
// empty result (e.g., `?status=`) maps to `undefined` so the service omits the
// filter rather than asking Prisma for `where status in ()` (which would match
// zero rows). Identical in shape to the Jobs / Customers versions; promoting to a
// shared helper stays deferred (the same call the prior read-path slices made).
function csvEnum<T extends readonly [string, ...string[]]>(values: T) {
  const member = z.enum(values);
  return z
    .string()
    .optional()
    .transform((raw, ctx): T[number][] | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const parts = raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0) return undefined;
      const seen = new Set<T[number]>();
      for (const part of parts) {
        const parsed = member.safeParse(part);
        if (!parsed.success) {
          ctx.addIssue({
            code: "custom",
            message: `Must be one of: ${values.join(", ")}.`,
          });
          return z.NEVER;
        }
        seen.add(parsed.data);
      }
      return Array.from(seen);
    });
}

// Coerce a string-typed query param to a non-negative integer with bounds
// checking. Same shape as the Jobs / Customers helpers; out-of-range values
// return 400 with a clear message rather than being silently clamped — a
// deliberate `take=10000` clamped to 200 would surprise an API consumer who
// expected to receive what they asked for.
function intParam(min: number, max: number, fieldLabel: string) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): number | undefined => {
      if (raw === undefined || raw === "") return undefined;
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be an integer.` });
        return z.NEVER;
      }
      if (n < min) {
        ctx.addIssue({ code: "custom", message: `${fieldLabel} must be ${min} or greater.` });
        return z.NEVER;
      }
      if (n > max) {
        ctx.addIssue({
          code: "custom",
          message: `${fieldLabel} must be ${max} or less.`,
        });
        return z.NEVER;
      }
      return n;
    });
}

// `customerId` filter: accept any non-empty string. The service builds a Prisma
// `where customerId = ?` filter; a non-existent id naturally returns the empty
// result set. An empty string (e.g., from `?customerId=`) is normalized to
// undefined so the service omits the filter rather than asking Prisma for `where
// customerId = ''`. Identical to the Jobs `IdFilter`.
const IdFilter = z
  .string()
  .optional()
  .transform((raw) => {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  });

export const ListInvoicesQuerySchema = z
  .object({
    status: csvEnum(INVOICE_STATUSES),
    documentType: csvEnum(DOCUMENT_TYPES),
    customerId: IdFilter,
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  // Strict so a typo'd query key (e.g., `?staus=DRAFT`) surfaces as 400 rather
  // than being silently ignored. Matches the Jobs and Customers contracts.
  .strict();

export type ListInvoicesQuery = z.infer<typeof ListInvoicesQuerySchema>;

// ---------------------------------------------------------------------------
// Write path (D3) — create / update a DRAFT invoice HEADER.
// ---------------------------------------------------------------------------

// Upper bound for a single money field, in integer paisa (CLAUDE.md money-as-
// minor-units). Mirrors the cap the fuel/expense-log schemas use
// (10_000_000_000 paisa = NPR 100M) — a single invoice's discount cannot
// plausibly exceed it, and the bound keeps a fat-fingered value off the wire.
const MONEY_MAX_PAISA = 10_000_000_000;

// Reusable write-path field validators. customerId/jobId accept any non-empty
// trimmed id (not a strict cuid) — the iter-8/15/17 precedent: let the FK be the
// authority and map its P2003 to a clean 400, rather than duplicating cuid format
// rules here (tightening would need an ADR per CLAUDE.md).
const CustomerId = z.string().trim().min(1, "customerId is required.");
const JobId = z.string().trim().min(1, "jobId must be a non-empty id.");
const ServiceTypeEnum = z.enum(INVOICE_SERVICE_TYPES, {
  error: () => `serviceType must be one of: ${INVOICE_SERVICE_TYPES.join(", ")}.`,
});
// Optional invoice-level discount in integer paisa; the discounted figure is the
// taxable base (ADR-0039 c3). The "discount must not exceed the subtotal" rule is
// enforced at issue by computeInvoiceTax against the actual line total — it cannot
// be checked here (lines do not exist yet on a header-only DRAFT).
const DiscountPaisa = z
  .number()
  .int("discountPaisa must be an integer (paisa).")
  .min(0, "discountPaisa must be 0 or greater.")
  .max(MONEY_MAX_PAISA, "discountPaisa is too large.");

// POST /api/v1/invoices — create a DRAFT invoice HEADER (ADR-0039 c5). The LINES
// are added in D4; the `number` and the frozen tax snapshot are assigned at issue
// (D3 issue()); so none of those appear here. `documentType` is fixed to INVOICE
// (a CREDIT_NOTE is created via the dedicated credit-note path, D3) and `status`
// defaults to DRAFT — neither is client-settable. `createdById` comes from the
// session, never the body. `.strict()` rejects `number`, any tax/amount field,
// `status`, `documentType`, `createdById`, or any typo'd key with HTTP 400.
export const CreateInvoiceSchema = z
  .object({
    customerId: CustomerId,
    jobId: JobId.nullable().optional(),
    serviceType: ServiceTypeEnum.nullable().optional(),
    discountPaisa: DiscountPaisa.nullable().optional(),
  })
  .strict();

export type CreateInvoiceInput = z.infer<typeof CreateInvoiceSchema>;

// PATCH /api/v1/invoices/:id — partial update of a DRAFT (ADR-0039 c5). Only the
// DRAFT-editable header fields appear; `number`, every frozen tax amount,
// `status`, and `documentType` are deliberately ABSENT, so `.strict()` rejects
// any attempt to set them on ANY invoice. The service additionally refuses the
// WHOLE update on a non-DRAFT row (an ISSUED invoice's financial body is
// immutable; corrected only by a credit note) — so between the schema and the
// service every financial field is rejected on an issued invoice. The
// at-least-one-field refine rejects a no-op PATCH (mirrors Customers/Jobs).
export const UpdateInvoiceSchema = CreateInvoiceSchema.partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

export type UpdateInvoiceInput = z.infer<typeof UpdateInvoiceSchema>;
