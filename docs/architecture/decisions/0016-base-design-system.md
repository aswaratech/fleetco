# ADR-0016: Base design system — shadcn-ui

- **Status:** Accepted
- **Date:** 2026-05-16
- **Decider:** Product owner (CEO)

## Context

ADR-0007 committed FleetCo to treating `docs/design/` as the canonical visual source of truth, with `docs/design/DESIGN.md` defining the design system (tokens, components, voice, anti-patterns) and the Tailwind theme deriving from `DESIGN.md`. ADR-0007's "Alternatives considered" section explicitly listed Linear, Notion, and Vercel as leading candidates for the base design system FleetCo customizes from, but left the choice itself open: it said the base-system choice would be made "in the first design-focused session and recorded in a phase-0 supplement to `DESIGN.md`." The kickoff plan's gap analysis flagged this as a discipline mismatch — architectural choices in this project live in ADRs, not in supplements inside other documents — and proposed that the base-system choice be its own ADR. This ADR is that ADR.

The constraints in play: the design system must be Tailwind-native (because ADR-0007 commits to deriving the Tailwind theme from `DESIGN.md` rather than authoring it independently); it must be customizable for FleetCo-specific needs (NPR/paisa formatting, Bikram Sambat date widgets, Devanagari font fallback, density appropriate for table-heavy ops screens); it must be friendly to AI-agent generation density, since most UI will be agent-authored and the AI's training mass on the chosen system materially affects output quality (ADR-0005's reasoning about TypeScript also applies here); and it must avoid framework-coupling that fights customization, because FleetCo's UI is dense-ERP with Nepal-specific affordances, not a generic SaaS dashboard.

The question this ADR closes: which base design system does `DESIGN.md` (Ticket 5) derive from?

## Decision

The base design system for FleetCo is **`shadcn-ui`** (https://ui.shadcn.com), used in its native copy-paste-not-install mode: component implementations are copied into `apps/web` and owned in-tree rather than imported as a versioned dependency. shadcn-ui's aesthetic conventions (Vercel-derived) inform the tokens and component patterns documented in `docs/design/DESIGN.md`; FleetCo's customizations (NPR/paisa formatting, BS-calendar widgets, Devanagari fallback, ERP density) are layered on top of those conventions in `DESIGN.md` and in the copied component code.

A precise note on terminology: shadcn-ui is technically a component library built on Radix UI primitives and Tailwind CSS, not a "design system" in the Material/Apple-HIG sense. We adopt it as our "base design system" in the sense that ADR-0007 used the phrase: the starting point from which FleetCo's actual design system (documented in `DESIGN.md`) is customized. The aesthetic identity is the Vercel-derived one that shadcn-ui ships by default; the implementation pattern is shadcn-ui's copy-paste-not-install model.

## Alternatives considered

**Linear** (their public component aesthetic). Known for typographic discipline, density, motion polish. Rejected because (a) Linear does not publish an open-source component library; adopting "Linear-style" would mean reverse-engineering from their public site, which is a sustained ongoing cost and a quality risk; (b) Linear's strong dark-default aesthetic is a heavier commitment than Phase 0 wants to make for a tool whose admin user will spend most of their day in it under varied lighting; (c) Linear's design language is not Tailwind-native, which complicates ADR-0007's "Tailwind derived from DESIGN.md" mechanism.

**Notion** (their content-first aesthetic). Known for clean typography, breathing room, content-density. Rejected because Notion's design language is document-first and block-first, while FleetCo's primary surfaces are data tables and operational forms. The aesthetic mismatch would force more customization than starting from a system already aligned with dense-data screens; we would be fighting the base system rather than building on it.

**Vercel** (their `geist` design system, available as a React package). Tailwind-compatible, modern, well-documented. Rejected as a direct base because shadcn-ui already implements the same Vercel-derived aesthetic in copy-paste-not-install form. Importing `geist` as a versioned dependency would re-introduce the framework-coupling that shadcn-ui's copy-paste model deliberately avoids; for FleetCo's customization needs (Nepali-specific affordances), ownership of the component code is preferable to dependency-managed components.

**Material UI / Chakra UI / Mantine** (mainstream install-not-copy component libraries). Each ships strongly-opinionated patterns that customization-by-override fights against; theming systems are powerful in their happy paths and awkward outside them; the install-not-copy model means library version bumps can change UI behavior across the app. Rejected because the customization burden for FleetCo's Nepal-specific affordances and ERP density would exceed shadcn-ui's, where component code is in-tree and edits land in PR diffs.

**Build from scratch.** Rejected for the same reason ADR-0007 rejected it: a bespoke design system is a poor use of solo-founder time, and the established base systems already solve the foundational pieces (color scales, spacing scales, typography scales, focus states, accessibility primitives) better than a one-person shop can match while also building business features.

## Consequences

What this makes easier: component code is owned (copied into `apps/web/src/components/ui/` or equivalent), so FleetCo-specific customizations (NPR formatting in input components, BS calendar widgets, Devanagari font stack in typography components, density variants for ops tables) land as edits to local code rather than as overrides fighting a framework's theming layer; AI agents have particularly strong training mass on shadcn-ui patterns (high React + Tailwind + Radix corpus), which materially improves agent-authored output quality and review burden; the shadcn-ui CLI provides a clear convention for adding new components incrementally as Phase 1 slices need them, rather than vendoring all components upfront.

What this makes harder: copying component code means there is no centralized upstream from which to receive automatic bug fixes or accessibility improvements; if shadcn-ui ships a fix to (say) its Combobox component, we do not get it unless we manually re-apply the patch to our copy. Manual upstream tracking is the cost. We mitigate by (a) committing copied components in distinct PRs so the provenance is reviewable; (b) maintaining a short note in `DESIGN.md`'s component sections referencing the shadcn-ui version the component was copied from, so a future agent can compare against the latest upstream when revisiting; (c) treating accessibility-relevant upstream changes as priority items in tech-debt review.

Costs we accept: ownership burden for component code; manual upstream tracking; the additional in-tree code that shadcn-ui's copy-paste model entails. These costs are explicitly chosen over framework-coupling and customization-fighting, both of which would compound across Phase 1's many UI slices.

Implication for `docs/design/DESIGN.md` (Ticket 5 of the kickoff plan, "DESIGN.md substantive authoring"): tokens (color, typography, spacing, sizing, borders, shadows) draw from shadcn-ui's defaults and are customized for FleetCo's needs; component patterns documented in `DESIGN.md` mirror shadcn-ui's component API; locked HTML mockups in `docs/design/slices/` are authored against the shadcn-ui aesthetic. The Tailwind theme in `apps/web/tailwind.config.ts` derives from `DESIGN.md` per ADR-0007's chain (shadcn-ui → DESIGN.md → tailwind.config.ts), and the drift-detection mechanism committed in Ticket 8 enforces that derivation.

## Revisit when

Any of: (a) shadcn-ui's project goes unmaintained or significantly changes direction in a way that breaks the copy-paste-not-install model; (b) FleetCo's dense-ERP density needs prove systematically poorly served by shadcn-ui's primitives (e.g., the Table component fights us across multiple slices), at which point we would revisit toward Linear (reverse-engineering, with the cost now justified) or a more table-first base; (c) a material aesthetic mismatch surfaces during DESIGN.md authoring in Ticket 5, caught early enough that the base choice can change before any UI ships; (d) Tailwind itself undergoes a major architectural change that affects the derivation chain; (e) the Phase 2 driver app introduces requirements (touch-density, accessibility-on-vehicle, offline-tolerant patterns) that shadcn-ui does not address well, in which case the driver app may diverge from the admin web on its base while the admin web stays on shadcn-ui.
