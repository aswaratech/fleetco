# ADR-0049: Fleet documents and renewal records — the entity-documents program

- **Status:** Proposed (decisions taken interactively by the PO in the 2026-07-22 planning session — scope selected [vehicle compliance docs + driver documents + customer/driver agreements], renewal depth chosen [renewal records with history], and the supervisor request split into ADR-0050, each with alternatives surfaced; the PO merging this PR is the durable ratification — see §Phase mismatch. An agent must never self-accept this ADR, add an `## Acceptance` block, or flip the status — the PO ratifies separately, per the ADR-0038 rule.)
- **Date:** 2026-07-22
- **Decider:** Product owner (CEO)

## Context

FleetCo tracks compliance *metadata* but not the *papers*. Since Phase-1 iter 14 every Vehicle carries Bluebook / insurance / route-permit numbers and expiry dates; ADR-0031 gave them badges, ADR-0038 gave them a daily email reminder scan. But the documents those fields describe — the Bluebook scan, the insurance policy PDF, the route-permit papers, a driver's license and ID, and the agreement contracts FleetCo signs with customers and drivers — live in a drawer, not in the system. The PO's ask (2026-07-22): keep the fleet's documents in the system itself, and be informed about *every* such expiry in time — including agreements, which today have no representation at all.

Two adjacent gaps travel with that ask. First, **renewals leave no trace**: "renewing" a Bluebook today is a bare `PATCH /vehicles/:id` that overwrites the old expiry in place — no history of past policies, no link to the new paper, no link to what the renewal cost. Second, **only vehicle compliance fields remind**: an expiring customer agreement (or any document with a lifetime) is invisible to the ADR-0038 scan.

Every seam this program needs was deliberately pre-built. The `ObjectStorage` port (ADR-0039 c7) was explicitly pre-authorized to extend beyond invoice PDFs to "Bluebook scans, receipt images" as "a MOVE, not a rewrite", and ADR-0044 V2 promoted it to `apps/api/src/modules/storage/`. The agent-attachments pipeline (ADR-0044 c3) is a working multipart-upload template: magic-byte sniffing, 10 MB cap, object-first-row-second writes, owner-scoped streamed serving. The `NotificationLog` ledger stores `subjectType`/`reminderKind` as open strings precisely so a new reminder source wires in with no migration (ADR-0038 c5). And ADR-0044 explicitly *rejected* generalizing its attachment model because "entity-owned documents (a receipt pinned to a fuel log, a Bluebook scan on a vehicle) have entity lifetimes and belong to a future entity-documents program" — **this is that program**.

The PO also asked for staff agreement documents and a new SUPERVISOR role (admin-assigned vehicles + customers). Those touch the RBAC model and possibly a new Staff aggregate — cross-cutting decisions with their own open boxes — so they are split into the companion **ADR-0050** (Proposed alongside this ADR; built only after its own ratification). This ADR's document model is shaped so that extension is additive (§Revisit when).

## Decision

Build a **FleetDocument aggregate** (documents attached to vehicles, drivers, and customers, stored in R2 through the existing `ObjectStorage` seam) and a **RenewalRecord ledger** (an atomic "Renew" action per vehicle compliance item that snapshots old→new expiry and links the new paper and its cost), and extend the ADR-0038 reminder scan with a **documents source** so document expiries — agreements included — email like compliance ones.

The commitments:

1. **The FleetDocument aggregate** lives in a new `apps/api/src/modules/documents/` module. A document belongs to **exactly one** of Vehicle / Driver / Customer via three nullable FKs (`vehicleId` / `driverId` / `customerId`, all `onDelete: Restrict`), enforced at the service layer (no DB CHECK — §Alternatives). It carries a `DocumentCategory`, an operator-entered `title`, optional `notes`, an **optional `expiresAt`** (the reminder hook), and the storage columns: `r2Key` (unique, `documents/<entity>/<entityId>/<uuid>.<ext>`), the **sniffed** `contentType`, `sizeBytes`, and a `sha256` audit hash (not dedup). Every row carries `createdById`. Restrict FKs mean an entity with documents delete-blocks (P2003 → 409) through each entity service's existing arm — for free.

2. **The upload/serve contract** mirrors agent-attachments: multipart `file` field, 10 MB cap, magic-byte sniffing with the client's declared mimetype never trusted — now accepting **PDF (`%PDF-`) + JPEG + PNG + WEBP** via sniff helpers promoted to `apps/api/src/common/file-signatures.ts` (the agent module keeps its image-only allowlist and imports the same helpers — one sniffer, no fork drift). Writes are object-first-row-second with best-effort object delete on row failure; deletes are row-first with best-effort object delete. Bytes are served ONLY through an authenticated streaming endpoint (`GET /api/v1/documents/:id/content`, inline `StreamableFile`) proxied to the browser by a cookie-forwarding Next route handler — **no public URLs, ever**.

3. **The v1 entity × category matrix**, enforced with 400: VEHICLE `{BLUEBOOK, INSURANCE, ROUTE_PERMIT, AGREEMENT, OTHER}` · DRIVER `{LICENSE, ID_DOCUMENT, AGREEMENT, OTHER}` · CUSTOMER `{AGREEMENT, OTHER}`. The enum is `DocumentCategory` (`@@map("document_category")`) — deliberately NOT named `DocumentType`, which the invoice aggregate already owns.

4. **The RenewalRecord ledger** (in the vehicles module — renewals are Vehicle-aggregate writes). `POST /api/v1/vehicles/:id/renewals` executes in **one `$transaction`**: it snapshots `previousExpiresAt` **server-side from the vehicle row** (a pre-image the client can never fabricate — the first pre-image audit outside `AgentAction.previousJson`), creates the record (`kind` ∈ `{BLUEBOOK, INSURANCE, ROUTE_PERMIT}`, `newExpiresAt`, `renewedAt`, optional `notes`), and updates the vehicle's matching expiry + number fields (`bluebookNumber` / `insurer`+`insurancePolicyNumber`+`insuranceType` / `routePermitNumber`) in the same commit. Optional links, both `onDelete: Restrict` and service-validated: `documentId` → the new paper's FleetDocument (same vehicle, matching category) and `expenseLogId` → the renewal's cost (the ServiceRecord pattern verbatim: **link an existing ExpenseLog, never copy an amount, never create one inline**; same-vehicle + per-kind category check — INSURANCE→`{INSURANCE}`, ROUTE_PERMIT→`{PERMIT}`, BLUEBOOK→`{PERMIT, OTHER}`). Renewal records are **append-only in v1**; a wrong entry is corrected by renewing again with a note. No monotonicity guard on the new expiry — corrections are legitimate (the fuel-log odometer precedent). Reminders re-arm with zero notification-code change: a new expiry is a new `NotificationLog` `occurrenceKey`.

5. **The documents reminder source** (`apps/api/src/modules/notifications/documents-source.ts`): subjectType `DOCUMENT`, reminderKind = the document's category, state via the same shared `complianceBadgeState` (30-day window — the ADR-0038 c6 drift guard extended), occurrenceKey = the expiry ISO. **The exclusion rule is load-bearing:** vehicle-attached documents in categories `BLUEBOOK`/`INSURANCE`/`ROUTE_PERMIT` are SKIPPED by this source — the Vehicle's structured fields are canonical there and already scanned by the compliance source; without the exclusion one lapse emails twice, which is the "operator learns to ignore the channel" failure ADR-0038 exists to prevent. The digest gains a "Documents" block (ordered Compliance → Documents → Maintenance); a digest with no document items renders byte-identical to today's.

6. **Permissions:** `documents:read` and `documents:write` join the operational floor (ADMIN + OFFICE_STAFF — office staff already handle the same papers' Tier-2 metadata via `drivers:*`); **`documents:delete` is ADMIN-only** (deleting bytes irreversibly destroys compliance evidence — the `invoices:write` calculus). DRIVER holds none of the three in v1 (403 everywhere). Renewals ride the existing `vehicles:*` (office staff can already PATCH the same expiry fields today).

7. **Data classification (ADR-0013):** document **bytes are handled Tier 2** — never logged, never in spans, no public URLs, served only through the authed stream (and identity documents remain under the ADR-0044 local-only processing posture; this program does NOT hook documents into OCR/vision — §out of scope). The object key, size, hash, and content type are Tier 4. `title`/`notes`/`expiresAt` are Tier 3, with UI helper text warning against putting license/ID numbers in titles. Schema columns carry the `/// Tier N per ADR-0013` marks.

8. **Retention: none.** Entity documents live as long as their entity (the exact reason ADR-0044 deferred them out of its 180-day transcript regime). Deletes are human-only (no agent tool is added). The consequence is named: deleting a vehicle/driver/customer now requires deleting its documents first.

9. **Memory artifacts land with the program:** glossary entries (**Fleet document**, **Renewal record**), the DESIGN.md §Surfaces "Fleet documents & renewals" spec (the UI gate, in this same PR), the roadmap Phase-3 progress note, the CURRENT_PHASE as-of update, and the seventh ADR-0041 annotation. The build sequence is F2 (aggregate + API) → F3 (renewals) → F4 (documents UI) → F5 (renewals UI) → F6 (reminder source), one PR each; F6 may be pulled ahead of F4/F5.

**Out of scope, named:** Bishesh Anumati fields (not selected; stays on the roadmap), staff agreements + SUPERVISOR (ADR-0050), a global cross-entity documents page, OCR/vision extraction of uploaded documents (the ADR-0044 image-intake pause governs), agreement supersession links, driver-license renewal records (§Revisit when), per-document versioning, SMS.

## Alternatives considered

**A polymorphic `entityType` + `entityId` without real FKs.** One column pair covers any future entity, but it would be the repo's first referentially-unguarded relation: no Restrict delete-blockers, no P2003 → 409, orphanable rows. Rejected — the house delete-blocker pattern requires real FKs, and a fourth FK later is an additive migration.

**A DB CHECK constraint for exactly-one-FK.** Belt-and-braces, but there is zero CHECK precedent in the migrations, and every hand-authored migration re-verifies `prisma migrate diff --exit-code` shows only the four accepted PostGIS generated-column steps — a CHECK adds a permanent fifth drift entry to guard an invariant with a single writer (DocumentsService). Rejected; the service enforces it, tests pin it.

**Three per-entity document tables.** Clean FKs without nullables, but three of everything — module, endpoints, UI, reminder source — for one concept. Rejected.

**Reusing AgentAttachment.** It exists and uploads work, but its rows are conversation-owned (Cascade with the transcript) and pruned at 180 days — welding entity lifetimes to transcript retention is the exact mismatch ADR-0044 refused. Rejected.

**Creating the cost ExpenseLog inline from the renewal form.** One less click, but two writers for one financial ledger and a duplicated amount. The ServiceRecord cost-link is the recorded house answer. Rejected.

**A structured-field reminder source for `Driver.licenseExpiresAt` now.** The field exists, but it has no badge and no reminder today, and the ratified ask was documents; a license *scan* uploaded with `expiresAt` gets reminders through the documents source immediately. The full structured loop is a Revisit-when.

**Deploy-first (build nothing until daily use).** Surfaced as the standing recommendation and declined by the PO — §Phase mismatch.

## Consequences

**Easier.** The papers live where the operator looks — beside the vehicle, driver, or customer they belong to — and the proof-of-renewal trail (old expiry → new expiry → the paper → the cost) exists for the first time. Agreements finally remind. The paper-archive backfill is genuine daily-use adoption work on the now-live production system. Office staff can do document entry without being able to destroy evidence.

**Harder / costs accepted.** Entity deletes now require clearing documents first (the Restrict consequence — named, accepted). Office staff can upload but not delete; the UI copy must explain the asymmetry plainly. A third digest domain must keep §Voice. R2 becomes a precondition for document upload in production exactly as it is for invoice issue (the F0 env-template work documents it; dev uses the mock store). Pre-ratification build risk is zero — nothing in F2+ starts before this ADR merges.

## Revisit when

- **ADR-0050 ratifies** → add the staff/supervisor entity FK to FleetDocument (additive migration + one matrix row).
- **The PO wants the driver-license loop** (badge + structured-field reminder + a DRIVER_LICENSE renewal kind on Driver) → its own slice.
- **A cross-entity "expiring documents" list** is asked for (the per-entity sections + digest stop being enough) → a read-time page, no schema change.
- **Agreement supersession/versioning** is asked for (which paper replaced which) → a `supersededById` self-FK.
- **Document volume grows** past what a flat R2 bucket + entity lifetimes handle comfortably → R2 lifecycle rules / archive tiers.
- **Bishesh Anumati** is selected → the fourth compliance pair on Vehicle, its category here, and a compliance-source extension.

## Phase mismatch (ADR-0041 commitment 4, exercised — the seventh time)

The **first production deploy landed 2026-07-19** (the 2026-07-13 DORA entry records it: the Hostinger VPS bootstrap, the first encrypted backup, the passed restore drill). ADR-0041's window closes only when the deploy lands **and Phase 1 reaches daily use** — and daily use is days old, not established — so opening this program still goes through commitment 4: a fresh PO-ratified ADR arguing its case afresh, the mechanism's **seventh** exercise (after ADR-0042/0043 · 0044/0045 · 0046 · 0047 · 0048). The deploy-first-then-daily-use recommendation was surfaced in the 2026-07-22 planning conversation and declined by the PO.

The case afresh: (a) the program is dominated by **reuse of already-ratified seams** — the storage port pre-authorized for exactly this ("a MOVE, not a rewrite", ADR-0039 c7), the upload pipeline, the reminder ledger designed for new sources; (b) unlike every prior exception, production now **exists** — scanning and uploading the paper archive is itself daily-use adoption of the deployed system, not more undeployed code; (c) the reminder half of the PO's ask is already built and needs only the F0 activation config plus operator DNS work — this program closes the remaining, genuinely-missing half; (d) production use of uploads needs only the operator's R2 config (now documented in the env template), not a new deploy. The PO merging this PR is the ratification; the seventh append-only annotation on ADR-0041 lands in the same PR.

## Relationship to prior ADRs

- **ADR-0041** — commitment 4 exercised (seventh); annotation appended in this PR.
- **ADR-0039 c7 / ADR-0044 V2** — consumes the promoted `ObjectStorage` seam as its third consumer, the extension those ADRs pre-authorized.
- **ADR-0044** — builds the "future entity-documents program" it named, honoring its entity-lifetime/no-transcript-retention boundary and its image-intake pause (no OCR hookup here).
- **ADR-0038** — extends the reminder scan with a third source through the string-keyed `NotificationLog` exactly as its c5 anticipated; the shared-classifier drift guard (c6) extends to documents.
- **ADR-0031** — reuses `complianceBadgeState` untouched for document-expiry badges and states.
- **ADR-0037** — the RenewalRecord↔ExpenseLog cost link copies the ServiceRecord pattern.
- **ADR-0013** — document bytes handled Tier 2; metadata tiers marked in-schema.
- **ADR-0028/0034** — three new capability tokens on the existing map; no role changes (SUPERVISOR is ADR-0050's question).
- **ADR-0050** — the companion Proposed decision for staff agreements + the supervisor role; nothing here depends on it.
