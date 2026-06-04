# ADR-0031: Bikram Sambat date rendering and vehicle-compliance status badges — the conversion library, the format contract, the shared formatter/component, the centralization rollout, and the badge threshold

- **Status:** Accepted
- **Date:** 2026-06-04
- **Decider:** Product owner (CEO)
- **Accepted:** 2026-06-04

## Acceptance

Accepted by the product owner (CEO) on 2026-06-04, ratifying the three owner-level picks (the rest are the ADR's recorded recommendations):

- **Conversion approach (commitment 1):** a **verified, maintained npm library** for AD↔BS conversion, NOT an in-tree conversion table — because these dates sit on compliance documents and almanac correctness matters more than avoiding a dependency. The ADR's specific package recommendation is `nepali-date-converter`.
- **Expiring-soon threshold (commitment 5):** a **30-day** window — an amber "Expiring soon" badge within 30 days of a compliance document's expiry, a red "Expired" badge once past.
- **v1 scope (commitment 6):** **display + badges only** — centralize BS rendering everywhere dates are *shown*, plus the compliance badges. Date *inputs* stay native AD (the BS date-picker widget is a named follow-up); compliance reminder *delivery* (email/SMS) is Phase 3 and excluded.

The glossary (a *Bikram Sambat* / *NepaliDate* pointer to this ADR) and `docs/CURRENT_PHASE.md` update **with the implementing code slices**, not this acceptance — per the "Relationship to prior ADRs" note.

## Context

FleetCo stores dates as ISO/UTC and, per CLAUDE.md, "renders Bikram Sambat for Nepali users where appropriate." Two deferred Phase-1 (iter 14) items now block genuine daily use by the Nepali CEO: dates render as raw Gregorian `YYYY-MM-DD` (a Nepali operator thinks in BS), and the vehicle-compliance expiry dates (`bluebookExpiresAt`, `insuranceExpiresAt`, `routePermitExpiresAt`) are shown as plain dates with no warning when one is lapsing. Both were explicitly deferred "to their own slices."

The repo has already done the design thinking. **DESIGN.md §"BS calendar"** fixes the `<NepaliDate>` contract — "a `<NepaliDate>` React component renders both BS and Gregorian values from a single ISO date," default `"2082 Jestha 6 (2026-05-20)"` (BS prominent in **Latin transliteration**, Gregorian parenthetical in `color.text.muted`), storage stays ISO/UTC ("BS is a render-time conversion only… never store BS as a string"), and anti-pattern #12 forbids fabricated BS conversions. **DESIGN.md §Data display** fixes the prop: `<NepaliDate iso="2026-05-20" format="bs|en|both" />`, default `both`. And critically, DESIGN.md §"BS calendar" says the **"library choice [is] deferred… A Phase 1 ADR will pick the conversion library."** This is that ADR. **DESIGN.md §"Status badges"** fixes the badge spec: `<Badge variant="…">`, amber = expiring-soon/warning, red = error, "always pair the hue with a text label; never hue-only" — with the `color.status.warning` (amber-500) and `color.status.error` (red-600) tokens already in DESIGN.md and `globals.css` `@theme`.

This ADR **decides shape and policy only** — it writes no code, adds no dependency, and edits no DESIGN.md contract (DESIGN.md already specifies what to build). The code program that consumes it adds the dependency, the formatter, the component, the rollout, and the badge.

The substrate constrains the choices:

- **The formatter-lib pattern** (`apps/web/src/lib/money.ts` `formatNpr`, `apps/web/src/lib/units.ts` `formatLiters`/`formatKm`) is the canonical "display-only formatter" shape this mirrors: a module-level formatter, the em-dash `—` for null/undefined/invalid, JSDoc with worked examples, "display helper; never round-trip." `<NepaliDate>` is to `formatNepaliDate` what `<Money>` is to `formatNpr` — a thin markup wrapper over a pure function.
- **The inline `formatDate` copies.** Every web page carries its own `formatDate(iso)` returning the UTC calendar day (`getUTCFullYear/getUTCMonth/getUTCDate`) as `YYYY-MM-DD`, em-dash on null. There are ~15 such copies, several already commented "BS-calendar rendering arrives with the future `<NepaliDate>` component." Centralizing them is the rollout.
- **Pages are server components.** The BS conversion runs in **Node during SSR**, so the library must be pure-JS/Node-safe (no `window`/DOM) — which rules out browser-coupled datepicker libraries for this slice.
- **The compliance data** lives on `model Vehicle` (`bluebookExpiresAt`/`insuranceExpiresAt`/`routePermitExpiresAt`, nullable `DateTime`, Tier 3), rendered today in the Vehicle detail "Compliance" `<section>` (`apps/web/src/app/vehicles/[id]/page.tsx`) via `<DetailRow value={formatDate(...)} />`.
- **No `Badge` component exists yet.** The CVA pattern is in `apps/web/src/components/ui/button.tsx`; the design-token-drift test (`apps/web/test/design-token-drift.test.ts`) asserts only DESIGN.md→`@theme`, so a Badge that consumes the *existing* status tokens cannot trip it.
- **The phase boundary.** `docs/product/roadmap.md` §"Phase 3" owns compliance reminder *delivery* (email/SMS) and the "reminder delivery" SLI. This slice ships the **visual badge only** — a passive indicator the operator sees on a page they already open — not any notification, cron, or queue.

## Decision

**Adopt `nepali-date-converter` as FleetCo's verified AD↔BS conversion source (pinned and verified Node/SSR-safe at install); render every shown date through a single `apps/web/src/lib/nepali-date.ts` formatter (`formatNepaliDate(iso, opts?)`) wrapped by a thin `<NepaliDate iso={…} format=… />` server component that emits BS-prominent Latin transliteration plus a muted Gregorian parenthetical exactly as DESIGN.md's `"2082 Jestha 6 (2026-05-20)"` specifies, converting the same UTC calendar day the existing inline formatters use; replace the ~15 inline per-page `formatDate` copies on date-only display fields while leaving date-time/audit timestamps and all date inputs on native AD; and add a shadcn `Badge` plus a pure `complianceBadgeState(expiryIso, now, windowDays = 30)` helper that paints an amber "Expiring soon" badge within 30 days of expiry and a red "Expired" badge past it, surfaced per-document in the Vehicle detail Compliance section — shipping the visual badge only, with the BS date-picker input widget and all compliance reminder delivery (the Phase-3 "reminder delivery" SLI) explicitly out of scope.** Seven commitments.

### A. The conversion library

1. **Library: `nepali-date-converter` (recommended); `bikram-sambat` is the runner-up.** *(The library-*approach* — a verified library over an in-tree table — is the PO's owner-level pick; the specific package is this ADR's recommendation.)* It is pure-JS (runs in a Node server component, unlike a browser-coupled datepicker), ships TypeScript types, converts both directions (AD→BS and BS→AD), and carries a calendar table spanning roughly 2000–2100 BS — well past the near-future compliance expiries this slice surfaces. MIT-licensed, small, widely used; DESIGN.md already named it a candidate. Per CLAUDE.md's "propose a new top-level dependency first," this ADR proposes it; the code slice **pins an exact version and verifies at install** that it (a) imports and converts under plain Node with no `window`/DOM access, (b) provides or has `@types`, (c) round-trips a known AD↔BS fixture, and (d) covers a date a few years out — the same install-time verification done for `@nestjs/bullmq` (GPS T1) and `react-leaflet`/Geoman (geofence G4). The dependency is **isolated to the first code ticket** for a clean blast radius; if verification fails, the ticket flips to `bikram-sambat` with no change to `nepali-date.ts`'s public contract (the converter is wrapped behind it).

### B. The format contract

2. **Format follows DESIGN.md exactly; month names are a FleetCo-owned constant.** Output matches DESIGN.md byte-for-byte: `"2082 Jestha 6 (2026-05-20)"` — `<BS year> <BS month (Latin)> <BS day> (<AD YYYY-MM-DD>)`, BS prominent, AD parenthetical in `color.text.muted`. **Latin numerals only; no Devanagari digits in v1** (DESIGN.md §Devanagari). The **12 BS month names are a FleetCo-owned constant array** — `["Baishakh","Jestha","Ashadh","Shrawan","Bhadra","Ashwin","Kartik","Mangsir","Poush","Magh","Falgun","Chaitra"]` — and the code slice diffs the library's English month strings against it at install and **overrides** any spelling that differs (libraries vary: "Baisakh/Baishakh", "Ashar/Ashadh", etc.). This array is the source of truth so a library update cannot silently change a rendered month name — the anti-drift guard, the same "drift is the failure mode" discipline applied between the redact/scrub lists and between Tailwind and DESIGN.md. Variants (DESIGN.md's `format`): **`both`** (default) → the full string, AD muted; **`bs`** → BS only (for dense table cells, with the AD date carried in a `title` tooltip so it stays recoverable); **`en`** → Gregorian only (identical to today's inline output, and the safe degrade if conversion ever throws).

### C. The lib + component contract

3. **`nepali-date.ts` + `<NepaliDate>`, mirroring `money.ts`/`<Money>`.** `apps/web/src/lib/nepali-date.ts` exports `formatNepaliDate(iso: string | null | undefined, opts?: { format?: "both" | "bs" | "en" }): string` — em-dash `—` for null/undefined/non-parseable (identical to `formatNpr`), JSDoc with the three worked examples. The component `<NepaliDate iso={…} format?=… />` (DESIGN.md's documented prop shape, consistent with `<Money paisa={…} />`) is a thin **server component** (no `"use client"`) that wraps the formatter and renders BS prominent + AD in a `color.text.muted` span (or `title` tooltip for `bs`). **The UTC-calendar-day rule (load-bearing):** the existing inline formatters render the UTC Y-M-D; the BS conversion must convert the **same UTC calendar day** — build the converter's input from the UTC components (`Date.UTC(y, m, d)`), never the raw local-zone `Date` — or a deadline renders one BS day early/late depending on server timezone. This off-by-one is the one hazard money/units never faced (they are zone-free); it is pinned by a timezone-independent test.

### D. Centralization / rollout

4. **Replace the inline `formatDate` copies on date-only display fields; timestamps and inputs stay AD.** In scope (gets BS): every **date-only display field** across the list + detail pages of all aggregates (vehicles, drivers, customers, jobs, trips, fuel-logs, expense-logs, geofences, reports). Out of scope (stay AD/UTC): **date-time / audit timestamps** (`formatDateTime`, `formatTimestamp`, the `… UTC` audit instants) — these are machine/sort/audit values where a BS render adds noise without operator value, and the `UTC` suffix is a deliberate precision signal; a future `<NepaliDateTime>` can layer BS-date + time if a real need surfaces. **Date inputs** (`edit-*-form.tsx` native `<input type="date">` defaults) stay native AD until the deferred date-picker. The rollout is mechanical: delete each page's local `formatDate`, swap to `<NepaliDate iso={…} />` (ReactNode contexts) or `formatNepaliDate(…)` (string contexts).

### E. Compliance badge + threshold

5. **A shadcn `Badge` + a pure `complianceBadgeState` helper, 30-day window, per-document on Vehicle detail.** *(The 30-day threshold + amber/red semantics are the PO's owner-level pick; the rest is recommendation.)* `apps/web/src/components/ui/badge.tsx` is a CVA component mirroring `button.tsx`, with variants bound to the **existing** tokens — `warning` (amber, `color.status.warning`), `error` (red, `color.status.error`), plus `success`/`neutral`/`info` to cover DESIGN.md's full status set for future adopters — so **no new design token is introduced and the drift test is untouched**. A `Badge` is a `<span>` (status, not action — DESIGN.md anti-pattern #2), `radius.sm`, `text.xs`, hue always paired with a text label. `complianceBadgeState(expiryIso, now, windowDays = 30)` is a **pure helper** (co-located in `nepali-date.ts` or a sibling): null/invalid → `none` (render the date alone, no badge); `expiry < now` → `expired` (red, label "Expired"); `now ≤ expiry ≤ now + 30d` → `expiring-soon` (amber, label "Expiring soon"); else → `ok` (no badge). The comparison uses the same UTC-day discipline as the formatter so the boundary is deterministic. Labels are plain facts per DESIGN.md voice — "Expired", "Expiring soon", no exclamation. **Surface:** per-document in the Vehicle detail Compliance `<section>`, next to each of the three expiry rows. A vehicles-list compliance roll-up column is a useful but separable follow-up (it adds a worst-of-three aggregation + a layout decision) — **not in v1**; it reuses the same helper when wanted.

### F. Scope boundary

6. **v1 = display + badges; date-picker deferred; reminder delivery is Phase 3 (excluded).** *(Scope is the PO's owner-level pick.)* In v1: BS rendering everywhere dates are shown + the compliance visual badges. **Named follow-up (deferred):** the BS date-picker input widget (DESIGN.md §"BS calendar"'s month-grid popup) — date inputs stay native AD until then, and that slice re-evaluates datepicker libraries. **Explicitly Phase 3 (excluded, hard boundary):** compliance reminder *delivery* — email/SMS/cron/queue and the "reminder delivery" SLI (`roadmap.md` §"Phase 3"). This slice ships a passive visual indicator only; it does not notify, schedule, or instrument delivery. Per CLAUDE.md, "must not work on items from later phases."

7. **Memory-artifact note.** DESIGN.md's `<NepaliDate>` and badge contracts are followed verbatim, so no DESIGN.md *contract* edit is needed; the only DESIGN.md touch is a one-line **Badge provenance entry** (date + "Badge added") when the Badge component lands (N3), matching the existing component-provenance list. The glossary gains a *Bikram Sambat*/*NepaliDate* pointer to this ADR and `docs/CURRENT_PHASE.md` records the slice — both with the implementing code, not this proposal.

### Follow-up code-slice sequence (proposed, not executed)

Each ticket is a vertical, independently-shippable slice; one ticket → one PR.

- **N1 — `nepali-date` lib + dependency + `<NepaliDate>` + tests + adopt on Vehicle detail.** Add `nepali-date-converter` (isolated, verified at install); build `nepali-date.ts` (formatter + `complianceBadgeState`) and the `<NepaliDate>` server component; adopt on the highest-value surface (the three expiry rows in `vehicles/[id]/page.tsx`). Tests (pure, mirror `money.test.ts`): the `both`/`bs`/`en` variants → exact DESIGN.md strings, null/garbage → em-dash, the 12 month-name spellings, the **TZ-independent UTC-day test**, and a known AD↔BS fixture.
- **N2 — roll `<NepaliDate>` across the remaining pages.** Mechanical replacement of the remaining inline date-only `formatDate` copies. Leave every `formatDateTime`/`formatTimestamp` and all `edit-*-form.tsx` inputs untouched. Gate: `pnpm build` (SSR) + typecheck.
- **N3 — `Badge` + compliance badges.** Add `badge.tsx`; wire `complianceBadgeState` into the Vehicle detail Compliance section; test the helper (expired / expiring-soon / ok / none + the 30-day boundary + UTC determinism); add the DESIGN.md Badge provenance line; PR states the phase boundary explicitly.

### Relationship to prior ADRs

- **Realizes DESIGN.md / ADR-0007 / ADR-0016** — DESIGN.md deferred the BS-library choice "to a Phase 1 ADR"; this is it. It implements DESIGN.md's `<NepaliDate>` and badge contracts verbatim, so DESIGN.md stays the source of truth (ADR-0007), edited only for a Badge provenance line.
- **Mirrors the `<Money>`/`formatNpr` pattern** (the money/units formatter-lib convention) for the new date formatter.
- **Is the PO-confirmation vehicle** for the new `nepali-date-converter` dependency, per CLAUDE.md — no BS code is written until this ADR is accepted (done).
- **Respects the Phase-3 boundary** (`roadmap.md`) — compliance reminder delivery is not built here.

## Alternatives considered

**An in-tree AD↔BS conversion table (no dependency).** Zero new dependency, fully diffable and in our control. Rejected (the PO's pick): BS month lengths are almanac-based, not formulaic, so we would own the correctness and year-boundary maintenance of a table that compliance dates depend on — a worse trade than a verified, community-maintained library for the most accuracy-sensitive rendering in the app. (DESIGN.md anti-pattern #12 — "fabricated BS conversions" — is exactly this risk.)

**A browser datepicker library (e.g. `nepali-datepicker-reactjs`) as the converter.** Rejected: it is a React/DOM widget, not a pure converter, so it would not run cleanly in a server component and pulls UI weight we do not need for display. The deferred BS date-picker slice re-evaluates datepicker libraries then; the converter we want now is pure-JS.

**Devanagari numerals (२०८२ जेठ ६) in v1.** Rejected per DESIGN.md — Latin transliteration and Latin numerals in v1; the Devanagari font is loaded for Nepali field *names*, not for rendering numbers. A Devanagari-numeral option can be added later if operators want it.

**Render BS on audit timestamps too.** Rejected (commitment 4): `createdAt`/`updatedAt` and `… UTC` instants are machine/audit values; a BS render adds noise to a sort key. Date-only deadline/event fields are where BS earns its place.

**Build the badge as part of a Phase-3 reminder system.** Rejected (commitment 6): the *visual* badge is deferred Phase-1 polish — a passive indicator on a page the operator already views. Reminder *delivery* (email/SMS, the SLI) is Phase 3 and stays there; conflating them would pull later-phase scope forward.

**Skip the ADR and just build it.** Rejected: DESIGN.md itself mandates "a Phase 1 ADR will pick the conversion library," and a new top-level dependency requires proposing it (CLAUDE.md). This ADR is that gate, mirroring ADR-0028/0029/0030.

## Consequences

### What this makes easier

The whole app finally speaks the operator's calendar: every shown date renders in Bikram Sambat through one centralized formatter, so the convention can never drift page-to-page again (today's ~15 inline copies become one). Compliance lapses surface at a glance — an amber or red badge on the Vehicle detail page the moment a bluebook/insurance/route-permit date enters its 30-day window or passes. The `<NepaliDate>` and `Badge` primitives unblock future surfaces (the deferred date-picker, status pills for trip/vehicle/job status) that DESIGN.md already designed. And the slice is mostly composition of proven parts — the formatter mirrors `<Money>`, the badge mirrors `button.tsx`.

### What this makes harder

A new frontend dependency (`nepali-date-converter`) enters the web app — a calendar table whose correctness the app now leans on, re-verified on any major bump. Every contributor rendering a date must reach for `<NepaliDate>`/`formatNepaliDate` rather than a local `formatDate` (the centralization only holds if new code uses it). The UTC-calendar-day rule is a standing correctness obligation — a future date render that converts the local-zone date instead of the UTC day reintroduces the off-by-one. And the FleetCo-owned month-name array must be kept as the override so a library update can't change a rendered month.

### Costs we accept

- **No BS date input in v1.** Operators read dates in BS but still enter them in the native AD picker. We accept the asymmetry until the deferred date-picker slice; the read side is where the daily friction is.
- **Audit timestamps stay AD/UTC.** A consistency seam (most dates BS, `createdAt`/`… UTC` Gregorian) a contributor must understand. The trade favors not adding noise to machine values.
- **The badge is passive.** It warns only when the operator opens the page; it does not push a reminder. That push is Phase 3 by design; until then a vehicle whose page is never opened won't surface its lapse.

## Revisit when

- **The BS date-picker is wanted.** Build DESIGN.md's month-grid input widget; date inputs move off the native AD picker; re-evaluate datepicker libraries then.
- **Phase 3 lands compliance reminders.** The passive badge gains an active delivery path (email/SMS, the "reminder delivery" SLI) — governed there, reading the same expiry data and threshold logic.
- **A vehicles-list compliance roll-up is wanted.** Add the worst-of-three indicator column to `vehicles/page.tsx`, reusing `complianceBadgeState`.
- **Operators want Devanagari numerals or a `<NepaliDateTime>`.** Add a numeral-script option / a date-time BS variant — both are extensions of the same formatter.
- **`nepali-date-converter` majors or its calendar table is questioned.** Re-verify the AD↔BS fixtures and the month-name overrides at the bump; the wrapper keeps the blast radius at `nepali-date.ts`.
