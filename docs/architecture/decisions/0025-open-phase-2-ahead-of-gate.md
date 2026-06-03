# ADR-0025: Open Phase 2 (driver app + telematics) ahead of the daily-use gate

- **Status:** Accepted
- **Date:** 2026-06-03
- **Decider:** Product owner (CEO)

## Context

Phase 1 ("The Spine") is content-complete and `main` is green: all eight aggregates shipped (Vehicles, Drivers, Customers, Jobs, Trips, Fuel logs, Expense logs, Reports v1), the agent-driveable half of the Phase-1 → Phase-2 gate is done (OpenTelemetry per ADR-0024, both ADR-0011 SLIs, the performance budget, the ADR-0014 deployment decision plus hardened DRAFT deploy/rollback/restore runbooks), and 567 API + 9 web tests pass. See `docs/CURRENT_PHASE.md`.

What Phase 1 does **not** yet have is a production deployment. The roadmap planned the first deploy to happen *early* in Phase 1 — "The first production deploy happens before Trip is built (probably during the Vehicles slice)" (`docs/product/roadmap.md` §"Phase 1") — precisely so that deploying early and often would make the DORA targets (ADR-0010) achievable. That did not happen: the slices were built first, the deploy slipped to the end of the phase, and it has since been deliberately deferred further by the operator. So the **deploy-dependent half** of the Phase-1 exit gate remains open: first production deploy, restore-from-backup drill, live 28-day SLI/FCP reporting, the first real weekly DORA entry, daily CEO use, and the Phase-1 retrospective sign-off.

The roadmap states a firm sequencing rule (`docs/product/roadmap.md`, opening paragraph):

> "We do not start a new phase until the previous one is in daily use, because half-built phases produce technical debt and operational confusion that compound."

CLAUDE.md reinforces it: "You must not work on items from later phases; if you encounter scope that belongs to a later phase, surface the phase mismatch and ask." Under that rule, Phase 2 (driver app, telematics, office-staff RBAC) is closed until Phase 1 is in daily use — which requires the deploy.

The product owner has decided to begin Phase 2 product development now, in parallel with the still-pending deploy, rather than block all forward product motion on an operator-led deploy whose timing is uncertain. Because that directly overrides a standing roadmap rule, the override must be a recorded, deliberate decision — this ADR — rather than undocumented drift, which is exactly the failure mode the gate exists to prevent.

## Decision

**Open Phase 2 ahead of the daily-use gate, as a documented, one-time exception to the roadmap's "daily-use-before-next-phase" rule that applies to the Phase-1 → Phase-2 transition only.** The rule itself is not repealed; it remains the default for every future phase transition. The exception is scoped, bounded by the parallel deploy track below, and recorded here so a future reader sees a decision, not a lapse.

Three commitments define the shape:

1. **The deferred deploy stays a live, owed obligation — de-sequenced, not cancelled.** Phase 1 still owes, and this ADR keeps on the books: the first production deploy (ADR-0014), the restore-from-backup drill, live 28-day SLI/FCP reporting, the first real weekly DORA entry, daily CEO use replacing spreadsheets, and the Phase-1 retrospective sign-off (`docs/retrospectives/phase-1.md`). Phase-2 work proceeds *alongside* these, not instead of them. The DORA and error-budget disciplines (ADR-0010, ADR-0011) accrue real data only once the deploy lands, so until then Phase 2 is built without production telemetry — an accepted risk (see Consequences).

2. **Phase 2 opens with decisions, not feature code.** The roadmap names architectural prerequisites that must be settled before the driver app or telematics ingestion is built. The proposed opening sequence:
   - **ADR-0026 — Phase-2 observability upgrade**: logs-only → logs+traces+metrics, choose one externally-hosted backend (SigNoz / Honeycomb / Datadog free tier per the roadmap), and put distributed tracing across the driver app, the BullMQ telematics workers, and R2 media uploads. The Phase-1 OTel work (env-gated OTLP exporter, no backend — ADR-0024) was built to be exactly this foundation.
   - **ADR-0027 — data-classification amendment**: revisit ADR-0013 because GPS traces are sensitive personally-identifying data; expect tighter retention and possibly an additional tier. Must precede any GPS schema so the new tier shapes how pings are stored and excluded from logs.
   - **RBAC foundation slice**: introduce the office-staff user role with basic role-based access control. The glossary already names the session model as the RBAC attach point and records RBAC as "deferred until Phase 2" (`docs/glossary.md`). Pure backend code, no hardware dependency, so it can land early and in parallel.
   - **GPS-ping + BullMQ schema-foundation slice**: a first telematics aggregate with PostGIS point geometry (the `postgis` extension is already enabled in the baseline migration — `apps/api/prisma/schema.prisma` — as Phase-2 scaffolding per ADR-0014), plus the BullMQ queue that ingests pings. The codebase anticipates this: `apps/api/src/modules/trips/trips.controller.ts` and `trips.service.ts` already carry comments that the fuel-log/GPS-ping aggregates "will reference Trip" in Phase 2.

   **Proposed first feature slice: the RBAC foundation.** It is the lowest-risk start — pure backend code, no external-vendor choice (unlike observability), and no new sensitive-data tier to settle first (unlike GPS) — and it unblocks the multi-user surfaces the driver app and the later manager view (Phase 5) depend on. ADR-0026 and ADR-0027 are decisions that can be drafted in parallel without blocking the RBAC code.

3. **`docs/product/roadmap.md` and `docs/CURRENT_PHASE.md` are updated to reflect the open exception only once this ADR is accepted** — not before. Merging this ADR while it is still `Proposed` records the proposal; the PO flipping Status → Accepted is what actually opens Phase 2.

## Alternatives considered

**Respect the gate — finish the deploy and reach daily use first (the disciplined default).** What the roadmap prescribes, and the lowest-risk path: Phase 1 proven in production with real telemetry, then Phase 2 built on solid ground. Rejected by the PO on schedule grounds — the deploy is operator-led with uncertain timing, and blocking all product progress on it indefinitely is judged a worse trade than the parallel-track risk. This ADR exists precisely because we are *not* taking the default and want the deviation recorded.

**Deploy first, then Phase 2, with no parallelism.** A middle path: don't override the gate, just make the deploy the immediate next work so the gate is met soon. Rejected because the operator has already deferred the deploy; in practice this is the same block as the default.

**A narrower "Phase-2 prep only" exception** — allow Phase-2 ADRs and design docs but no feature code until the deploy. Rejected as half-measure: it would permit ADR-0026/0027 but stall the RBAC and schema slices, which are most of the actual progress; the PO wants real forward motion, so the honest move is to open the phase, not half-open it.

**Repeal the roadmap rule globally** (drop "daily-use-before-next-phase" entirely). Rejected — the rule is sound and protects every future transition; the issue is this one transition's timing, so a scoped one-time exception is the right instrument, not repealing the rule.

## Consequences

**Easier.** Product development continues without waiting on an operator-led deploy of uncertain timing; momentum is preserved, and the codebase's existing Phase-2 forward hooks (the Trip-referencing comments, the enabled PostGIS extension, the session-as-RBAC-attach-point) get used while they are fresh.

**Harder / costs accepted.**

- **Phase 2 is built without production telemetry.** Until the deploy lands there is no live SLI/DORA/error-budget data, so Phase-2 architecture decisions — especially the observability backend in ADR-0026 — are made against assumptions rather than measured load. Accepted; ADR-0026 should be revisited once real data exists.
- **Phase-1 production bugs surface later and may be obscured by Phase-2 churn.** A bug that a real deploy + daily use would have caught early instead surfaces after Phase-2 code is layered on top, making it harder to isolate. This is the precise "half-built phases produce technical debt and operational confusion that compound" cost the gate warns about; we are knowingly accepting a bounded version of it.
- **The deploy must not be forgotten.** The biggest risk is that "open Phase 2" quietly becomes "abandon the deploy." Mitigation: the owed deploy items are listed in the Decision above and remain tracked in `docs/CURRENT_PHASE.md` and `docs/retrospectives/phase-1.md`; the "Revisit when" below makes the deploy a reopening trigger.
- **The modular monolith limits blast radius.** Because FleetCo is one deployable with enforced module boundaries (ADR-0001), Phase-2 code added now does not destabilize Phase-1 surfaces the way a distributed change would — part of why the risk is judged acceptable.

## Revisit when

- **The first production deploy lands and Phase 1 reaches daily use** → the exception has served its purpose; fold Phase 1 back onto the normal gate, mark the owed deploy items done, and resume standard sequencing for Phase 2 → Phase 3.
- **A Phase-1 production bug appears that Phase-2 work made harder to isolate** → the accepted parallel-track risk has materialized; pause new Phase-2 feature work, prioritize the deploy + stabilization, and reassess whether the exception was worth it.
- **The exception starts being stretched** — e.g., someone cites this ADR to skip the daily-use gate for the Phase-2 → Phase-3 transition → out of scope here; this exception is for the Phase-1 → Phase-2 transition only, and any further override needs its own ADR.
- **The deploy stays undone long enough that Phase 2 ships meaningful user-facing features against an unproven Phase 1** → escalate: an undeployed Phase 1 carrying a built-out Phase 2 is a strong signal the original gate was right and the deploy must happen before Phase 2 goes further.
