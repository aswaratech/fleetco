# ADR-0041: Close the ADR-0025 pull-forward exception window — no new phase or pull-forward feature program until the first production deploy reaches daily use

- **Status:** Accepted (ratified by the PO authoring and merging PR #172 on 2026-07-02; flipped from Proposed in a follow-up docs commit, mirroring the ADR-0040 acceptance pattern)
- **Date:** 2026-07-02
- **Decider:** Product owner (CEO)

## Context

ADR-0025 opened Phase 2 ahead of the roadmap's "daily-use-before-next-phase" gate as an explicit **one-time** exception for the Phase-1 → Phase-2 transition, keeping the first production deploy a live, owed obligation and betting that the modular monolith would bound the risk of building ahead of a deploy.

Fourteen months of the project's own record show the exception did not stay one-time. Since ADR-0025, separately-decided pull-forwards have shipped **Phase-3 and Phase-4 scope** while Phase 1 has still never been deployed:

- engine-hours + preventive maintenance (ADR-0036 / ADR-0037),
- notification/reminder infrastructure (ADR-0038),
- customer VAT invoicing (ADR-0039 — the roadmap's Phase-4 "Money" headline), and
- a full design-system → app UX uplift (PRs #154–#168).

Meanwhile the deploy-dependent half of the gate is **0-of-7**: `deploy.yml` has zero runs, the deploy/rollback/restore runbooks are still `STATUS: DRAFT`, `docs/operations/dora-metrics.md` is a deploy-gated stub with no weekly entries, the ADR-0011 SLIs have no 28-day consumer, and the CEO's spreadsheets are unretired. A whole-project audit (2026-07-02) confirmed all of this and named the first production deploy the single highest-leverage next move.

This is the exact situation ADR-0025's own "Revisit when" flagged as an escalation trigger: *"The exception starts being stretched … any further override needs its own ADR"* and *"an undeployed Phase 1 carrying a built-out Phase 2 is a strong signal the original gate was right and the deploy must happen before Phase 2 goes further."* Each pull-forward was individually PO-authorized and self-documented (not silent drift), so nothing here is a discipline breach — but the cumulative pattern has turned a one-time exception into a de-facto operating norm, and a cold-start agent reading the ADR-0025 → 0036 → 0037 → 0038 → 0039 chain can reasonably read it as standing license to open a tenth. This ADR removes that reading.

## Decision

**Close the ADR-0025 pull-forward exception window. Until the first production deploy lands and Phase 1 reaches daily use, no new phase is opened and no new pull-forward feature program is started.** ADR-0025's decision to open Phase 2 stands as history; what this ADR ends is its forward license to keep pulling work forward. Four commitments:

1. **Nothing shipped is cancelled or reverted.** RBAC, GPS telematics, geofences, BS dates, maintenance, notifications, invoicing, and the UX uplift all remain on `main` as-is. This ADR governs *what starts next*, not what already merged.

2. **The one permitted feature stream is in-phase Phase-2 *completion*.** Finishing what Phase 2 already opened is allowed — specifically the driver-app GPS producer (D4–D6, ADR-0035), which is the missing piece that activates the already-built-but-inert ADR-0029/0030 telematics + geofence backend. Completing an open phase is not the same as opening a new one; starting Phase 3/4/5 *new* scope is not permitted under this window.

3. **Always-allowed work, unaffected by this window:** bug fixes, security and dependency hygiene, documentation and repo-memory repair, tech-debt paydown, test coverage, and — first and foremost — the deploy itself and its owed gate items (first deploy, restore-from-backup drill, runbook promotion, the first DORA entry, live SLO reporting). This window exists to *unblock* the deploy, not to freeze the work that supports it.

4. **Re-opening requires a new ADR, not a citation of ADR-0025.** Any further pull-forward, or opening a new phase before the gate is met, needs its own explicit PO-ratified ADR that argues the case afresh. ADR-0025 may no longer be cited as precedent for a new exception — its window is closed here.

## Alternatives considered

**Leave ADR-0025 standing (do nothing).** Rejected: the audit shows the "one-time" exception has become the norm, and the ADR chain reads as a standing license. Without an explicit close, the next session's default is to open another pull-forward rather than prioritize the deploy — the precise drift the gate exists to prevent.

**Hard-freeze *all* development, including Phase-2 completion, until the deploy.** Rejected: the driver app is in-phase Phase-2 work whose backend (T1–T5 telematics, G1–G5 geofences) is already built and sitting inert with no data producer; forbidding its completion would strand a large prior investment and forbid finishing the phase that is legitimately open. The line is new-scope vs. finishing-open-scope, not all-or-nothing.

**Repeal the roadmap's daily-use rule entirely.** Rejected for the same reason ADR-0025 rejected it: the rule is sound and protects every future transition. The problem is the *exception's* open-endedness, not the rule.

**A softer "please prioritize the deploy" note in CURRENT_PHASE.md rather than an ADR.** Rejected: the pull-forwards were each authorized by ADRs, so the counter-weight must carry the same authority and durability. A prose note is not a decision a future agent must honor; an ADR is.

## Consequences

**Easier.** A cold-start agent (or the autonomous loop) now reads an unambiguous stop-signal: finish the deploy before opening new scope. The deploy — the highest-leverage owed move — gets clear priority, and the DORA/SLO disciplines that only produce data post-deploy finally get their trigger.

**Harder / costs accepted.**

- **Some ready-to-build ideas wait.** New Phase-3/4/5 slices that could otherwise start now are deferred until the deploy. Accepted: their value is unrealized anyway until the system is in production, and building more undeployed code widens the "big-bang first deploy" risk the audit named.
- **The window depends on the operator.** The deploy is operator-led (VPS, DNS, secrets), so this window's end is not fully agent-controllable. Mitigation: commitment 3 keeps all deploy-supporting work flowing, so the agent side stays unblocked and the only thing gated is *new feature scope*.
- **Judgment calls at the margin.** "In-phase completion" vs "new scope" needs a judgment; commitment 2 fixes the concrete permitted stream (driver-app D4–D6) to minimize ambiguity, and commitment 4 routes anything genuinely uncertain to a new ADR.

## Revisit when

- **The first production deploy lands and Phase 1 reaches daily use** → this window has served its purpose; resume normal roadmap sequencing (a new phase may open once its predecessor is in daily use), and mark the ADR-0025 owed deploy items done.
- **The PO wants to start a specific new pull-forward before the deploy** → that is a fresh decision requiring its own ADR (commitment 4); this window does not pre-authorize it.
- **Driver-app D4–D6 completes** and no other in-phase Phase-2 work remains → the only permitted feature stream is exhausted; the deploy is then the sole remaining path forward and should not be deferred further.

## Relationship to prior ADRs

- **Closes the exception ADR-0025 opened** (the Phase-1 → Phase-2 pull-forward window). ADR-0025 is not superseded — its record of opening Phase 2 stands — but its forward license ends here, per its own "Revisit when" escalation triggers.
- **Re-asserts** the roadmap's "daily-use-before-next-phase" rule and CLAUDE.md's "do not work on items from later phases; surface the phase mismatch and ask."
- **Does not touch** any shipped feature ADR (0028–0040); those decisions and their code stand.

---

**Annotation (2026-07-02, append-only):** Commitment 4's mechanism was exercised the same day this ADR was ratified. The PO decided — with the risk surfaced explicitly and the audit's findings in hand — to open two new feature programs ahead of the deploy-reaches-daily-use gate: hardware GPS trackers + the live fleet map (**ADR-0042**) and the AI chat agent (**ADR-0043**). Each argues its case afresh in its own PO-ratified ADR, as this commitment requires; neither cites ADR-0025 as precedent. Mitigating fact recorded in ADR-0042: the tracker hardware needs a publicly reachable 24/7 endpoint, so **the first production deploy is ADR-0042's opening ticket (M1)** — the owed item this window exists to unblock rides in front of the new scope, not behind it.

**Annotation (2026-07-05, append-only):** Commitment 4 exercised a **third** time. The PO decided — with the deploy-first recommendation surfaced and declined — to open the agent conversational-data-entry program (**ADR-0044**, with companion **ADR-0045**) ahead of the still-owed first deploy: ask-when-missing prompting, registry completion, and image-based data entry. As with ADR-0042/0043, the new scope's production use remains gated on the M1 deploy; neither ADR cites ADR-0025 as precedent.

**Annotation (2026-07-08, append-only):** Commitment 4 exercised a **fourth** time. The PO decided — with the deploy-first recommendation surfaced and declined — to open the **WhatsApp agent channel** (**ADR-0046**): a Twilio inbound/outbound channel over the existing ADR-0043 chat agent (per-user verified phone links, `agent:use` unchanged, zero new dependency, text now plus receipt photos inheriting the paused image intake). As with ADR-0042/0043/0044, the new scope's production use remains gated on the M1 deploy — the inbound webhook needs a publicly reachable 24/7 HTTPS endpoint that only exists post-deploy, so the owed deploy still precedes the channel's first real message; ADR-0046 does not cite ADR-0025 as precedent.

**Annotation (2026-07-19, append-only):** Commitment 4 exercised a **sixth** time. The PO decided — with the deploy-first recommendation surfaced and declined — to open the **active-trips layer on the live map** (**ADR-0048**): a read-time composition of the shipped trips list and fleet-positions reads on the existing `/map` surface, zero new backend, production use M1-gated as ever. (Back-fill, same discipline: the **fifth** exercise — the **ADR-0047** trip-dispatch program, 2026-07-12 — was recorded in that ADR's §Phase mismatch and in `docs/CURRENT_PHASE.md` but never annotated here; this note repairs that gap so this ADR's annotation trail is the complete count.) Neither ADR cites ADR-0025 as precedent. With D4–D6 complete, this exercise was opened against this ADR's own third Revisit-when trigger ("the deploy is then the sole remaining path forward"); the PO's decision to take a sixth exception anyway is recorded in ADR-0048's §Phase mismatch, and the deploy remains the standing first recommendation.

**Annotation (2026-07-22, append-only):** Commitment 4 exercised a **seventh** time — and the first exercise *after the first production deploy landed* (2026-07-19, recorded in the 2026-07-13 DORA entry; the window's other closing condition, Phase-1 daily use, is days old and not yet established, so this route still applies). The PO decided — with the deploy-then-daily-use-first recommendation surfaced and declined — to open the **fleet documents & renewals program** (**ADR-0049**: FleetDocument storage on vehicles/drivers/customers through the pre-authorized `ObjectStorage` seam, RenewalRecord history with an atomic renew action, and a documents reminder source over the ADR-0038 scan), with the companion **ADR-0050** recording the staff-agreements + SUPERVISOR-role questions as open decision boxes (build-blocked until the PO resolves them). Mitigating facts recorded in ADR-0049's §Phase mismatch: production now exists, the paper-archive backfill is itself daily-use adoption, and the program is dominated by reuse of already-ratified seams. ADR-0049 does not cite ADR-0025 as precedent.
