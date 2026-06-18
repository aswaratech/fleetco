// One-source-of-truth constants for the notification/reminder-delivery feature
// (ADR-0038 commitments 2–4). The producer (the scheduler), the worker
// (@Processor), and the module (BullModule.registerQueue) all import the SAME
// strings from here — a typo would otherwise wire a producer to one queue and a
// worker to another with no compile error. This mirrors the retention
// `TRACES_PRUNE_*` discipline (apps/api/src/modules/retention/retention.service.ts),
// kept in a dedicated file because BOTH the service and the worker need them and
// neither should import the other just for a constant.

// The named queue this feature OWNS (ADR-0029 commitment 2 — per-feature queue
// ownership). The `@Global()` QueueModule (ADR-0029 T1) provides the shared
// connection + default job options every queue inherits; the concrete queue is
// registered by NotificationModule. The name is exactly the one the QueueModule
// comment reserved as "any future notifications … queue".
export const NOTIFICATION_QUEUE = "notifications";

// Job name for the daily SCAN run: read the due/overdue sources, diff against
// the NotificationLog, and enqueue one SEND job per recipient (the scan→send
// split, ADR-0038 c4). The repeatable scheduler stamps every scheduled run with
// this name; an ad-hoc immediate scan (a test) uses the same name so the worker
// handles both identically.
export const REMINDER_SCAN_JOB_NAME = "reminder-scan";

// Job name for a SEND run: deliver ONE digest email to ONE recipient via the
// injected Mailer. The scan enqueues these; each is independently retried by the
// queue's default `attempts: 3` + exponential backoff (ADR-0038 c4), so a
// transient provider blip retries the one failed send rather than re-running the
// whole scan.
export const REMINDER_SEND_JOB_NAME = "reminder-send";

// Stable scheduler id (ADR-0038 c3). upsertJobScheduler is KEYED on this id, so
// registering it at every boot UPSERTS the single entry rather than stacking a
// duplicate repeatable per restart, exactly as RetentionService does with
// `traces-prune-daily`. Changing the cadence below is a restart-safe edit
// precisely because this id stays the same.
export const REMINDER_SCAN_SCHEDULER_ID = "reminder-scan-daily";

// Cron cadence for the daily scan (ADR-0038 c3: "a once-daily morning cron,
// tunable"). 01:00 every day. TUNABLE: the cron is interpreted in the server's
// timezone, and production runs UTC, so 01:00 UTC ≈ 06:45 Nepal (UTC+05:45) —
// the digest lands at the start of the operator's workday (the ADR's worked
// example). The exact time is the PO's to tune; this is a restart-safe edit
// because REMINDER_SCAN_SCHEDULER_ID stays fixed. (Retention's prune runs at
// 03:00 UTC; the two daily jobs are deliberately offset.)
export const REMINDER_SCAN_CRON = "0 1 * * *";

// Worker concurrency for the notifications queue: 1 (ADR-0038 c4, mirroring the
// retention prune's concurrency-1). The scan is a single in-process job that
// needs no parallelism, and a concurrency of 1 also guarantees two scans can
// never overlap (a long-running scan cannot be lapped by the next tick).
export const NOTIFICATION_CONCURRENCY = 1;
