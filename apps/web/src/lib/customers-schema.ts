import { z } from "zod";

// Web-side display helpers + form schemas for the Customers slice.
// Iter 15 shipped the read-path bits (option arrays and label maps);
// iter 16 adds the parallel form schemas (CustomerFormSchema,
// CreateCustomerFormSchema, UpdateCustomerFormSchema) mirroring
// apps/web/src/lib/drivers-schema.ts the same way Drivers staged
// iter-6 → iter-7.
//
// Why duplicate the API's schemas rather than share via a workspace
// package: at iter 16 the shared schema would be the only export of a
// new package, which adds tooling overhead disproportionate to one
// struct. The duplication budget is reviewed when the fourth
// aggregate (Jobs) needs a form schema. Drift risk meantime is
// bounded: the API rejects anything the client sends incorrectly, so
// client-side schema drift produces a worse UX (server-side
// validation message only) but not a data correctness problem. Same
// calculus drivers-schema.ts documents.

// The `as const` makes each option's `value` a string-literal type so
// CUSTOMER_STATUS_OPTIONS[number]["value"] reduces to "ACTIVE" |
// "INACTIVE". Single source of truth lives in the options array — the
// label map below is derived from it via Object.fromEntries so a new
// status is added in one place.

const CUSTOMER_STATUSES = ["ACTIVE", "INACTIVE"] as const;

export const CUSTOMER_STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
] as const;

export const CUSTOMER_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  CUSTOMER_STATUS_OPTIONS.map(({ value, label }) => [value, label]),
);

// Nepal phone: mirrors the API's NEPAL_PHONE_REGEX (apps/api/src/
// modules/customers/customers.schemas.ts). The error message shown to
// the user matches the API's message verbatim so a server-rejected
// value reads the same as a client-rejected one. CLAUDE.md forbids
// tightening the regex without an ADR; same constraint applies here
// and to drivers-schema.ts.
const NEPAL_PHONE_REGEX = /^(?:\+977[- ]?[\d][\d\s-]{6,14}|[\d][\d\s-]{8,14})$/;

// Shared field shape used by both Create and Update forms. The Create
// form requires name + phone (matching the API's CreateCustomerSchema);
// every other field is optional with the same nullability the API
// accepts. The Update form derives a partial of this shape via
// `.partial()` so PATCH can send only the fields that changed (diff-
// against-initial-values pattern — DESIGN.md §"Inputs and forms").
//
// Optional fields use `.optional()` rather than `.nullable()` on the
// client side because the create form represents "not provided" as an
// empty string from the input element. The action layer is responsible
// for stripping empty strings before POSTing (the API would 400 on an
// empty-string email or PAN given the schema's `.min(1)` checks). The
// update form additionally supports `null` for nullable fields so the
// edit UI can explicitly clear a previously-entered contactPerson /
// email / panNumber / address — the update action layer translates
// that into the wire shape the API expects (an explicit `null` keys
// the service-layer hasOwnProperty branch).
//
// Each field's validator matches the API's authoritative version in
// apps/api/src/modules/customers/customers.schemas.ts so client-side
// feedback aligns with the eventual server response. When the API
// rule changes, this file changes in the same commit.
export const CustomerFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(256, "Name is too long."),
  contactPerson: z.string().trim().max(128, "Contact person is too long.").optional(),
  phone: z
    .string()
    .trim()
    .min(1, "Phone is required.")
    .regex(
      NEPAL_PHONE_REGEX,
      "Phone must be a Nepal number (e.g. +977-9800000000 or a 10-digit local number).",
    ),
  // Email is optional on the create surface. When provided it must
  // contain a single @ between two non-empty parts — same loose check
  // the API uses (ADR-0013, no gold-plating). Empty string is treated
  // as "not provided" so a blank input does not fail validation; the
  // action layer strips it from the wire payload.
  email: z
    .string()
    .trim()
    .max(256, "Email is too long.")
    .refine((value) => value.length === 0 || /^[^\s@]+@[^\s@]+$/.test(value), {
      message: "Email must contain a single @ between two non-empty parts.",
    })
    .optional(),
  // PAN format is permissive on the client (matches the API). The
  // service layer normalizes to trim + uppercase before persisting, so
  // the wire value the operator types is what they see on the
  // paperwork — no client-side casing rules to surprise them.
  panNumber: z.string().trim().max(32, "PAN number is too long.").optional(),
  address: z.string().trim().max(512, "Address is too long.").optional(),
  status: z.enum(CUSTOMER_STATUSES, {
    error: () => `Status must be one of: ${CUSTOMER_STATUSES.join(", ")}.`,
  }),
});

export type CustomerFormValues = z.infer<typeof CustomerFormSchema>;

// Create form: identical to the shared shape. The API defaults
// `status` server-side, but the form renders the field so the operator
// can pick INACTIVE for a customer who is on file but not actively
// trading. The client always sends the value through — keeping the
// form's "the fields you see on screen are the fields that are
// submitted" mental model intact. Same pattern as
// CreateDriverFormSchema.
export const CreateCustomerFormSchema = CustomerFormSchema;

export type CreateCustomerFormValues = z.infer<typeof CreateCustomerFormSchema>;

// Update form: every field optional (PATCH semantics). Nullable text
// fields additionally accept `null` so the edit UI can explicitly
// clear a previously-entered value (the API distinguishes "client
// provided null" from "client did not mention" via hasOwnProperty;
// the service layer normalizes `null` to a real database NULL).
//
// `.partial()` first, then `.extend()` to widen the nullable text
// fields. We do NOT add a `.refine((data) => Object.keys(data).length > 0)`
// here because the update action layer enforces "nothing to update"
// before invoking the schema — the client form's diff-against-initial-
// values has already filtered out unchanged keys, and an empty diff
// surfaces as a friendlier message from the action than from the
// schema. The API does enforce the same refine server-side
// (UpdateCustomerSchema in customers.schemas.ts), so a bypass attempt
// surfaces as 400.
export const UpdateCustomerFormSchema = CustomerFormSchema.partial().extend({
  contactPerson: z.string().trim().max(128, "Contact person is too long.").nullable().optional(),
  email: z
    .string()
    .trim()
    .max(256, "Email is too long.")
    .refine((value) => value.length === 0 || /^[^\s@]+@[^\s@]+$/.test(value), {
      message: "Email must contain a single @ between two non-empty parts.",
    })
    .nullable()
    .optional(),
  panNumber: z.string().trim().max(32, "PAN number is too long.").nullable().optional(),
  address: z.string().trim().max(512, "Address is too long.").nullable().optional(),
});

export type UpdateCustomerFormValues = z.infer<typeof UpdateCustomerFormSchema>;
