# ADR-0035: Offline GPS producer — an on-trip foreground-service capture into a SQLCipher-encrypted on-device outbox that batch-flushes the existing ingest contract, with at-least-once delivery and ADR-0027's reserved questions discharged

- **Status:** Accepted
- **Date:** 2026-06-06
- **Decider:** Product owner (CEO)
- **Accepted:** 2026-06-09

## Acceptance

Accepted by the product owner (CEO) on 2026-06-09, ratifying the client mechanics and the two reserved-question discharges: the on-device Tier-5 outbox is **SQLCipher-encrypted from the start**; **late-delivered on-trip pings are kept** (capture time, not delivery time, is the minimization boundary) and **pruning is on the device-fix `timestamp`** (ADR-0027's reserved "Revisit when" #5 and the prune-basis interaction, both settled); and there is **no server-side dedup** (at-least-once delivery against the existing `.strict()` `{ pings: [...] }` ingest contract). Accepted last of the three, per the load-bearing acceptance order. The implementing slices (D4 foreground GPS, D5 background + encrypted outbox) may proceed.

## Context

Phase 2 is open per ADR-0025. This is the **third of three driver-app foundation ADRs** (ADR-0033 platform, ADR-0034 auth + DRIVER role, then this one). The GPS ingestion backend (ADR-0029, T1–T5) is built and **inert**, and the geofence-status read (ADR-0030, G5) reads against it; the driver app (ADR-0033/0034) is the missing **producer**. This ADR decides the **client-side capture and offline-queue mechanics** — the work that ADR-0027 commitment 2 explicitly delegated to "the driver-app slice" and that ADR-0029's "Revisit when" left to "the driver-app slice [to] settle."

**The reconciliation that matters most (read before the commitments).** ADR-0027 already decided the **policy** for location data, and this ADR does **not** re-open any of it — those points are **citations, not re-decisions**:

- Tier 5 (ADR-0027 c1), which "inherits all of Tier 2's controls — **encrypted at rest**, never logged by default";
- collection scoped to **on-trip windows** (c2), "the strongest privacy control … not collecting what is not needed";
- **native precision** in the operational window (c4);
- the **short raw-retention window**, provisionally 90 days, with prune-or-aggregate (c3);
- **never logged, never exported** egress (c5) — the pino redact list and the span-scrub seam, the latter now shipped (the polish-sweep P4 ticket);
- the **raw-vs-derived read split** (c7), realized in ADR-0028/ADR-0029.

What is **NEW** here is exactly two things: the **client queue mechanics** ADR-0027 c2 delegated, and the **discharge of the two questions ADR-0027 and ADR-0029 reserved to this slice** (the late-delivered-ping scope and the prune basis). Everything else is a citation.

The contract this produces against was verified against the source (`apps/api/src/modules/telematics/telematics.schemas.ts`): **`POST /api/v1/telematics/pings`**, an authenticated batch **`{ pings: [...] }`** (min 1, max 1000), each ping `{ vehicleId, tripId?, latitude, longitude, altitude?, speed?, heading?, timestamp }`, the wrapper and each ping **`.strict()`** (an unknown key is HTTP 400), `createdById` filled from the session (never the body), a fast **202** ack, and a BullMQ worker that bulk-inserts (ADR-0029 c10). `gps:ingest` is held by `DRIVER` per ADR-0034.

This ADR **decides client mechanics and policy discharges only**; it writes no code. The mechanics land in **D4** (foreground GPS, direct POST) and **D5** (background GPS + the encrypted outbox). D5 requires the **custom build** (ADR-0033 commitment 7): SQLCipher and background location are not bundled in Expo Go.

## Decision

**Capture GPS via `expo-location` + `expo-task-manager` as an Android foreground service bound to an active trip (ADR-0027 c2's on-trip-only collection); buffer fixes in a durable, SQLCipher-encrypted-from-the-start `expo-sqlite` (WAL) on-device outbox; flush them with a pure, unit-testable SyncManager that POSTs the existing `{ pings: [...] }` contract byte-for-byte and marks rows delivered on the 202, with at-least-once delivery and no server-side dedup; and discharge ADR-0027's two reserved questions — keep late-delivered on-trip pings, and prune on the device-fix `timestamp` — with the minimization reasoning explicit.** Eight commitments define the shape, grouped. As with its siblings, this ADR **writes no code**; the implementing slices build it.

### A. Capture

1. **An on-trip foreground service; best-effort and gap-tolerant by design.** Capture uses `expo-location` + `expo-task-manager` as an **Android foreground service with a persistent notification, bound to an active trip** — the service starts on trip-start and stops on trip-stop, so the app tracks the *work use of a company vehicle* and never the driver off-duty (ADR-0027 c2). The honest Android reality, stated so the PO is not surprised: tracking is **best-effort and gap-tolerant by design.** OEM battery-killers (Xiaomi/Redmi/Oppo/Vivo/Realme — dominant in Nepal) and Doze can stop a background service *even with the foreground notification showing*, and a swiped-away app does not auto-restart on a location event; the realistic outcome is **gaps, not a clean trace**, device- and vendor-specific. The server already tolerates this (an async worker, no ordering guarantee — ADR-0029). Mitigations, in D5 scope: a **first-run battery-optimization onboarding** flow, and a **server-side heartbeat / last-fix-age signal** so a silently-dead tracker is *visible* rather than mistaken for "vehicle parked."

### B. Outbox and flush

2. **A durable, SQLCipher-encrypted on-device outbox.** Buffer fixes in an **`expo-sqlite`** table in **WAL mode**, written synchronously-durable inside the location callback so a fix survives an app kill. The store is **SQLCipher-encrypted from the start** (the PO's data-posture decision) via `expo-sqlite`'s **`useSQLCipher` config-plugin flag** — an **in-place** option, *not* an `op-sqlite` library swap — with the encryption key held in `expo-secure-store`. Every outbox row is Tier-5 location data at rest on the device, and encryption is precisely the ADR-0027 c1 "encrypted at rest" control applied on the phone — so the on-device store is **built encrypted, never shipped plaintext and migrated later**. (SQLCipher needs CNG/prebuild, hence the custom build — ADR-0033 c7 — which D5 is past.) The client also **never logs coordinates** (the mobile mirror of ADR-0027 c5).
3. **A pure SyncManager flushes batches that match the existing contract byte-for-byte.** A SyncManager drains the outbox **oldest-first** in batches (≤1000, the existing cap), POSTs the **exact `{ pings: [...] }` shape** to `POST /api/v1/telematics/pings`, and marks rows **delivered on the 202**. Flush triggers: NetInfo back-online (`@react-native-community/netinfo`), app-foreground, trip-stop, and a timer. It coalesces concurrent flushes; retries with **exponential backoff + jitter, capped**; and **ages out / dead-letters** so a no-signal day cannot fill the disk. The flush/backoff/coalesce logic is **pure** (no device APIs), so the binary-free CI gate (ADR-0033 commitment 4) exercises the load-bearing offline behavior without a device.
4. **At-least-once delivery; no server-side dedup.** The ingest schema is **`.strict()` with no device or sequence field**, so adding a client idempotency key would (a) **400 against the contract** and (b) require a migration on the highest-row-count table + worker conflict-handling + a new device-identity concept that does not exist. **At-least-once is correct for a route trace** — a duplicate fix (from a crash after the POST but before the 202 is recorded) is harmless for route reconstruction. The ingest schema's own documented additive seam (a future batch-level `deviceId`) is noted but **not built**. If real duplicate volume ever proves harmful, server-side dedup is an **explicit amendment to ADR-0029's ingest contract** (governed by its own ADR), never a quiet feature PR.

### C. ADR-0027's two reserved questions, discharged (PO-confirmable at acceptance)

5. **Late-delivered on-trip pings: KEEP them.** ADR-0027's "Revisit when" #5 — the collection-scoping question commitment 2 reserved to this slice — asked us to settle "whether a queued ping captured at shift end but delivered later is in or out of scope … against this ADR's minimization intent rather than silently." **Decision: the minimization boundary is *capture* time, not *delivery* time.** The app only ever captures while a trip is active, so a fix captured on-trip but flushed after the trip ends (the offline buffer draining late) is **legitimately-collected data and is kept**. Dropping it would discard real route fidelity for **no** minimization gain — the data was already collected within the boundary; when it happens to upload changes nothing about how invasively it was gathered.
6. **Retention prune basis: the device-fix `timestamp`, not storage `createdAt`.** ADR-0029 T4 already prunes raw pings on the device-fix `timestamp`; this is the **no-change** option. The interaction that makes it a real decision (and that late delivery forces): a fix captured longer ago than the window but **delivered today** is inserted **already past retention**, and the next prune deletes it — possibly before it is ever read. **We accept this**, because minimization is about the **age of the location fix**: a 91-day-old fix is 91-day-old surveillance-grade data regardless of when it happened to arrive, so pruning it on arrival is the *correct* privacy posture, not a bug. (A device offline that long is rare; the operational lookback c3 sizes the window for is recent.)

### D. Background reliability and the named Plan B

7. **`expo-location` + the foreground service is v1; Transistorsoft is a Plan B with a pre-decided trigger.** The v1 capture stack is the Expo-native one (commitment 1). The paid, heavier **`react-native-background-geolocation` (Transistorsoft)** is named as the **Plan B**, adopted **only if** a D4/D5 pilot shows background-tracking gaps above an acceptable threshold on the target devices — a *decided* escape hatch behind pilot data, recorded so it is not an open-ended "maybe," not the default.
8. **The "telematics ping freshness" SLI — consume ADR-0026 c6's target, refine the window.** **ADR-0026 commitment 6** already named this indicator (first flagged in ADR-0011's "Revisit when") and set its **provisional 95.0% target**, deliberately below the 99.0% API SLO because ping delivery depends on third-party mobile-network conditions in mountainous Nepal. This ADR does **not** re-set that number; it **consumes the 95.0% target**, adds the device-side reason the sub-99 posture is doubly right — background reliability is partly **physics outside our control** (OEM battery-killers, Doze), not only cellular coverage — and **refines the measurement window** to "while a trip is active and the app is foregrounded," instrumented in D4/D5. The honest signal is "are fresh pings arriving while we can reasonably expect them," not "is every truck always live."

### Relationship to prior ADRs (what this consumes and discharges)

- **Consumes — does not re-decide — ADR-0027.** Tier 5, on-trip collection, native precision, short retention, and never-export are **citations**. Commitments 5 and 6 **discharge** its reserved c2 question (Revisit-when #5) and the prune-basis interaction, with the minimization-intent reasoning explicit, as ADR-0027 asked ("settle it … rather than silently").
- **Consumes ADR-0029.** The `{ pings: [...] }` `.strict()` batch contract is produced against **byte-for-byte** (commitment 3); commitment 4 explicitly **declines to amend** that contract (no dedup); ADR-0029's "Revisit when" (offline mechanics + the late-batch question) is settled here.
- **Builds on ADR-0033** (the encrypted store + background location need the custom build, commitment 7; the pure flush logic is exercised by the binary-free CI gate, commitment 4) and **ADR-0034** (`gps:ingest` is DRIVER-held; the producer authenticates with the bearer token).
- **Consumes ADR-0026.** Pings never enter a span (the scrub seam exists), and ping-freshness is a queue/job metric.
- **The ADR-0013 Phase-2 classification revisit the roadmap flags is light here:** ADR-0027 discharged the Tier-5 classification itself; the only new at-rest question — on-device encryption — is answered (encrypted from the start, commitment 2).
- **Is the driver-app slice** ADR-0027 c2 and ADR-0029 deferred their offline-mechanics and scoping questions to.
- **Is the PO-confirmation vehicle** for the producer's client architecture and the two policy discharges — no producer code is written until this ADR is accepted.
- **On acceptance**, the glossary gains **outbox / write-ahead queue**, **foreground service**, **SQLCipher**, and **NetInfo** entries; those updates land with the implementing slice.

## Alternatives considered

**`AsyncStorage` (or a plain key-value store) for the outbox.** Rejected (commitment 2): not transactional, no ordering guarantee, and weaker durability across restarts than SQLite WAL. A GPS outbox needs durable, ordered, transactional writes.

**WatermelonDB (or another sync-engine library) for the queue.** Rejected (commitment 2): it brings its **own** sync protocol, which would bend the existing batch backend to the client framework — a new pattern CLAUDE.md forbids when the server is already a batch endpoint. A plain batch-outbox → batch-flush composes with the existing contract at zero backend change.

**`op-sqlite` + SQLCipher as the encryption path.** Noted but not needed (commitment 2): `expo-sqlite` supports SQLCipher **in-place** via the `useSQLCipher` config-plugin flag, so staying on `expo-sqlite` is the lighter choice — no library swap. (This corrects an earlier "op-sqlite swap" framing.)

**Ship a plaintext on-device store now and encrypt later.** Rejected by the PO's data-posture decision (commitment 2): Tier-5 location data on a lost or stolen phone is a data-classification incident, and encrypting from the start is a config-plugin flag — there is no reason to ever ship it readable and migrate.

**Server-side dedup on a client idempotency key.** Rejected for the foundation (commitment 4): it breaks the `.strict()` contract, taxes the highest-volume table, and invents a device-identity concept that does not exist. At-least-once is fine for a route trace.

**Drop late-delivered on-trip pings.** Rejected (commitment 5): capture time is the minimization boundary, so a fix collected on-trip is legitimate; dropping it loses real route fidelity for no privacy gain.

**Prune on storage `createdAt`** (give every ping a full window from when it is stored). Rejected (commitment 6): minimization is about the **age of the fix**, not its arrival time; a long-buffered ancient fix is still surveillance-grade and should age out by its capture time.

**"Always stream" (track off-trip for simplicity).** Rejected (commitment 1): it violates ADR-0027 c2's on-trip-only minimization — the strongest privacy control FleetCo has on its most invasive collection.

**Transistorsoft as the v1 default.** Dispreferred (commitment 7): it is paid and heavier; `expo-location` + the foreground service is the v1, and Transistorsoft is the **triggered** Plan B behind pilot data.

## Consequences

### What this makes easier

The producer composes with the inert backend at **zero contract change** — a client batch-outbox mirrors the server's batch endpoint, so a flush is the existing 202 path. The encrypted outbox **closes the Tier-5 at-rest control on the device** rather than leaving a deviation to accept. The pure SyncManager logic is **fully CI-tested without a device** (ADR-0033 commitment 4). And the two long-reserved policy questions are settled in **one place** a future reader will find, with the reasoning recorded.

### What this makes harder

A durable, encrypted on-device store plus a flush state machine (backoff, coalesce, dead-letter, age-out) is real client complexity. Background reliability is **partly outside our control**, so gaps are expected and must be designed around rather than promised away. The server-side heartbeat / last-fix-age signal is a new backend signal to add. And SQLCipher couples D5 to the custom build (ADR-0033 commitment 7).

### Costs we accept

- **At-least-once means occasional duplicate fixes** in the raw trace — accepted, harmless for route reconstruction (commitment 4).
- **Best-effort tracking means gaps** on cheap Android phones — accepted, with the conservative SLI (commitment 8) and the Transistorsoft Plan B (commitment 7) as the named escalation.
- **A very-long-offline device may have ancient pings pruned on arrival** — accepted per the minimization posture (commitment 6).

## Revisit when

- **A D4/D5 pilot shows background gaps above the acceptable threshold** on the target devices — adopt the Transistorsoft Plan B (commitment 7).
- **Real duplicate-ping volume proves harmful** to route reconstruction or storage — revisit server-side dedup as an explicit **ADR-0029 ingest-contract amendment** (not a quiet PR) (commitment 4).
- **ADR-0027's 90-day window is finalized** against real operational lookback (ADR-0027's own "Revisit when") — re-confirm the prune basis (commitment 6) against the final number.
- **The aggregation-to-Tier-3-summary end-state is wanted** (ADR-0027 c3 / ADR-0029's "Revisit when") — the late-ping and prune-basis decisions interact with aggregation; re-confirm them then.
- **A Nepali regulatory change affects on-device retention or encryption of location data** (ADR-0027's regulatory "Revisit when") — revisit the on-device store's retention and encryption.
- **Acceptance fixes the open picks** — the late-ping (commitment 5) and prune-basis (commitment 6) discharges are the PO's to confirm; if the PO chooses differently, the slice follows and this ADR is annotated.
