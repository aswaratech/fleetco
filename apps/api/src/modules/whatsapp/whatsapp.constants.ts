// One-source-of-truth constants for the WhatsApp channel (ADR-0046 c3) — the
// notification.constants.ts discipline: the producer (the inbound controller),
// the worker (@Processor), and the module (BullModule.registerQueue) all import
// the SAME strings from here, so a typo cannot wire a producer to one queue and
// a worker to another with no compile error.

// The named queue this feature OWNS (ADR-0029 c2 — per-feature queue
// ownership; the @Global() QueueModule provides the shared connection).
export const WHATSAPP_INBOUND_QUEUE = "whatsapp-inbound";

// Job name for one inbound Twilio webhook delivery: dedup -> resolve -> authz
// -> get-or-create conversation -> runTurn -> render -> send (ADR-0046 c3).
export const WHATSAPP_INBOUND_JOB_NAME = "whatsapp-inbound-message";

// Worker concurrency: a modest >1 (ADR-0046 §Recommended picks) — concurrency-1
// would head-of-line-block every user behind one long turn (turns run 10–90 s),
// while the agent's own per-conversation in-flight lock already serializes
// same-conversation collisions (409 -> the job retries with backoff).
export const WHATSAPP_INBOUND_CONCURRENCY = 2;

// Per-job retry envelope, set at enqueue time (overriding the QueueModule
// default of 3 × 2 s): 6 attempts with exponential backoff from 5 s covers
// ~155 s of same-conversation collision — longer than the agent's 90 s turn
// wall-clock, so a message that arrives while another turn is running always
// outlives the collision. ONLY the 409 collision path rethrows for retry; a
// hard turn failure never does (the turn is not idempotent — see the
// processor's failure handling).
export const WHATSAPP_INBOUND_ATTEMPTS = 6;
export const WHATSAPP_INBOUND_BACKOFF_DELAY_MS = 5_000;

// Per-user inbound daily cap (ADR-0046 c8/§Recommended picks: WhatsApp makes
// every inbound a BILLED outbound, so ADR-0043 c8's "no cap" posture is riskier
// here). Counted per canonical phone per UTC day; messages past the cap are
// dropped with an audit row and no reply. TUNABLE: the exact number is the
// PO's to set (the GPS_PING_RETENTION_DAYS precedent — a named constant the
// operator tunes by PR); 100/day is far above any legitimate day-1 use (the
// table holds one link) while bounding a runaway loop's spend.
export const WHATSAPP_DAILY_INBOUND_CAP = 100;
