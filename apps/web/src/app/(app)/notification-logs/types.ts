// Web-side view of the API's NotificationLog row (ADR-0038 C4). Mirrors the
// Prisma model in apps/api/prisma/schema.prisma (model NotificationLog) at the
// field level; dates arrive as ISO strings over the JSON wire so they are typed
// as `string` here rather than `Date` to avoid a hidden coercion surface. Both
// the list endpoint and the detail endpoint return this shape.
//
// This is the reminder-delivery AUDIT ledger — "we notified about that lapse on
// date X" (ADR-0013 audit value). It is READ-ONLY: written only by the API's
// scan→send worker, never by a web form. subjectType / reminderKind / state are
// OPEN STRINGS (not enums) so the API extends them with no migration; the web
// label maps (lib/notification-logs.ts) fall back to the raw token for any value
// they don't yet know.
export interface NotificationLog {
  id: string;
  // The subject domain — "VEHICLE" (compliance) / "SERVICE_SCHEDULE"
  // (maintenance). Open string.
  subjectType: string;
  // The subject row id (e.g. the Vehicle id). NOT a FK — the ledger survives the
  // subject's deletion as an audit record, so this is never resolved to a
  // registration (the subject may be gone).
  subjectId: string;
  // Which document/dimension lapsed — "BLUEBOOK" / "INSURANCE" / "ROUTE_PERMIT"
  // / "SERVICE". Open string.
  reminderKind: string;
  // The threshold crossed — "expiring-soon" / "expired" / "due-soon" /
  // "overdue". Open string; drives the status Badge variant.
  state: string;
  // The due date that armed this reminder (the expiry ISO date, or a service
  // schedule's next-due anchor). A renewal is a new occurrenceKey → re-arms.
  occurrenceKey: string;
  // The recipient address(es) the digest was sent to (comma-joined when more
  // than one; v1 is the single operator). Tier-2 PII — shown to the operator
  // (their own address) but never logged API-side.
  recipient: string;
  // When the send that delivered this lapse's digest completed. Null between a
  // scan-time intent and the send completion (today rows are written at
  // send-success, so this is populated in practice).
  sentAt: string | null;
  // The transactional provider's message id from the completing send, when it
  // returns one (Resend does). Null until sent.
  providerMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}
