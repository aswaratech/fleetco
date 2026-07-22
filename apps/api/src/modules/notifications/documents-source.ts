import { complianceBadgeState } from "@fleetco/shared";

import { type ReminderItem } from "./compliance-source";

// The DOCUMENT reminder source (ADR-0049 c5) — the third reminder source, added
// so a fleet document that carries an `expiresAt` (an agreement contract, a
// driver's license scan, an ID document) emails through the SAME daily digest
// as the vehicle-compliance and maintenance sources. It classifies each dated
// document with the SHARED `complianceBadgeState` — the same helper the
// compliance source and the web badge use — so a document reminder can never
// disagree with the badge shown beside it (the c6 drift guard extended to
// documents). Pure (no Prisma, no env, no clock): the scan reads the documents
// and passes them in, exactly as the compliance/maintenance sources are fed.
//
// THE LOAD-BEARING EXCLUSION (ADR-0049 c5): a document ATTACHED TO A VEHICLE in
// one of the vehicle-compliance categories (BLUEBOOK / INSURANCE / ROUTE_PERMIT)
// is SKIPPED here — the Vehicle's structured `*ExpiresAt` fields are canonical
// for those, and the compliance source already reminds on them. Without this,
// uploading a bluebook scan (with an expiry) beside the vehicle's bluebook
// expiry field would email TWICE for one lapse — the exact "operator learns to
// filter the channel to trash" failure ADR-0038 exists to prevent. Driver /
// customer documents, and vehicle documents in AGREEMENT / OTHER, have no
// structured twin, so they are the documents this source actually reminds on.

/** The notification subject domain for a fleet-document reminder. */
export const SUBJECT_TYPE_DOCUMENT = "DOCUMENT";

/**
 * The vehicle-compliance categories the compliance source ALREADY reminds on
 * (via the Vehicle's structured expiry fields). A vehicle-attached document in
 * one of these is excluded here — the canonical-field rule (ADR-0049 c5).
 */
const VEHICLE_COMPLIANCE_CATEGORIES: ReadonlySet<string> = new Set([
  "BLUEBOOK",
  "INSURANCE",
  "ROUTE_PERMIT",
]);

/**
 * category → the precise-noun label the digest renders (DESIGN.md §Voice: name
 * the thing). Mirrors the web's DOCUMENT_CATEGORY_LABELS; a category absent here
 * degrades to the raw token (never a blank), the forward-compat rule.
 */
const DOCUMENT_CATEGORY_LABELS: Record<string, string> = {
  BLUEBOOK: "Bluebook",
  INSURANCE: "Insurance",
  ROUTE_PERMIT: "Route permit",
  AGREEMENT: "Agreement",
  LICENSE: "License",
  ID_DOCUMENT: "ID document",
  OTHER: "Document",
};

/**
 * The minimal document shape the source needs. `expiresAt` is the ISO string (or
 * null — a document without an expiry never reminds); `entityLabel` is the
 * owning entity's display name (registration / driver full name / customer
 * name); `vehicleAttached` marks the exclusion input — true iff the document
 * hangs off a vehicle (the scan derives it from `vehicleId != null`).
 */
export interface DocumentReminderInput {
  id: string;
  category: string;
  title: string;
  expiresAt: string | null;
  entityLabel: string;
  vehicleAttached: boolean;
}

/**
 * Classify each dated document into the remind-worthy items (`expired` /
 * `expiring-soon`), applying the vehicle-compliance-category exclusion. Pure —
 * `now` / `windowDays` are explicit (forwarded verbatim to the shared
 * classifier, never re-derived) so the boundary is deterministically testable
 * and matches the badge exactly (ADR-0049 c5 / ADR-0038 c6).
 *
 * @param documents  the dated documents to scan (expiry as ISO string or null)
 * @param now        the reference instant (the scan passes `new Date()`)
 * @param windowDays the expiring-soon window (default 30, the compliance window)
 */
export function collectDocumentExpiryReminders(
  documents: readonly DocumentReminderInput[],
  now: Date,
  windowDays = 30,
): ReminderItem[] {
  const items: ReminderItem[] = [];
  for (const document of documents) {
    // The canonical-field exclusion: skip a vehicle-attached compliance-category
    // document — the compliance source (SUBJECT_TYPE_VEHICLE) owns those lapses.
    if (document.vehicleAttached && VEHICLE_COMPLIANCE_CATEGORIES.has(document.category)) {
      continue;
    }

    const state = complianceBadgeState(document.expiresAt, now, windowDays);
    if (state !== "expired" && state !== "expiring-soon") continue;
    // expiresAt is non-null here: complianceBadgeState returns "none" for a
    // null/unparseable date, so a remind-worthy state guarantees a usable key.
    if (document.expiresAt === null) continue;

    items.push({
      subjectType: SUBJECT_TYPE_DOCUMENT,
      subjectId: document.id,
      // "<title> — <entity>": the document is the subject, the entity the
      // context (a customer's "2083 haul contract", a driver's "License scan").
      subjectLabel: `${document.title} — ${document.entityLabel}`,
      reminderKind: document.category,
      kindLabel: DOCUMENT_CATEGORY_LABELS[document.category] ?? document.category,
      state,
      occurrenceKey: document.expiresAt,
    });
  }
  return items;
}
