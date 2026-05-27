// Web-side display helpers for the Customers slice. Iter 15 ships the
// read path so this file is intentionally smaller than its Drivers /
// Vehicles peers — it exposes the status option array and the label
// map the list and detail surfaces use. Iter 16 will add the form
// schemas (CreateCustomerFormSchema / UpdateCustomerFormSchema)
// mirroring apps/web/src/lib/drivers-schema.ts the same way Drivers
// staged iter-6 → iter-7.
//
// The `as const` makes each option's `value` a string-literal type so
// CUSTOMER_STATUS_OPTIONS[number]["value"] reduces to "ACTIVE" |
// "INACTIVE". Single source of truth lives in the options array — the
// label map below is derived from it via Object.fromEntries so a new
// status is added in one place.

export const CUSTOMER_STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
] as const;

export const CUSTOMER_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  CUSTOMER_STATUS_OPTIONS.map(({ value, label }) => [value, label]),
);
