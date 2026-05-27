import { z } from "zod";

// Zod schemas for the Customers slice. Iter 15 ships the read path
// (`ListCustomersQuerySchema`); iter 16 layers the write path:
// `CreateCustomerSchema` and `UpdateCustomerSchema`. The previous
// "absent in iter 15 by design" comment is no longer applicable —
// both surfaces now live here, mirroring the iter-6 → iter-7 staging
// the Drivers slice followed.
//
// This file deliberately mirrors
// apps/api/src/modules/drivers/drivers.schemas.ts in shape and
// convention: enum lists duplicated from Prisma enums (so the
// validation file does not pull the Prisma runtime), `.strict()` to
// reject unknown keys with HTTP 400, comma-separated multi-value enum
// filters via `csvEnum`, and an explicit pagination ceiling mirrored
// from the service-side LIST_TAKE_MAX constant.

// CustomerStatus enum — must mirror CustomerStatus in prisma/schema.prisma.
// Order matches the Prisma enum so an audit grep finds both lists side
// by side; the order has no runtime significance. Customers have a
// simpler status set than Drivers/Vehicles — a customer is either
// current business or dormant business.
const CUSTOMER_STATUSES = ["ACTIVE", "INACTIVE"] as const;

// Reusable field validators for the write path. These mirror the Tier-2
// / Tier-3 rules from the Customer model in prisma/schema.prisma:
//
//   - name is trimmed and required non-empty (an all-whitespace value
//     collapses to "" after trim and fails). Max length is loose (256)
//     to accommodate Nepali transliterated company names and the
//     occasional very long legal form.
//   - contactPerson is optional and nullable — many small or one-off
//     customers do not have a named contact distinct from the business
//     itself. Trimmed when present.
//   - phone is loose per CLAUDE.md "no PII-heavy regex": same Nepal
//     phone regex the Drivers slice uses. Pattern accepts either a
//     `+977-`-prefixed number or a 10-digit local number with optional
//     separators. Tightening requires an ADR (CLAUDE.md).
//   - email is loose per ADR-0013 (no gold-plating). We accept any
//     string containing an `@` between non-empty parts and let the
//     server be the authoritative validator. Optional + nullable.
//   - panNumber is optional + nullable. PAN format validation beyond
//     the unique-when-present rule is deferred (a Nepal PAN is 9
//     digits, but a future ADR will tighten if needed; today we keep
//     the surface permissive). Service-layer normalization (trim +
//     uppercase) lives in CustomersService, NOT here — the schema
//     accepts a wider input shape and the service normalizes before
//     persisting. Mirror of how DriversService treats licenseNumber.
//   - address is optional + nullable; free-form string, no parsing
//     into street/city/postal-code sub-fields in Phase 1.

const Name = z.string().trim().min(1, "Name is required.").max(256, "Name is too long.");

const ContactPerson = z.string().trim().max(128, "Contact person is too long.");

// Nepal phone regex — identical to drivers.schemas.ts. Promoting to a
// shared helper is deferred; CLAUDE.md forbids tightening either copy
// without an ADR, which keeps drift bounded.
const NEPAL_PHONE_REGEX = /^(?:\+977[- ]?[\d][\d\s-]{6,14}|[\d][\d\s-]{8,14})$/;

const Phone = z
  .string()
  .trim()
  .min(1, "Phone is required.")
  .regex(
    NEPAL_PHONE_REGEX,
    "Phone must be a Nepal number (e.g. +977-9800000000 or a 10-digit local number).",
  );

// Loose email validator per ADR-0013. We avoid Zod's stricter built-in
// email check because the iter-15 PAN-conflict note in the runbook
// explicitly anchors on "loose validation; let users type what's on
// the paperwork". A future ADR can tighten — this validator is the
// only place that needs to change.
const Email = z
  .string()
  .trim()
  .min(1, "Email is required when provided.")
  .max(256, "Email is too long.")
  .refine((value) => /^[^\s@]+@[^\s@]+$/.test(value), {
    message: "Email must contain a single @ between two non-empty parts.",
  });

const PanNumber = z
  .string()
  .trim()
  .min(1, "PAN number is required when provided.")
  .max(32, "PAN number is too long.");

const Address = z.string().trim().max(512, "Address is too long.");

const CustomerStatusEnum = z.enum(CUSTOMER_STATUSES, {
  error: () => `Status must be one of: ${CUSTOMER_STATUSES.join(", ")}.`,
});

// POST /api/v1/customers request body. Required fields match the
// iter-16 kickoff (name, phone). Optional fields: contactPerson,
// email, panNumber, address, status. `createdById` is NOT accepted
// from the client — the controller pulls it from
// `request.session.user.id`. `.strict()` rejects unknown keys with
// HTTP 400 so a stray field never reaches Prisma.
//
// Optional-and-nullable fields accept `null` as an explicit "absent"
// marker; a missing key is treated the same. Both shapes normalize to
// `null` at the service layer for the database, mirroring how Drivers
// handles dateOfBirth. The `status` default lives at the service layer
// (CustomerStatus.ACTIVE).
export const CreateCustomerSchema = z
  .object({
    name: Name,
    contactPerson: ContactPerson.nullable().optional(),
    phone: Phone,
    email: Email.nullable().optional(),
    panNumber: PanNumber.nullable().optional(),
    address: Address.nullable().optional(),
    status: CustomerStatusEnum.optional(),
  })
  .strict();

export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

// PATCH /api/v1/customers/:id — partial update. Mirrors the Drivers
// pattern: take CreateCustomerSchema's shape as `.partial()` and
// reject empty bodies via `.refine` so a no-op PATCH surfaces as 400
// rather than silently returning the unchanged row. (Drivers and
// Vehicles use the identical refine — see drivers.schemas.ts's
// UpdateDriverSchema and vehicles.schemas.ts's UpdateVehicleSchema.)
//
// Every field stays nullable-where-it-was-nullable: the operator can
// clear a previously-entered contactPerson by sending `null` explicitly
// (the service distinguishes "client provided null" from "client did
// not mention" via hasOwnProperty).
export const UpdateCustomerSchema = CreateCustomerSchema.partial()
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required.",
  });

export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;

// GET /api/v1/customers query parameters (iter 15 — read path).
// Filter / sort / pagination contract mirrors the Drivers list
// endpoint; the web client's URL-searchParams convention is shared
// across surfaces so the same paginator / sortable-header /
// filter-toolbar idioms can be reused on the Customers list page.
//
// Wire conventions:
//   - `status` accepts either a single value (`?status=ACTIVE`) or a
//     comma-separated list (`?status=ACTIVE,INACTIVE`). Both normalize
//     to a deduplicated array; the service builds a Prisma `in:`
//     filter from it. An empty string (after splitting) is treated as
//     "no filter".
//   - `sortBy` is restricted to a whitelist of sortable columns. The
//     Customer model has an explicit index on `status` (defined in
//     schema.prisma); `name` and `createdAt` are also acceptable
//     primary sorts for Phase-1 fleet sizes — the same calculus as
//     Drivers. Allowing an arbitrary column would invite expensive
//     sorts and accidental information disclosure (`sortBy=phone`
//     would expose ordering information about Tier 2 PII; same
//     defense the Drivers schema documents).
//   - `sortDir` defaults at the controller to `desc` because "most
//     recent first" is the common case for `createdAt`. The default is
//     consistent across surfaces.
//   - `skip` defaults to 0; `take` defaults to 20. The schema's `take`
//     ceiling mirrors the service's LIST_TAKE_MAX so an over-large
//     `take` surfaces as HTTP 400 with a clear message rather than
//     being silently clamped.
const SORTABLE_COLUMNS = ["name", "createdAt"] as const;
export type CustomerSortColumn = (typeof SORTABLE_COLUMNS)[number];

const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type CustomerSortDir = (typeof SORT_DIRECTIONS)[number];

// Pagination ceiling duplicated from customers.service.ts on purpose:
// the service is the runtime authority (the schema can only validate
// what the client sent; it cannot speak for the database). Both
// constants must move together when one changes; the JSDoc on
// customers.service.ts's LIST_TAKE_MAX flags the same coupling.
const QUERY_MAX_TAKE = 200;

// Helper: turn a single-string-or-comma-separated query value into a
// validated, deduplicated array of enum members. Identical in shape to
// the Drivers and Vehicles versions; promoting to a shared helper is
// deferred — this iter is the third aggregate to declare it, which
// crosses the duplication-budget threshold the Drivers schema comment
// flags. The promotion is intentionally deferred to iter 16 (or a
// later dedicated refactor) so iter 15 stays scoped to the read path.
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

// Coerce a string-typed query param to a non-negative integer with
// bounds checking. Express's query parser hands us strings; without
// coercion the schema would reject every numeric param. Out-of-range
// values return 400 with a clear message rather than being silently
// clamped — a deliberate `take=10000` clamped to 200 would surprise
// an API consumer who expected to receive what they asked for. Same
// helper shape as drivers.schemas.ts.
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

export const ListCustomersQuerySchema = z
  .object({
    status: csvEnum(CUSTOMER_STATUSES),
    sortBy: z.enum(SORTABLE_COLUMNS).optional(),
    sortDir: z.enum(SORT_DIRECTIONS).optional(),
    skip: intParam(0, Number.MAX_SAFE_INTEGER, "skip"),
    take: intParam(1, QUERY_MAX_TAKE, "take"),
  })
  // Strict so a typo'd query key (e.g., `?staus=ACTIVE`) surfaces as
  // 400 rather than being silently ignored. Matches the Drivers and
  // Vehicles contracts.
  .strict();

export type ListCustomersQuery = z.infer<typeof ListCustomersQuerySchema>;
