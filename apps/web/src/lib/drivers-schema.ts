import { z } from "zod";

// Web-side display helpers + form schemas for the Drivers slice. Iter 6
// shipped the read-path bits (option arrays and label maps); iter 7
// adds the parallel form schemas (DriverFormSchema, CreateDriverFormSchema,
// UpdateDriverFormSchema) mirroring apps/web/src/lib/vehicles-schema.ts.
//
// Why duplicate the API's schemas rather than share via a workspace
// package: at iter 7 the shared schema would be the only export of a
// new package, which adds tooling overhead disproportionate to one
// struct. The duplication budget is reviewed when the third aggregate
// (Customers) needs a form schema. Drift risk meantime is bounded: the
// API rejects anything the client sends incorrectly, so client-side
// schema drift produces a worse UX (server-side validation message
// only) but not a data correctness problem.

const LICENSE_CLASSES = ["LMV", "HMV", "HTV", "HPMV"] as const;
const DRIVER_STATUSES = ["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"] as const;

// Display-friendly enum labels. The page-level drivers list uses the
// same mapping (apps/web/src/app/drivers/page.tsx) and the detail page
// reuses it too. Labels match docs/glossary.md's prose framings of the
// four DoTM license categories — "Heavy transport" rather than "HTV"
// for the rendered surface, with the DoTM acronym preserved in
// parentheses so the operator can match a paper license at a glance.
//
// The `as const` makes each tuple's `value` a string-literal type, so
// LICENSE_CLASS_OPTIONS[number]["value"] reduces to the precise union
// "LMV" | "HMV" | "HTV" | "HPMV". Same trick for DRIVER_STATUS_OPTIONS.
// Inlining the literal arrays here (rather than re-declaring the
// LICENSE_CLASSES / DRIVER_STATUSES tuple types separately) keeps the
// single source of truth at the options array and avoids the
// type-only-import lint trap.
export const LICENSE_CLASS_OPTIONS = [
  { value: "LMV", label: "Light motor (LMV)" },
  { value: "HMV", label: "Heavy motor (HMV)" },
  { value: "HTV", label: "Heavy transport (HTV)" },
  { value: "HPMV", label: "Heavy passenger (HPMV)" },
] as const;

export const DRIVER_STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "ON_LEAVE", label: "On leave" },
  { value: "SUSPENDED", label: "Suspended" },
  { value: "TERMINATED", label: "Terminated" },
] as const;

export const LICENSE_CLASS_LABELS: Record<string, string> = Object.fromEntries(
  LICENSE_CLASS_OPTIONS.map(({ value, label }) => [value, label]),
);

export const DRIVER_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  DRIVER_STATUS_OPTIONS.map(({ value, label }) => [value, label]),
);

// Date inputs from <input type="date"> render as YYYY-MM-DD strings.
// We accept that form and let the API coerce. An empty string from a
// blank input becomes a required-field error.
const DateString = z
  .string()
  .min(1, "Date is required.")
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.");

// Nepal phone: mirrors the API's NEPAL_PHONE_REGEX. The error message
// shown to the user matches the API's message verbatim so a server-
// rejected value reads the same as a client-rejected one. CLAUDE.md
// forbids tightening the regex without an ADR.
const NEPAL_PHONE_REGEX = /^(?:\+977[- ]?[\d][\d\s-]{6,14}|[\d][\d\s-]{8,14})$/;

// Shared field shape used by both Create and Update forms. The Create
// form requires every field except dateOfBirth (which is optional on
// both the client schema and the API); the Update form derives a
// partial of this shape via `.partial()` and adds an optional
// terminatedAt (which only the update surface uses — a driver is born
// active, never terminated).
//
// Each field's validator matches the API's authoritative version in
// apps/api/src/modules/drivers/drivers.schemas.ts so the client-side
// feedback aligns with the eventual server response. When the API rule
// changes, this file changes in the same commit.
export const DriverFormSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required.").max(128, "Full name is too long."),
  licenseNumber: z
    .string()
    .trim()
    .min(1, "License number is required.")
    .max(64, "License number is too long."),
  licenseClass: z.enum(LICENSE_CLASSES, {
    error: () => `License class must be one of: ${LICENSE_CLASSES.join(", ")}.`,
  }),
  phone: z
    .string()
    .trim()
    .min(1, "Phone is required.")
    .regex(
      NEPAL_PHONE_REGEX,
      "Phone must be a Nepal number (e.g. +977-9800000000 or a 10-digit local number).",
    ),
  // dateOfBirth is optional; the form renders an empty input by default.
  // An empty string is treated as "not provided" so the form does not
  // fail validation when the operator does not know the DOB. The action
  // layer strips empty-string values out of the payload to avoid
  // sending `dateOfBirth: ""` which the API would reject.
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$|^$/, "Use the YYYY-MM-DD date format.")
    .optional(),
  hiredAt: DateString,
  licenseExpiresAt: DateString,
  status: z.enum(DRIVER_STATUSES, {
    error: () => `Status must be one of: ${DRIVER_STATUSES.join(", ")}.`,
  }),
});

export type DriverFormValues = z.infer<typeof DriverFormSchema>;

// Create form: identical to the shared shape. The API defaults
// `status` server-side, but the form renders the field so the operator
// can pick ON_LEAVE for a driver who is hired-but-not-yet-active. The
// client always sends the value through — keeping the form's "the
// fields you see on screen are the fields that are submitted" mental
// model intact.
export const CreateDriverFormSchema = DriverFormSchema;

export type CreateDriverFormValues = z.infer<typeof CreateDriverFormSchema>;

// Update form: every field optional (PATCH semantics), plus
// `terminatedAt` which only the update surface uses. The API mirrors
// this shape in UpdateDriverSchema (drivers.schemas.ts) and applies
// the terminated-transition rule server-side: a status change INTO
// TERMINATED sets terminatedAt; a status change OUT clears it. The
// web edit form therefore does NOT manage terminatedAt explicitly
// when the user is just changing status — and in fact must NOT,
// because sending terminatedAt alongside an unchanged status would
// override the server-side derived value. The submit pathway computes
// a diff against the initial values and PATCHes only changed fields
// (see DESIGN.md §"Inputs and forms" "Diff-against-initial-values for
// PATCH").
//
// terminatedAt accepts either a YYYY-MM-DD string (date input) or
// `null` (explicit "clear terminatedAt"). The iter-7 edit form does
// not yet render a terminatedAt input — the rule covers the common
// cases — but the validator is in place so a future surface can use
// it without re-extending the schema.
export const UpdateDriverFormSchema = DriverFormSchema.partial().extend({
  terminatedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.")
    .nullable()
    .optional(),
});

export type UpdateDriverFormValues = z.infer<typeof UpdateDriverFormSchema>;
