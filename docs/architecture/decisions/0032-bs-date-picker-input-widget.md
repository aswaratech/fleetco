# ADR-0032: Bikram Sambat date-picker input widget — a hand-built month-grid over the installed converter

- **Status:** Accepted
- **Date:** 2026-06-06
- **Decider:** Product owner (CEO)
- **Accepted:** 2026-06-06

## Acceptance

Accepted by the product owner (CEO) on 2026-06-06, ratifying the one owner-level pick:

- **Build approach (commitment 1):** **hand-build** a `<NepaliDatePicker>` (a Radix `Popover` + a BS month-grid using the already-installed `nepali-date-converter`) over adopting a third-party React BS datepicker — **no new top-level dependency**, and a pixel-exact fit with the design system and DESIGN.md's documented widget.

The glossary's *BS* / *Bikram Sambat* entries gain a pointer to this ADR with the implementing code, not here.

## Context

ADR-0031 shipped Bikram Sambat date **rendering** (the `<NepaliDate>` display component over `nepali-date-converter`) and explicitly deferred the **input** side: "the BS date-picker input widget … is a named follow-up; date inputs stay native AD until then" (ADR-0031 commitment 6). It also recorded that the datepicker *library* choice was "deferred … to that slice." This is that slice, and this ADR is the deferred library decision (the second BS-calendar requirement after the display one ADR-0031 settled).

Today all date entry uses the browser-native `<input type="date">` — **13 sites** across the create/edit forms (vehicles, drivers, fuel-logs, expense-logs, jobs), the fuel/expense filter toolbars, and the report date-range picker. A Nepali operator reads dates in BS (thanks to `<NepaliDate>`) but still types them in a Gregorian picker — the asymmetry this slice closes.

**DESIGN.md §"BS calendar" already specifies the widget**: "a trigger button shows the current BS + Gregorian date; popup shows a BS month grid with Gregorian dates underlaid in muted text in the corner of each cell; user can switch BS months via arrow controls; today is highlighted with a `color.accent.primary` outline." DESIGN.md §Inputs "Date input" points at the same component. So the design is fixed; the open decision is *how to build it*.

The substrate is already in place (verified): **`nepali-date-converter@3.4.0`** is installed and is the verified AD↔BS source ADR-0031 chose; the **`radix-ui` umbrella (`^1.4.3`)** is installed and provides `@radix-ui/react-popover` (no `popover.tsx` shadcn primitive copied in yet); **`react-hook-form`** drives the forms (which are already client islands); and `apps/web/src/lib/nepali-date.ts` already owns the FleetCo BS month-name array and the UTC-calendar-day conversion discipline. So a hand-built widget composes only installed pieces.

This ADR **decides shape and approach only** — it writes no component, adds no dependency. The build program consumes it.

## Decision

**Hand-build a `<NepaliDatePicker>` client component — a Radix `Popover` trigger (showing the current BS + Gregorian date via `<NepaliDate>`) opening a BS month-grid (Gregorian dates underlaid in muted corner text, arrow month/year navigation, today outlined in `color.accent.primary`) whose cell selection emits the same ISO/UTC date string the native `<input type="date">` emits today — using the already-installed `nepali-date-converter` for the BS↔AD math and the installed `radix-ui` Popover (added as a shadcn `popover.tsx` primitive); roll it across the 13 native date-input sites, leaving the form schemas, server actions, and API contracts entirely unchanged; no new top-level dependency.** Seven commitments.

1. **Hand-built, not a third-party datepicker — no new top-level dependency** *(owner-level pick, ratified).* The widget is composed in-tree from the installed `nepali-date-converter` (the conversion source) + the installed `radix-ui` Popover (surfaced via a `apps/web/src/components/ui/popover.tsx` shadcn copy-in, like the existing `select.tsx`/`alert-dialog.tsx`) + Tailwind tokens. A third-party React BS datepicker (`nepali-datepicker-reactjs` and the like) is rejected: it adds a dependency, ships its own styling that fights the design system, and is unlikely to match DESIGN.md's exact widget (month grid + AD-underlaid cells + accent-outlined today). Hand-built is small, design-exact, and dependency-free — the same reasoning that kept the display side on a thin in-tree wrapper.

2. **Widget contract = DESIGN.md §"BS calendar" verbatim.** Trigger button shows the current BS + Gregorian date (reuse `<NepaliDate iso=… format="both" />` for the label); the popover renders a BS month grid (7-column weeks) with each cell's Gregorian date in muted corner text (`color.text.muted`); arrow controls switch BS month (and year); today is outlined in `color.accent.primary`; the selected day is filled. Empty/unset shows a placeholder per §Voice. Keyboard- and screen-reader-accessible via Radix Popover's focus management; cells are buttons.

3. **Component API + the unchanged value contract (load-bearing).** `<NepaliDatePicker value={iso | null} onChange={(iso: string | null) => void} … />` — it **accepts and emits the exact ISO date string** (`YYYY-MM-DD`, the UTC calendar day) the native `<input type="date">` uses today. The **form Zod schemas, `actions.ts` server mutations, and every API contract are untouched** — the picker is a drop-in replacement at the input layer only. It applies the **same UTC-calendar-day discipline** as `formatNepaliDate`/`complianceBadgeState` (convert the UTC Y-M-D, build the converter input from `Date.UTC(...)`) so a selected day never lands one BS day off by server/local timezone.

4. **Conversion math reuses the ADR-0031 substrate.** All BS↔AD conversion goes through `nepali-date-converter` (the verified source); the rendered month names come from the **FleetCo-owned `BS_MONTHS` array** already in `apps/web/src/lib/nepali-date.ts` (the anti-drift guard — never the library's locale strings); Latin numerals only (no Devanagari digits in v1, per ADR-0031). The pure grid/conversion helpers (build a BS month's day cells, map each to its AD date, locate "today") live in a testable module (`apps/web/src/lib/nepali-date-picker.ts` or beside `nepali-date.ts`), unit-tested like `nepali-date.test.ts`; the React component is the thin shell.

5. **Rollout: the 13 native date-input sites.** Replace `<input type="date">` with `<NepaliDatePicker>` across the create/edit forms (vehicles, drivers, fuel-logs, expense-logs, jobs), the fuel-log/expense-log filter toolbars, and the report date-range picker — wired through the existing `react-hook-form` field the native input used. The forms are already client components, so the client-only Popover fits with no server/client boundary change.

6. **Scope boundary.** Date-only (no time-of-day; a future `<NepaliDateTime>` picker is separate, as on the display side). The filter toolbars and the report keep their **two separate date inputs** (from/to) — each becomes a `<NepaliDatePicker>`; a single BS range-picker is out of scope. No Devanagari numerals. No change to what any date *means* or how it's stored.

7. **Memory.** The glossary's *BS*/*Bikram Sambat* entries gain a pointer to this ADR; `docs/CURRENT_PHASE.md` records the slice — both with the implementing code. DESIGN.md's widget spec is followed verbatim, so the only DESIGN.md touch is a one-line provenance entry when `popover.tsx` is copied in (matching the `select.tsx`/`table.tsx` provenance entries).

### Follow-up code-slice sequence (proposed, not executed)

- **B1 — `popover.tsx` primitive + `<NepaliDatePicker>` + pure-helper tests + adopt on one form.** Copy in the shadcn `popover.tsx` (using the installed `radix-ui`); build the pure grid/conversion helpers + the `<NepaliDatePicker>` component to the commitment-2 contract; unit-test the helpers (a BS month's cells map to the right AD dates; today is located; selection round-trips to the same ISO string the native input would have produced — TZ-independent); adopt it on the **vehicle compliance date inputs** (`vehicles/.../create|edit` — the highest-value surface) to prove the react-hook-form integration end-to-end.
- **B2 — roll across the remaining create/edit forms** (drivers, fuel-logs, expense-logs, jobs). Mechanical replacement; the value contract is unchanged, so the form/action/API code is untouched.
- **B3 — the filter toolbars + the report date-range** (fuel-logs/expense-logs filters, the per-vehicle-cost report from/to). B3's next-session prompt emits `STOP — program complete`.

## Alternatives considered

**A third-party React BS datepicker (`nepali-datepicker-reactjs` or similar).** The quickest drop-in. Rejected (the PO's pick): it is a new top-level dependency that ships its own styling and DOM, would fight the design system's tokens/spacing/focus states, and is unlikely to render DESIGN.md's exact widget (BS grid with AD-underlaid cells, accent-outlined today) without heavy override — at which point the override is comparable to hand-building. The verified converter we already trust (`nepali-date-converter`) plus the installed Radix Popover gives a design-exact, dependency-free widget.

**Keep native `<input type="date">` (status quo).** Zero work, but it forces every operator to mentally convert a BS deadline into a Gregorian date to enter it — exactly the friction this slice exists to remove, and the asymmetry with the shipped BS display.

**A composed text input that parses a typed BS date string (no calendar popup).** Lighter than a grid. Rejected: DESIGN.md specifies the month-grid popup, and a free-typed BS string reintroduces the fabricated/mis-parsed-conversion risk (anti-pattern #12) the calendar avoids; the grid is also far better UX for picking a date than typing `2082-03-06`.

**Build it without an ADR.** Rejected: ADR-0031 explicitly deferred the datepicker library choice "to that slice," and a new cross-cutting input component across 13 forms is the kind of decision the cadence records — even though the chosen path adds no dependency, the decision (hand-built, design-exact, value-contract-preserving) is worth one short ADR, mirroring how ADR-0031 settled the display side.

## Consequences

### What this makes easier

The BS calendar becomes symmetric: operators read *and* enter dates the way they think, across every form, with one reusable widget. Because the value contract is unchanged (ISO in, ISO out), the swap is confined to the input layer — no schema, action, or API churn, and the existing form validation keeps working untouched. The widget is design-exact (it's built from the design system, not bolted onto a foreign one) and dependency-free, so there is no new supply-chain or version-coordination surface. And it reuses the verified converter + the anti-drift month-name array already in the tree, so the conversion correctness ADR-0031 established carries straight over.

### What this makes harder

A new bespoke interactive component enters the tree — a month-grid with navigation and keyboard/focus behavior FleetCo now owns and must keep accessible and correct (the display side was a thin formatter; this is real UI). The Radix `Popover` primitive joins the in-tree shadcn set (a small standing maintenance item). Every date input is now a client-island component (the forms already were, so no new boundary, but the picker can't be a server component). And the UTC-calendar-day discipline becomes a third place that rule must hold (formatter, compliance helper, now the picker).

### Costs we accept

- **Hand-built UI is more code than a library drop-in.** We accept the larger first-build for the design-exact, dependency-free result; the grid/conversion logic is small and unit-tested, and the component is built once and reused 13 times.
- **Date-only, two-input ranges.** No time picker and no single range widget in v1; filters keep their from/to pair. A `<NepaliDateTime>` and a range-picker are separate future slices if a real need surfaces.
- **One more UTC-day site.** A future contributor adding a date input must reach for `<NepaliDatePicker>` (not a native input) and respect the UTC-day rule — the same standing obligation the display side already carries.

## Revisit when

- **A time-of-day or a single BS range-picker is wanted** — build `<NepaliDateTime>` / a range variant as their own slices, reusing this widget's grid + conversion helpers.
- **Operators want Devanagari numerals** in the grid — a numeral-script option on the shared converter/formatter (the same extension the display side would take).
- **`nepali-date-converter` or `radix-ui` majors** past the pinned versions and changes the conversion or Popover surface — re-verify the grid math / focus behavior, coordinated as ADR-0031's "Revisit when" handles the converter.
- **A third-party datepicker later proves clearly better** (accessibility edge cases the hand-built grid misses at scale) — the value contract is unchanged, so swapping the widget's internals behind `<NepaliDatePicker>` is mechanical.

## Relationship to prior ADRs

- **Realizes ADR-0031's** deferred "BS date-picker input widget" follow-up and its deferred "datepicker library" decision; reuses ADR-0031's `nepali-date-converter`, the `BS_MONTHS` anti-drift array, the `<NepaliDate>` display component (for the trigger), and the UTC-calendar-day rule.
- **Consumes DESIGN.md §"BS calendar" / §Inputs** verbatim (the widget spec); the only DESIGN.md edit is a `popover.tsx` provenance line.
- **Is the PO-confirmation vehicle** for the input-side build, per the established cadence — no `<NepaliDatePicker>` code is written until this ADR is accepted (done); it adds no dependency, so the confirmation is about the approach, not a new package.
