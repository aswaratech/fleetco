# ADR-0019: Next.js, Tailwind 4, and shadcn-ui as the frontend stack

- **Status:** Accepted
- **Date:** 2026-05-20
- **Decider:** Product owner (CEO)

## Context

`docs/architecture/overview.md` and `CLAUDE.md` name Next.js (with the App Router) as the frontend framework and Tailwind CSS as the styling system, with the design system itself coming from `docs/design/DESIGN.md` (per ADR-0007, customized from shadcn-ui per ADR-0016). The frontend stack has been named in these documents but no ADR has explained why those three together — Next.js, Tailwind, and shadcn-ui — over alternatives. ADR-0018 closed the equivalent gap for the API stack (NestJS + nestjs-pino + Sentry); this ADR is the symmetric closure for the frontend.

The threshold for an ADR per BOOTSTRAP step 7 is "would a future session need to know this?" A future session reading `apps/web` would see Next.js App Router routing, Tailwind 4 CSS-first tokens, and a shadcn-ui-shaped components folder, with no obvious explanation of why those three. The reasoning must be in the repo before the session that asks "why not Remix?" or "why Tailwind 4 instead of Tailwind 3?" or "why both Tailwind and shadcn-ui — isn't shadcn-ui already Tailwind?" arrives.

The three choices are interdependent. Next.js provides the application framework and routing. Tailwind provides the styling primitive that DESIGN.md derives from. shadcn-ui provides the component primitives that compose Tailwind utilities into application UI. Choosing one without the others is incoherent: Next.js without Tailwind makes DESIGN.md's derivation chain harder; Tailwind without shadcn-ui means re-implementing the accessible primitives (Dialog, Sheet, Combobox) shadcn-ui already provides on top of Radix; shadcn-ui without Next.js loses the framework integration the App Router was designed for. The three are best understood as one decision about the frontend stack, which is why they land in one ADR rather than three.

The decision is being made at Phase 0 Ticket 8 — the ticket that first creates `apps/web` as a runnable process. The ADR lands together with that code so that future readers see the decision and its first implementation in one diff.

## Decision

The FleetCo admin web at `apps/web` is built on **Next.js 15** with the **App Router**, **React 19** (the React major Next.js 15 pins), **Tailwind 4** with its CSS-first `@theme` model, and **shadcn-ui** consumed in its native copy-paste-not-install mode (per ADR-0016).

The five specific commitments are:

1. **Framework: Next.js 15.** Current LTS-ish major as of 2026-05-20. App Router (not Pages Router). Server Components are the default; Client Components are opt-in via `"use client"`.

2. **React: 19.** Pinned by Next.js 15. We do not pick a React major separately; we follow Next.js's pin.

3. **Styling: Tailwind 4.** CSS-first configuration: design tokens live in an `@theme { ... }` block in `apps/web/src/app/globals.css` rather than in a `tailwind.config.ts`. PostCSS plugin is `@tailwindcss/postcss`. No `tailwind.config.ts` file is created. DESIGN.md's three references to `apps/web/tailwind.config.ts` are updated as part of this ADR's implementing ticket to point at the new `@theme` location.

4. **Component library: shadcn-ui** (per ADR-0016), copy-paste-not-install. `apps/web/components.json` is configured with `style: new-york`, `baseColor: zinc`, `cssVariables: true`, and aliases under `@/components`, `@/components/ui`, `@/lib`, `@/lib/utils`. The `cn()` helper in `apps/web/src/lib/utils.ts` provides the canonical class-merging utility (`clsx` + `tailwind-merge`). Actual shadcn-ui components are added on-demand from Ticket 10 onward (`pnpm dlx shadcn@latest add <name>`).

5. **Design-token drift discipline.** A Vitest test at `apps/web/test/design-token-drift.test.ts` parses DESIGN.md's color-token Markdown table and the `@theme` block in `globals.css` and asserts equality of hex values. CI (Ticket 11) runs this test on every PR. The contract is per ADR-0007 and DESIGN.md's "How this file relates to code" section; this ADR is the implementation commitment.

## Alternatives considered

### For the framework

**Remix / React Router 7.** Remix's loader/action model is a clean alternative to App Router's server-component pattern. Rejected because (a) Next.js has higher AI-agent training mass per ADR-0005's argument; (b) better-auth's Phase-0 integration story is Next.js-first (per ADR-0015); (c) shadcn-ui's ecosystem (and most of the Tailwind UI corpus) assumes Next.js, which compounds the AI-agent advantage.

**Vite + React Router (no SSR framework).** The lightest option. Rejected because the FleetCo admin web will need server-rendered routes from day one (auth checks server-side, form actions server-side, dynamic data fetching) and reinventing what Next.js gives us by default is not a one-person-team trade.

**Pages Router (Next.js 15 still supports it).** Mature; well-documented. Rejected because App Router is the forward-looking pattern Next.js itself recommends, has better React-Server-Components support, and is where new Next.js features land first. Starting on Pages Router would commit us to a migration we have no reason to take.

### For React major

**React 18.** Stable; ecosystem-complete. Rejected because Next.js 15 pins React 19 and there is no reason to fight the framework's pin.

### For the styling system

**Tailwind 3.** Latest in v3; honors DESIGN.md's existing `tailwind.config.ts` references as-is. Rejected because (a) Tailwind 4 is the current major and starting a greenfield project on a previous major commits us to a migration we don't need, (b) Tailwind 4's CSS-first `@theme` model is closer to "tokens are CSS" which fits DESIGN.md's "tokens are documented Markdown that maps to CSS variables" mental model better, (c) the v3 line will reach end-of-life before FleetCo's Phase 1 closes. The cost is one surgical edit to DESIGN.md's three references to `tailwind.config.ts` in this same PR; the cost is paid once and immediately.

**Vanilla CSS or CSS Modules.** Rejected because ADR-0007 commits DESIGN.md to be the source of truth for a token-driven design language, and Tailwind's utility-first model is the most direct fit for token-driven derivation. Hand-authored CSS would force every component to translate DESIGN.md tokens back into CSS by hand, which is the drift problem we are explicitly trying to prevent.

**styled-components / Emotion (CSS-in-JS).** Rejected because (a) the React 19 + RSC story for CSS-in-JS is more complex than utility CSS, (b) AI agents have stronger training mass on Tailwind than on CSS-in-JS, (c) the runtime cost of CSS-in-JS is not free for an admin UI we want to feel fast.

### For the component library

**Material UI / Chakra UI / Mantine / build-from-scratch.** Rejected per ADR-0016. Material UI's opinions fight customization; Chakra/Mantine's install-not-copy means library version bumps can change UI behavior; building from scratch is a poor use of solo-founder time. These alternatives are referenced rather than re-litigated; ADR-0016 carries the substance.

(shadcn-ui itself was chosen in ADR-0016; this ADR does not re-litigate that decision. The alternatives above are listed for completeness with ADR-0018's structural symmetry.)

### For the drift-detection mechanism

**No drift test.** Rejected because the discipline ADR-0007 commits us to is mechanical drift detection; manual review degrades, and the project's "stale memory is worse than missing memory" principle (CLAUDE.md Part 1) demands enforcement.

**Generated `tailwind.config.ts` (or `@theme` block) from `DESIGN.md` as a build step.** Rejected for Phase 0 because the manual-sync-with-test approach is simpler, easier to reason about in PR diffs, and good enough. Revisit when drift incidents recur.

**Machine-readable `docs/design/tokens.json` as the shared source for both DESIGN.md and `@theme`.** Rejected for Phase 0 because (a) it reopens ADR-0007's manual-sync decision, which is a real change rather than just an implementation choice, (b) DESIGN.md is meant to be a human-readable design document, not a config file with prose attached. Revisit if drift becomes a real problem at the same threshold as the build-step option.

**`remark` + `remark-parse` Markdown AST library.** Rejected in favor of a ~70-line hand-rolled parser for the same reasoning as elsewhere in the project: smaller supply-chain surface (ADR-0012), fully reviewable in a single screen, no dependency drift risk on a niche library.

## Consequences

### What this makes easier

Every Phase 1 UI slice has a known shape: an App-Router route under `apps/web/src/app/`, server components by default, Tailwind utility classes that reference @theme tokens, shadcn-ui components copied in on demand from the registry. Future agents see this consistency in `apps/web/src/app/login/` and produce code that fits.

DESIGN.md's "How this file relates to code" contract is now load-bearing in CI (once Ticket 11 wires CI). Any PR that drifts the @theme block away from DESIGN.md (or vice versa) without updating both files fails the drift test. The drift discipline is mechanical, not review-dependent.

The CSS-first @theme model means the design tokens live in the same place the application uses them, removing the indirection that a separate `tailwind.config.ts` would create. Tokens added later (typography, spacing customizations) live in the same `@theme` block; the drift test grows to cover them.

shadcn-ui components added later integrate via the standard `--background` / `--foreground` / etc. CSS variable names, which `apps/web/src/app/globals.css` aliases to DESIGN.md's semantic tokens (`color.surface.canvas`, `color.text.primary`, etc.). The two naming systems coexist via a single layer of aliasing in a `:root { }` block; the drift test reads `@theme` only.

### What this makes harder

The drift test only covers token types that have landed in `@theme`. Phase 0 covers color tokens fully; typography, spacing, sizing, borders, and shadows rely on Tailwind 4's defaults (which match DESIGN.md as-authored). When DESIGN.md introduces a customized non-color token (e.g., a custom radius value, a custom shadow level), the @theme block AND the drift test must grow together to keep coverage honest. Future PRs that introduce custom tokens must extend the drift test in the same diff.

The shadcn-ui `cn()` helper and CSS-variable aliasing layer in globals.css are convention, not enforcement. A component author who hardcodes `bg-zinc-50` instead of `bg-surface-canvas` will silently bypass the design system. Code review catches this; the drift test does not.

DESIGN.md's three references to `apps/web/tailwind.config.ts` were stale at the moment ADR-0019 was accepted and are updated by the same PR that introduces ADR-0019. ADR-0016's Consequences section similarly mentions `tailwind.config.ts`; per the ADRs-are-append-only discipline (BOOTSTRAP step 7), ADR-0016 is NOT edited. A future reader who finds the stale reference in ADR-0016 reads this ADR (chronologically later) for the corrected reference — that is what this paragraph is for.

### Costs we accept

- **Next.js's surface area is larger than a hand-rolled SPA.** App Router conventions, server/client component split, font loading, image optimization, middleware: all real things to learn. The discipline payoff (RSC, server actions, conventions that AI agents recognize) justifies it.
- **Tailwind 4's CSS-first model is newer than v3.** Documentation maturity, ecosystem catch-up, and shadcn-ui's CLI behavior on v4 are all still evolving. Mitigation: hand-roll the init artifacts so we own what's in the repo; future shadcn `add` commands can be reviewed before merging.
- **shadcn-ui copy-paste means manual upstream tracking** (per ADR-0016). Re-stated here for completeness.
- **The drift test only covers what's in `@theme`.** Phase 0 ships with color drift coverage; the test grows as DESIGN.md tokens diverge from Tailwind defaults. Explicitly named in "What this makes harder" above; not a tech-debt entry because it's the design of the test, not debt.
- **No Tailwind config file** means future tooling that expects `tailwind.config.ts` (e.g., third-party plugins that read theme programmatically) may need to be adapted. Acceptable for FleetCo because we control the tooling that consumes the theme.

## Revisit when

- **Next.js 16:** When Next.js 16 ships with a stable App Router and a clear migration path, the cost of staying on 15 starts to compound. The revisit-when is "Next.js 16 reaches GA and has been stable for two minor releases," not "Next.js 16 enters beta."
- **Tailwind 5 or a breaking 4.x change:** When Tailwind ships a major that breaks @theme syntax, the drift test parser and the globals.css block both need updating. The revisit signal is the Tailwind release notes, not a measured pain point.
- **Drift-detection becomes inadequate:** If the manual sync produces repeated drift incidents (more than two in any quarter), the build-step generator option becomes the right move.
- **shadcn-ui copy-paste breaks under Tailwind 5 or future React:** If a future shadcn-ui component cannot be copied cleanly because of upstream architectural change, ADR-0016's "Revisit when" triggers.
- **A measured AI-agent-quality regression on Next.js patterns** versus some other framework reaches the threshold where switching is rational. The cost of framework migration is large; this is a hedge, not an expectation.
- **The aliasing layer (`--background: var(--color-surface-canvas)`) becomes unwieldy** as more shadcn-ui components land. If a future ticket introduces a component that needs ten new aliases, the aliasing-layer approach itself is reconsidered.
