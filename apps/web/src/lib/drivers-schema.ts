// Web-side display helpers for the Drivers slice. Iter 6 ships the
// read path only; the parallel zod form schemas (CreateDriverFormSchema
// / UpdateDriverFormSchema) arrive with the iter-7 write path,
// mirroring how apps/web/src/lib/vehicles-schema.ts evolved between
// iters 1 and 2 of the Vehicles slice. Today this file exports only
// the display options + label maps that the list page, the detail
// page, and the filter toolbar all consume.

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
