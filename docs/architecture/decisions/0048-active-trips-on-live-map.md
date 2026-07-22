# ADR-0048: Active trips on the admin live map — a read-time layer over the ADR-0047 trips and ADR-0042 positions reads

- **Status:** Accepted (ratified by the PO merging PR #242 on 2026-07-19 — the durable ratification this ADR's Proposed form named; flipped from Proposed in a follow-up docs commit per the ADR-0040/0041 acceptance pattern. The underlying decisions — governance form, status set, pin behavior, route-line deferral — were taken interactively by the PO in the 2026-07-19 planning session with alternatives surfaced; see §Phase mismatch.)
- **Date:** 2026-07-19
- **Decider:** Product owner (CEO)

## Context

The PO wants admins to **see active trips on the live map**, not just vehicle positions. The `/map` surface (ADR-0042 M9) answers "where is the fleet right now" — one latest fix per vehicle, fix-age honesty, the DEPOT yard — but carries **no trip concept**: an admin asking "where are my dispatched loads?" must cross-reference the trips list by hand. Since ADR-0047 shipped dispatch, the data to answer that question exists on already-sanctioned wires: the trips list (`trips:*`) carries status (`OFFERED`/`ACCEPTED`/`IN_PROGRESS` among them), the assigned vehicle and driver, and the pickup/drop-off `Site` pins (Tier-3 by the recorded `LIST_SELECT` decision); the fleet positions feed (`gps:read-derived`) carries each vehicle's latest fix. What is missing is purely the **composition** — joining the two by `Trip.vehicleId` on the map surface.

Two governing texts required this decision to be its own ADR rather than a silent UI change. **ADR-0041** closed the pull-forward window; with the D4–D6 stream complete its "Revisit when" names this exact trigger — "the PO wants to start a specific new pull-forward before the deploy → a fresh decision requiring its own ADR (commitment 4)." And **ADR-0042** affirmatively scoped `/map` as trip-less: c10 defines the surface as vehicle markers + fix age + yard, c8 keeps `tripId` null on hardware pings with trip-correlation "a later derived feature," and its Revisit-when routes trip-correlation to "its own design." The Home-dashboard precedent (UI recomposition of sanctioned reads ⇒ a DESIGN.md section, no ADR) does not control here, because the target surface's own governing texts negate trips; the DESIGN.md-only path was surfaced to the PO and declined in favor of this short ADR — the sixth commitment-4 exercise.

## Decision

Add a **read-time active-trips layer** to the existing `/map` page, composed entirely from the two shipped reads. Six commitments:

1. **The layer is a read-time join, client-composed.** `/map` fetches `GET /api/v1/trips?status=OFFERED,ACCEPTED,IN_PROGRESS` (the existing CSV multi-status filter) beside the positions feed it already polls, and joins the two by `Trip.vehicleId` in a pure, unit-tested web helper. **"Active" on the map = `OFFERED` + `ACCEPTED` + `IN_PROGRESS`** — every dispatched, non-terminal trip (the PO's pick over IN_PROGRESS-only): a dispatched-but-unmoved truck is exactly what the glance is for. The Home dashboard's narrower "active = IN_PROGRESS" usage is unchanged; the glossary's **Active trip** entry records both so they cannot drift silently. Status is distinguished by the existing ADR-0047 badge vocabulary (`OFFERED` → warning, `ACCEPTED` → info, `IN_PROGRESS` → success); since no DB uniqueness guarantees one active trip per vehicle, the per-vehicle attribution is a deterministic pure rule (rank `IN_PROGRESS` > `ACCEPTED` > `OFFERED`, tie-break newest `startedAt ?? acceptedAt ?? offeredAt ?? createdAt`, then `id`) with the sidebar listing ALL active trips regardless — the uniqueness gap is a named tech-debt entry.

2. **Zero new backend.** No schema change, no migration, no new or changed endpoint, no new capability, no new dependency, no new design token. The audience stays **ADMIN + OFFICE_STAFF** because the combined picture requires passing BOTH existing gates endpoint-by-endpoint (`trips:*` AND `gps:read-derived` — a DRIVER can never assemble the fleet picture; `positions/latest` 403s them). The rejected-for-v1 alternative — a telematics-owned joined endpoint (`?include=activeTrip`, importing `TripsService` through its public interface per the G5 precedent) — is recorded below as the named scaling path.

3. **`GpsPing.tripId` stays null.** This layer does NOT build ADR-0042 c8's deferred ping-level trip-correlation; trip identity is derived at read time from `Trip.vehicleId` + status, and the deferral (now registered in `docs/tech-debt.md`) stays owed. ADR-0042 carries a dated annotation saying so.

4. **Egress discipline is unchanged, and the layer strips before it renders.** The positions wire is untouched (one latest fix per vehicle, server-computed `fixAgeSeconds`, never the geometry column, **never trails**); no route polylines on the fleet map in v1 (the PO's deferral — the trip detail page already draws the route preview one click away, and fleet-wide `route-preview` calls would add per-trip coordinate egress to the routing provider). The trips wire is the existing sanctioned list payload to the same roles, but the map needs none of its Tier-2 content: the consignee fields (`consigneeName`/`consigneePhone`) and order detail (`specialInstructions`/`docketNumber`/`materialNote`) are **stripped by the projection helper before the map island's props/state**, pinned by a unit test. Pickup/drop-off `Site` pins are Tier-3 (the `LIST_SELECT` recorded decision) and render **always-on** for every active trip (the PO's pick over selection-gated), deduped by site, with name tooltips. Marker **hue stays fix-age only** (ADR-0042's honesty rule — never repurposed for status); trip-ness rides a status-agnostic ring plus the badges. Nothing new enters URLs, client logging, server logs, or spans.

5. **Refresh: a second, slower poll.** Trips poll at **60 s** beside the existing 20 s positions poll, both visibility-paused; a failed trips poll keeps the last layer without blanking the map. The honest consequence — the trip layer can lag reality by up to one 60 s tick (a just-completed trip may badge its vehicle for that long) — is stated in the DESIGN.md Refresh bullet, not hidden. 60 s is a named constant; cadence is a Revisit-when, not an invariant.

6. **The DESIGN.md amendment precedes the code.** Per the house UI-surface gate, the §Surfaces "Live map" amendment (this PR) specifies the layer — statuses + badges, the on-trip ring, always-on pins, the sidebar section, the popup trip line with its two-context link ruling, refresh, empty states, privacy — before the implementing slice starts.

## Alternatives considered

**Defer until after the M1 deploy (the standing ADR-0041 recommendation).** Surfaced and declined by the PO, as with the five prior exercises. Mitigating facts: this is a read-side recomposition of shipped, sanctioned reads — the cheapest possible feature class — and its production use is M1-gated anyway.

**A DESIGN.md-section-only gate (the Home-dashboard precedent).** Surfaced and declined: the dashboard composed sanctioned reads into a surface no ADR had negated, whereas ADR-0042's own text scopes trips OUT of `/map` and reserves the topic for its own design. Honoring the repo's episodic memory means writing that design — this document.

**A telematics-owned joined endpoint** (`GET /telematics/positions/latest?include=activeTrip`, importing `TripsService` per the G5 public-interface precedent). Rejected for v1: two client fetches compose the same picture with zero new backend surface, and the take=200 trips ceiling is far above this fleet's concurrent-trip count. Recorded as the **named scaling path** if active trips ever exceed the cap or an atomic snapshot is required.

**IN_PROGRESS-only "active".** Rejected by the PO: a dispatched truck that never started moving is precisely the exception the map glance should surface.

**Selection-gated site pins.** Rejected by the PO in favor of always-on pins (deduped by site); a layer toggle is the deferred middle path if pin clutter grows with the fleet.

**A route polyline for active trips via `POST /routing/route-preview`.** Deferred by the PO: per-trip coordinate egress to the routing provider from a fleet-wide surface plus per-call cost, for information the trip detail page already renders.

**A separate trips-map page.** Rejected: the ask is "in the map view as well" — one fleet surface, not two half-maps.

## Consequences

**Easier.** The dispatch investment (ADR-0047) becomes observable at fleet scale — the same shape as ADR-0042's map-makes-telematics-observable case; the admin's "where are my loads" question is answered on the surface they already watch; the slice is fully synthetic-data-testable and touches only `apps/web`.

**Harder / costs accepted.** A second client poll on `/map` (trivial at 1–2 operator tabs, but the DESIGN.md "must not hammer the API or the OSM tiles" language must stay true). Tier-2 consignee fields transit the browser on the (already-sanctioned) trips wire even though the map never renders them — the lean joined endpoint is the recorded alternative if the PO ever wants zero PII on this path. Always-on pins raise marker density on busy dispatch days — accepted at this fleet's scale, with the layer toggle as the named refinement. One more built-before-deployed surface widens the ADR-0041-flagged gap — accepted by the PO with the deploy-first recommendation declined, and production use M1-gated as ever.

## Revisit when

- **Concurrent active trips approach the take=200 ceiling** → build the joined telematics endpoint (the named scaling path).
- **Ping-level trip-correlation is wanted** (auto-linking `GpsPing.tripId`) → its own design, per ADR-0042's unchanged Revisit-when.
- **Route lines on the fleet map are wanted** → a deliberate decision weighing routing-provider coordinate egress + cost (the trip-detail preview's seam is ready).
- **60 s proves too slow** for dispatch reality (operator feedback) → cadence revisit; an SSE/realtime channel remains own-ADR territory (ADR-0042).
- **Pin clutter bites** as the fleet grows → the layer toggle.

## Phase mismatch (ADR-0041 commitment 4, exercised — the sixth time)

This is new feature scope opened before the first deploy reaches daily use — the sixth exercise of ADR-0041 commitment 4 (after ADR-0042, ADR-0043, ADR-0044/0045, ADR-0046, and ADR-0047). The PO chose to open it with the deploy-first recommendation surfaced and **declined**; this section is the fresh argument commitment 4 requires. The case, argued afresh: (a) it is a **read-side recomposition of already-shipped, already-sanctioned reads** — no schema, no endpoint, no capability, no dependency — the smallest feature class the register has yet gated; (b) it makes the ADR-0047 dispatch investment **observable fleet-wide**, the same completes-the-loop shape ADR-0042 argued for the map itself; (c) it is fully synthetic-data-testable in `apps/web` alone and neither blocks nor displaces the operator-led deploy; (d) **all production use gates on M1** like every prior exception. ADR-0025 is not cited as precedent.

## Relationship to prior ADRs

- **ADR-0041** — a commitment-4 fresh-ADR exception; the window otherwise stands. ADR-0041 carries a dated annotation pointing here (and back-filling the un-annotated fifth exercise, ADR-0047).
- **ADR-0042** — amended in one respect: c10's `/map` scope gains the active-trips layer. The one-fix-per-vehicle / never-trails invariant, the fix-age honesty rule, the 20 s positions poll, and c8's null-`tripId` posture are all intact; the c8/Revisit-when ping-correlation deferral is **not** discharged. ADR-0042 carries a dated annotation.
- **ADR-0047** — consumed unchanged: the trips list projection (status, vehicle, driver, site pins, milestone timestamps) is read as shipped; no dispatch behavior changes.
- **ADR-0027** — honored: c6's anti-circumvention rule (derived surfaces must not reconstruct the raw trail) is why the layer renders one fix + fixed Tier-3 site pins and never trails or route lines.
- **ADR-0013 (as amended by ADR-0047 c6)** — honored: consignee Tier-2 fields never reach the map island, logs, spans, or URLs.
