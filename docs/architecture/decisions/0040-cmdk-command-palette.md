# ADR-0040: `cmdk` for the ⌘K command palette — adopt one new top-level dependency, with the modal built on the installed Radix Dialog

- **Status:** Accepted
- **Date:** 2026-06-25
- **Decider:** Product owner (CEO)
- **Accepted:** 2026-06-25

## Acceptance

Accepted by the product owner (CEO) on 2026-06-25 via ratify-by-merge of the T7 PR (#168, `feat/cmdk-command-palette`, merged 2026-06-25) — the Phase-1 design-first governance's acceptance mechanism (the PR body carried this ADR as the new-dependency proposal). The one owner-level pick is ratified as proposed: adopt **`cmdk@^1.1.1`** as the single new top-level dependency for the ⌘K command palette, with the modal built on the already-installed `radix-ui` Dialog (no separate dialog dependency).

## Proposal

This ADR is the **new-top-level-dependency proposal** CLAUDE.md requires ("You must not add a new top-level dependency without proposing it first and explaining why"). It proposes adopting **`cmdk`** to build the ⌘K command palette — the last ticket (T7) of the Phase-1 app-shell program. The PR that carries this ADR is the proposal; **ratification is by merging that PR** (the Phase-1 design-first governance — PO ratifies-by-merge). No palette code depends on a decision made here that the PO has not seen.

The one owner-level pick:

- **Adopt `cmdk` (`^1.1.1`) as the single new top-level dependency** for the navigation-only ⌘K palette, building the modal shell on the **already-installed `radix-ui` Dialog** (no separate dialog dependency), over hand-rolling the list/keyboard/filter behaviour or pulling a heavier palette framework.

## Context

The Phase-1 app-shell program (the locked mockup `docs/design/slices/_archive/app-shell.html`, ADR-0007/0008 design-first) was built around a ⌘K command palette from the start: **Frame 2 of the mockup depicts it** (a search field, the grouped command list mirroring the sidebar, a `↑↓ navigate · ↵ open · esc close` footer), and the shared nav source `apps/web/src/lib/nav.ts` was written to feed it — its header names "the ⌘K command palette (T7)" as a consumer alongside the sidebar and the home quick-links strip, and `navForRole(role)` already returns exactly the grouped destinations the palette renders. The shell (`components/app-shell/app-shell.tsx`) deferred the palette to its own dependency ticket; this is that ticket.

A command palette is not a trivial widget. Done right it is a modal dialog containing a text-filtered, keyboard-navigable list with roving focus, `aria-selected` semantics, type-ahead fuzzy matching, and correct focus-trap/restore — the accessibility surface the project's voice-and-rigor standards expect. The substrate for everything *except* that list behaviour is already in the tree (verified): `navForRole` supplies the data; the `radix-ui` umbrella (`^1.4.3`, already a direct dependency) exports `Dialog` for the modal; `lucide-react` supplies the per-item icons; the `@theme` token utilities and `popover.tsx` re-point template supply the styling. What is missing is the list/keyboard/filter engine — precisely what `cmdk` is.

`cmdk` is the library that backs shadcn-ui's `Command` primitive (this project already uses shadcn-ui copy-paste components per ADR-0016, and the Next/Tailwind/shadcn stack per ADR-0019). It is small, MIT-licensed, and widely used. **React-19 compatibility was verified at add time** (`cmdk@1.1.1` peer-deps `react: ^18 || ^19 || ^19.0.0-rc`; the lockfile resolved it against `react@19.2.6`) — the check the react-leaflet-v5 lesson made mandatory before relying on a new dependency under React 19.

## Decision

**Adopt `cmdk@^1.1.1` as the one new top-level dependency. Build `apps/web/src/components/ui/command.tsx` as the shadcn-ui `Command` copy-in (cmdk-backed), with every class re-pointed from shadcn's dead `:root` aliases to FleetCo's `@theme` semantic utilities, and the modal wrapper built directly on the already-installed `radix-ui` Dialog. Mount the palette in the `<AppShell>` (a global ⌘/Ctrl+K listener plus a top-bar "Search… ⌘K" affordance), sourcing its destinations from `navForRole(role)`. Navigation-only.** Six commitments.

1. **`cmdk` is the only new top-level dependency** *(owner-level pick).* It provides the type-ahead filtering, roving keyboard focus, and `aria-selected` list semantics a correct palette needs. Hand-rolling that is real, easy-to-get-subtly-wrong accessibility work for no saved dependency of consequence; a heavier palette framework (e.g. `kbar`) brings its own store/registration model and styling that would fight the design system. `cmdk` is the minimal, canonical, shadcn-aligned choice.

2. **The modal is built on the installed `radix-ui` Dialog — no separate dialog dependency.** shadcn's `CommandDialog` wraps `Command` in shadcn's `Dialog` component, which this project has not copied in (Dialog is "Contract only" in DESIGN.md). Rather than add a dialog dependency, the modal wrapper is built directly on `@radix-ui/react-dialog` as vendored by the umbrella `radix-ui@1.4.3` (the same import shape `popover.tsx`/`select.tsx`/`alert-dialog.tsx` already use). `cmdk` itself pulls `@radix-ui/react-dialog` transitively, but we deliberately consume the umbrella, not the transitive copy. The standalone shadcn `Dialog` primitive stays contract-only; this wrapper is internal to `command.tsx`.

3. **Re-pointed to `@theme`, guarded by CI.** Per DESIGN.md §"How this file relates to code", Tailwind 4 emits utilities only for `@theme` `--color-*` tokens; shadcn's `:root` aliases (`bg-popover`, `text-muted-foreground`, `bg-accent`, `bg-border`, …) are dead classes here. `command.tsx` re-points them to the live semantic utilities exactly as `popover.tsx` documents (`bg-popover` → `bg-surface-elevated`, the highlighted item to `bg-surface-muted` + `text-text-primary` — *not* the white `text-accent-foreground` trap, etc.). The design-token-consumption guard (`apps/web/test/design-token-consumption.test.ts`) auto-scans every `ui/*.tsx` and fails CI on any dead alias, so this is enforced, not aspirational. Surface radius `rounded-lg` (8px), control radius `rounded` (4px), per DESIGN.md §Borders.

4. **Navigation-only; sourced from the one nav model.** The palette renders `navForRole(role)` — the same five PO-ratified groups (Operations / Money / Maintenance / Reports / Logs) the sidebar renders — and `router.push`es to the selected item's `href`. Because it reads `lib/nav.ts`, the sidebar, the home quick-links strip, and the palette cannot drift. **Resource/data search (jumping to a specific vehicle or trip) is explicitly out of scope** and belongs to a later phase; `cmdk` extends to it cleanly when that work is scoped.

5. **Manual upstream tracking, per ADR-0016.** `command.tsx` is a copy-paste-not-install shadcn component carrying a provenance comment (source URL, fetch date, the token-mapping rationale, and the two deliberate deviations: the Radix-Dialog modal, and the navigation-hints footer added from the mockup). When upstream changes meaningfully, the source is re-fetched and the edits re-applied in a separate PR — the standing cost ADR-0016 already accepts for the shadcn set.

6. **Memory.** DESIGN.md gains a §"Command palette" subsection (referencing the archived mockup Frame 2), a `Command (cmdk)` → Built row in the component-status table, and a dated provenance entry; `docs/glossary.md` gains a "Command palette" entry pointing here; this ADR records the dependency decision.

## Alternatives considered

**Hand-roll the palette (no new dependency).** Tempting given how much substrate is already present (`navForRole`, the Radix Dialog, the tokens). Rejected: the *value* of a palette is the list behaviour — fuzzy filtering, roving keyboard focus, `aria-selected`, type-ahead — and reimplementing that accessibly is exactly the kind of subtle, easy-to-regress work a small, well-tested, canonical library exists to remove. The dependency we would save is tiny; the correctness we would put at risk is not.

**`kbar` (or another palette framework).** A richer palette toolkit. Rejected: it is heavier, imposes its own action-registry/store model (the palette would no longer be a thin reader of `lib/nav.ts`), and ships styling that fights the design system. `cmdk` is the minimal primitive that does only the list/keyboard/filter job and leaves styling and data to us — the better fit for a navigation-only palette wired to an existing nav source.

**Build it on the existing `Popover` primitive.** `popover.tsx` is already in the tree (no new dependency). Rejected: a popover is not a modal and has none of the command-list semantics — no filtering, no roving focus, no `aria-selected`, no focus trap. We would be hand-rolling commitment-1's work *inside* a popover; the mockup specifies a centered modal palette, not an anchored popover.

**Add shadcn's `Dialog` dependency to use `CommandDialog` as-is.** The most literal path to shadcn's upstream. Rejected as unnecessary: the umbrella `radix-ui` already vendors `@radix-ui/react-dialog`, so the modal wrapper is a dozen lines against an installed primitive — adding a dialog dependency to avoid writing them would violate the "no new top-level dependency without a reason" rule for no benefit. `cmdk` stays the *only* new dependency.

**Status quo — no palette.** Rejected: the mockup and `lib/nav.ts` were both built for it, it is the ratified close of Phase 1, and a keyboard-first jump-to-any-destination is real daily-use value for the CEO/office staff (the same deferred-Phase-1-polish category as the BS-date and Home-dashboard work shipped in the open Phase-2 window).

## Consequences

### What this makes easier

Every authenticated destination becomes reachable in two keystrokes from anywhere in the app, without hunting the sidebar — the keyboard-first IA the shell was designed to support. Because the palette reads `navForRole(role)`, it is automatically correct and role-filtered, and it can never drift from the sidebar. The list/keyboard/accessibility behaviour is owned by a small, maintained, canonical library rather than by us. And because the styling is re-pointed to `@theme` and guarded by CI, the palette is design-system-faithful by construction.

### What this makes harder

One new top-level dependency enters `apps/web` — a supply-chain and version-coordination surface (mitigated: `cmdk` is small, MIT, widely used, React-19-verified, and Dependabot-tracked per ADR-0012). The `command.tsx` copy-in joins the manually-tracked shadcn set (ADR-0016's standing cost). The palette is a client island (the shell already is, so no new server/client boundary).

### Costs we accept

- **A dependency where a hand-roll was conceivable.** We accept it for the accessibility correctness and the small, canonical surface — the same trade the rest of the shadcn set already makes.
- **Manual upstream tracking** for one more component (ADR-0016).
- **Navigation-only in v1.** No resource search yet; that is a later-phase extension on the same primitive.

## Revisit when

- **Resource/data search is wanted** (jump to a specific vehicle, trip, or invoice) — extend the palette with async result groups behind the same `cmdk` primitive; this is the anticipated Phase-2+ follow-up.
- **`cmdk` majors** past the pinned `^1.1.1` and changes the `Command` API or its React peer range — re-verify the re-point and the keyboard/focus behaviour, and re-apply the upstream diff per ADR-0016.
- **A standalone `Dialog` primitive is copied in** (when a non-command modal is needed) — the palette's internal Radix-Dialog wrapper can then be reconciled with it, and the DESIGN.md Dialog row flips from contract-only to built at that point, not this one.

## Relationship to prior ADRs

- **Extends ADR-0016 (base design system — shadcn-ui copy-paste-not-install)** and **ADR-0019 (Next.js / Tailwind / shadcn frontend stack):** `cmdk` is shadcn's `Command` engine; `command.tsx` follows the same copy-in + manual-upstream-tracking discipline as `select.tsx`/`popover.tsx`.
- **Consumes ADR-0007/0008 (design-first)** and the locked app-shell mockup verbatim (Frame 2 is the palette's visual contract); the palette is wired to the `lib/nav.ts` nav source the same program established.
- **Honours ADR-0012 (security baseline):** the new dependency is Dependabot- and SBOM-tracked like every other.
- **Is the PO-confirmation vehicle** for the new top-level dependency, per CLAUDE.md — ratified by merging the T7 PR.
