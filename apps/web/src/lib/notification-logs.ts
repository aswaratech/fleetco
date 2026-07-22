// Pure display helpers for the NotificationLog audit view (ADR-0038 C4). The
// API stores subjectType / reminderKind / state as OPEN STRINGS (not enums) so a
// future reminder source extends them with no migration; these maps turn the
// known tokens into the operator-facing labels and the status-Badge variant, and
// — the load-bearing forward-compat rule — FALL BACK to the raw token for any
// value they don't yet know (a new kind renders its own token, never a blank).
//
// Pure and dependency-free (the money.ts / nepali-date.ts sibling pattern), so
// the mapping is unit-tested in isolation (test/notification-logs.test.ts) and
// the list/detail server components stay markup-only.

// The Badge variants this surface uses — a subset of the <Badge> component's
// variants (apps/web/src/components/ui/badge.tsx). `error` (red) and `warning`
// (amber) are the compliance/maintenance lapse hues from DESIGN.md §"Status
// badges"; `neutral` (zinc) is the fallback for an unknown/benign state.
export type NotificationBadgeVariant = "error" | "warning" | "neutral";

// subjectType → operator label. "VEHICLE" reads as "Vehicle compliance" (the
// reminder is about a vehicle's compliance documents); "SERVICE_SCHEDULE" reads
// as "Service schedule".
const SUBJECT_TYPE_LABELS: Record<string, string> = {
  VEHICLE: "Vehicle compliance",
  SERVICE_SCHEDULE: "Service schedule",
  // ADR-0049 F6: the fleet-document reminder source (agreements, licenses, IDs).
  DOCUMENT: "Document",
};

// reminderKind → operator label. The precise-noun labels the digest renders
// (DESIGN.md §Voice: "Bluebook", not "Document"). The document source (ADR-0049
// F6) reminds by document category, so those join here; BLUEBOOK / INSURANCE /
// ROUTE_PERMIT are shared with the compliance source (a document in those
// categories only reaches the ledger from a DRIVER/CUSTOMER doc — the
// vehicle-attached ones are excluded at the source).
const REMINDER_KIND_LABELS: Record<string, string> = {
  BLUEBOOK: "Bluebook",
  INSURANCE: "Insurance",
  ROUTE_PERMIT: "Route permit",
  SERVICE: "Service",
  AGREEMENT: "Agreement",
  LICENSE: "License",
  ID_DOCUMENT: "ID document",
  OTHER: "Document",
};

// state → operator label. The four remind-worthy states across both sources.
const STATE_LABELS: Record<string, string> = {
  expired: "Expired",
  "expiring-soon": "Expiring soon",
  overdue: "Overdue",
  "due-soon": "Due soon",
};

// state → Badge variant. The "past the line" states (`expired` / `overdue`) are
// red `error`; the "approaching the line" states (`expiring-soon` / `due-soon`)
// are amber `warning` — the SAME hue mapping the Vehicle-detail compliance and
// service badges use, so the audit view reads consistently with the pages that
// produced the reminder. An unknown state degrades to `neutral`.
const STATE_BADGE_VARIANTS: Record<string, NotificationBadgeVariant> = {
  expired: "error",
  overdue: "error",
  "expiring-soon": "warning",
  "due-soon": "warning",
};

/** subjectType → label, falling back to the raw token for an unknown value. */
export function subjectTypeLabel(subjectType: string): string {
  return SUBJECT_TYPE_LABELS[subjectType] ?? subjectType;
}

/** reminderKind → label, falling back to the raw token for an unknown value. */
export function reminderKindLabel(reminderKind: string): string {
  return REMINDER_KIND_LABELS[reminderKind] ?? reminderKind;
}

/** state → label, falling back to the raw token for an unknown value. */
export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

/** state → Badge variant, defaulting to `neutral` for an unknown value. */
export function stateBadgeVariant(state: string): NotificationBadgeVariant {
  return STATE_BADGE_VARIANTS[state] ?? "neutral";
}

// subjectType filter options for the list toolbar. The two known domains, in the
// order the operator thinks of them (compliance first, the source that ships
// real today; ADR-0038 §3). An unknown subjectType in the data still renders via
// the fallback label in the table — the filter just does not offer it as a
// preset, which is the right v1 behavior for an audit view.
export const SUBJECT_TYPE_FILTER_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "VEHICLE", label: "Vehicle compliance" },
  { value: "DOCUMENT", label: "Document" },
  { value: "SERVICE_SCHEDULE", label: "Service schedule" },
];
