# Phase 1 — The Spine — close-out

**Status: content-complete (2026-05-29), NOT yet in daily use.** This is the Phase-1 close-out record. For the detailed iteration-by-iteration narrative, see `../CURRENT_PHASE.md`; this document is the synthesis + handoff. For the forward plan, see `../product/roadmap.md`.

## Summary

Phase 1's goal (per the roadmap) was to replace spreadsheets and paper for daily fleet operations, web-admin-only, CEO as the sole user, built as a sequence of vertical slices (schema → migration → service → API → UI → test, ADR-0006). All eight planned aggregates shipped and merged to `main`, along with the cross-aggregate affordances that make them more than isolated CRUD. The build was driven largely by the autonomous orchestration loop (ADR-0022), with the operator salvaging and relaunching across the handful of agent halts described under "Process learnings."

**Phase 1 is content-complete but is not yet in daily use** — no production deploy has happened. Per the roadmap's "a phase is not done until it is in daily use" rule, the operational milestones below are the true remaining Phase-1 work and form the gate to Phase 2.

## What shipped (index)

| Aggregate / capability | Iters | Key capability |
|---|---|---|
| **Vehicles** | 1–4, 12, 14 | Full CRUD; list filter/sort/pagination; per-vehicle lifetime stats; Nepal compliance metadata (Bluebook / insurance / route-permit, nullable) |
| **Drivers** | 6–7, 13 | Full CRUD; per-driver lifetime stats; termination-transition rule |
| **Trips** | 8–11 | Full CRUD (the central aggregate); FK-Restrict → HTTP 409 delete-blocker; cross-slice "recent trips"; Trip→Vehicle odometer auto-update on COMPLETED |
| **Customers** | 15–16 | Full CRUD; PAN normalization + uniqueness (P2002 → 409, field-tagged); forward-compatible delete-blocker |
| **Jobs** | 17–18 | Full CRUD; server-generated `JOB-YYYY-NNNNN` (retry-on-collision); date-pair cross-field rule; live Customer delete-blocker + `/jobs?customerId=` deep-link |
| **Fuel logs** | 19–20 | Full CRUD; integer `litersMl` + paisa units; **derived** `totalCostPaisa`; trip-vehicle consistency check |
| **Expense logs** | 21–22 | Full CRUD; **nullable** `vehicleId` (vehicle-agnostic expenses); `ExpenseCategory` enum; **authoritative** `amountPaisa` (no derivation) |
| **Reports v1** | 23 | Read-only per-vehicle cost report (`GET /api/v1/reports/per-vehicle-cost`); merges Fuel + Expense paisa by vehicle; separate `companyLevel` block for vehicle-agnostic expenses |

API test suite at close-out: **545 passing**. Eight nav buttons on the gated home. See `../CURRENT_PHASE.md` for the per-iter detail and the exact error-mapping / immutability rules of each slice; see `../glossary.md` for the domain terms each slice introduced.

## How it was built

Most slices were delivered by the autonomous orchestration loop at `scripts/orchestration/` (ADR-0022): one agent session per iteration, one PR per slice, CI-green-before-merge, auto-extracted next-prompt seeding the following iteration. The operator observed via `pnpm tui` and Slack, and intervened only on halts. The loop's design and daily operation are documented in `../runbook/orchestration-loop-design.md` and `../runbook/orchestration-loop-operator-guide.md`.

## Process learnings (carry these forward)

The loop surfaced three recurring **agent** failure modes (distinct from loop bugs). They are now documented canonically in `../runbook/orchestration-loop-design.md` §"Known agent failure modes & kickoff hardening" and countered by sections baked into `scripts/orchestration/kickoff.md.template`. In brief:

1. **System-reminder misread** — an agent drafts a refusal to edit first-party code after Claude Code's prompt-injection reminder. Halted iters 12, 14, 21. Countered by a forceful "About Claude Code system reminders" kickoff section that **must be carried verbatim, never compressed** — iter 21 regressed precisely because a prior agent compressed it to one bullet.
2. **Plan-mode entry** — an agent enters plan mode, which waits forever for an `ExitPlanMode` approval no one is at the keyboard to give. Halted iters 12, 14. Countered by a "Do not enter plan mode" section.
3. **Next-prompt compression** — an agent compresses the next kickoff, dropping the hardening sections (which propagates failure 1). Countered by the loop's 4000-char length floor (`next_prompt_too_short`) and an explicit "carry verbatim" instruction.

**The salvage pattern that made halts cheap:** the kickoff mandates commit-early / push-after-every-checkpoint, so a halted agent has almost always already pushed its completed checkpoints. Recovery cost was ~one checkpoint (~30 min) each time: finish the in-flight checkpoint by hand, open the PR, relaunch with a kickoff carrying the **full** hardening sections.

One loop bug was found and fixed at the very end: the program-complete sentinel (`STOP — program complete`) was mislabeled `loop_error` because a length-floor check ran before the sentinel check (PR #52). The precedence is now sentinel-before-floor.

## Operational posture (honest)

Phase 1 built the *spine* (the data + admin surfaces). The *operating model* milestones the roadmap interleaves into Phase 1 are **not yet done**:

- [ ] **First production deploy** — not done. Fills `../runbook/deploy.md` + `rollback.md` (still stubs).
- [ ] **DORA metrics** — `../operations/dora-metrics.md` is still a deploy-gated stub; the first weekly entry appears the week the first deploy ships.
- [ ] **The two SLIs** (API availability, trip-creation success; ADR-0011) — not instrumented.
- [ ] **First restore-from-backup test** — not done. Fills `../runbook/restore-from-backup.md` (stub).
- [ ] **OpenTelemetry** in the API — not added.
- [ ] **Performance budget** (P95 < 500ms, P99 < 1500ms, admin FCP < 2s on Nepal 3G) — not committed/tracked.

## Carried tech-debt

Recorded in `../tech-debt.md`. Phase-1-specific items still open at close-out:

- **Fuel-log odometer-monotonicity check deferred** (iter 20) — decide + implement, or document the deliberate non-decision; best landed with trip-end-odometer reconciliation.
- **NPR money converters live in `fuel-logs-schema.ts`, not `lib/money.ts`** (iters 20/22) — relocate to the canonical money module.
- Plus the pre-Phase-1 items: `lucide-react` adoption, secret-scanning plan tier, BCP real values, and the two loop-tuning entries.

## The Phase-1 → Phase-2 gate

The roadmap is explicit: **we do not start a new phase until the previous one is in daily use.** Phase 2 is **Driver app and telematics** (per `../product/roadmap.md` — note an earlier `CURRENT_PHASE.md` draft misnamed it "Drivers payroll / Settlements"; that was agent drift, not an operator decision, and has been corrected). Before Phase 2 opens, this gate must be met:

- [ ] First production deploy shipped (deploy + rollback runbooks filled).
- [ ] First restore-from-backup test passed (restore runbook filled).
- [ ] The two ADR-0011 SLIs instrumented and reporting.
- [ ] OpenTelemetry in the API; performance budget committed and tracked.
- [ ] DORA metrics file has at least one real weekly entry.
- [ ] **The CEO is using FleetCo daily in place of spreadsheets** (the actual definition of "Phase 1 done").
- [ ] This retrospective reviewed by the operator.

When the gate is met, update `../CURRENT_PHASE.md` to declare Phase 2 active and open the next program.

## How to resume (cold start)

1. Read `../../CLAUDE.md` (operating manual) and `../CURRENT_PHASE.md` (status) first — this is the mandated session-start sequence.
2. The orchestration loop is **idle**. `git`-tracked work is the source of truth; the loop's `decisions.log` / `state.json` / `logs/` are gitignored runtime files from the last program.
3. To run more loop-driven work: write `scripts/orchestration/kickoff.md` from `scripts/orchestration/kickoff.md.template` (which now carries the hardening sections — keep them), then `cd scripts/orchestration && pnpm start`. Observe with `pnpm tui`.
4. **Do not open Phase 2 until the gate above is met.** The remaining Phase-1 work is operational (deploy, SLIs, restore test, OTel, perf budget) and operator-led — it needs credentials/infra and is not loop-driveable.
