# DESIGN.md — FleetCo Design System

> **STATUS: Authored (Phase 0).** This file is the canonical design system for FleetCo. Tokens listed here are consumed by the `@theme` block in `apps/web/src/app/globals.css` (Tailwind 4 CSS-first model per ADR-0019); drift between the two is the failure mode and is enforced by a CI test (see [How this file relates to code](#how-this-file-relates-to-code)). The base design system is **shadcn-ui** per ADR-0016; the design-as-source-of-truth discipline is per ADR-0007. Locked HTML mockups for specific slices live at `docs/design/slices/<slice-name>.html` per ADR-0008. The voice is quiet, professional, and technical: this is an instrument, not a marketing surface.

## Foundations

### Color tokens

Token names use a semantic scheme (`color.surface.canvas`, not `zinc-50`) so the meaning survives palette evolution. The `@theme` block in `apps/web/src/app/globals.css` declares these semantic tokens as CSS variables (`--color-surface-canvas`, `--color-accent-primary`, etc.); a sibling `:root` block in the same file aliases shadcn-ui's standard variable names (`--background`, `--primary`, `--ring`, and so on) onto our semantic tokens, so shadcn-ui components copied in Ticket 10 onward reference standard names that resolve to our values. FleetCo ships **light mode only** in v1; the dark palette is deferred until a measured need surfaces, at which point a dedicated ADR adds the dark token values without renaming the semantic tokens documented here.

The accent color is **emerald** (`emerald-600` primary, `emerald-700` hover). The neutral palette is **zinc**. Status colors are emerald/amber/red/blue. No other chromatic hues are used in the system.

| Token | Value (Tailwind) | Hex | Usage |
| --- | --- | --- | --- |
| `color.surface.canvas` | `zinc-50` | `#fafafa` | Page background |
| `color.surface.raised` | `white` | `#ffffff` | Cards, panels, table rows |
| `color.surface.elevated` | `white` | `#ffffff` | Modals, popovers, dropdowns (paired with elevation shadow) |
| `color.surface.muted` | `zinc-100` | `#f4f4f5` | Table headers, disabled inputs, subdued areas |
| `color.text.primary` | `zinc-900` | `#18181b` | Body text |
| `color.text.secondary` | `zinc-700` | `#3f3f46` | Secondary text, labels |
| `color.text.muted` | `zinc-500` | `#71717a` | Placeholder, captions, helper text |
| `color.text.inverse` | `zinc-50` | `#fafafa` | Text on accent or dark backgrounds |
| `color.text.accent` | `emerald-700` | `#047857` | Links, accent text |
| `color.border.subtle` | `zinc-200` | `#e4e4e7` | Default borders, table row dividers |
| `color.border.strong` | `zinc-300` | `#d4d4d8` | Input borders, separators with emphasis |
| `color.border.focus` | `emerald-500` | `#10b981` | Focus rings |
| `color.accent.primary` | `emerald-600` | `#059669` | Primary buttons, active nav, brand chip |
| `color.accent.primary-hover` | `emerald-700` | `#047857` | Primary button hover, pressed |
| `color.accent.foreground` | `white` | `#ffffff` | Text on accent surfaces |
| `color.status.success` | `emerald-600` | `#059669` | Success badges, completed states |
| `color.status.warning` | `amber-500` | `#f59e0b` | Warning badges, expiring-soon states |
| `color.status.error` | `red-600` | `#dc2626` | Error badges, destructive buttons, validation errors |
| `color.status.info` | `blue-600` | `#2563eb` | Informational badges (rare; prefer neutral) |

**When not to use.** Status hues are reserved for status. Emerald is not a generic decoration color outside its accent role; red is not a warning color (use amber); blue is reserved for informational badges and is rarely needed. Never combine three or more chromatic hues in one surface. Tables stay on neutral backgrounds with a single status column or badge rather than row-level chromatic coding (see anti-pattern #7).

### Typography

One type stack carries both Latin and Devanagari: **Inter** is the Latin primary, **Noto Sans Devanagari** is the Devanagari fallback, in the same `font-sans` stack. Mixed-script text (e.g., "बिशेष अनुमति expires on 2026-09-15") renders per-character via the browser's font-fallback chain — no explicit language switching needed. Tabular numerals (`tabular-nums`) are enabled by default on numeric columns in tables so digits align across rows.

| Token | Tailwind | Size | Line height | Usage |
| --- | --- | --- | --- | --- |
| `text.xs` | `text-xs` | 12px | 16px | Captions, badges, helper text |
| `text.sm` | `text-sm` | 14px | 20px | Table cells, form field text, default for dense surfaces |
| `text.base` | `text-base` | 16px | 24px | Body text, paragraph content |
| `text.lg` | `text-lg` | 18px | 28px | Section headings, card titles |
| `text.xl` | `text-xl` | 20px | 28px | Page subheadings |
| `text.2xl` | `text-2xl` | 24px | 32px | Page titles |

| Token | Tailwind | Weight | Usage |
| --- | --- | --- | --- |
| `weight.regular` | `font-normal` | 400 | Body text |
| `weight.medium` | `font-medium` | 500 | Buttons, emphasized labels, table headers |
| `weight.semibold` | `font-semibold` | 600 | Headings, page titles |

| Token | Tailwind | Stack |
| --- | --- | --- |
| `font.sans` | `font-sans` | `Inter, "Noto Sans Devanagari", system-ui, -apple-system, sans-serif` |
| `font.mono` | `font-mono` | `ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace` |

Monospace is used only for code references and copy-friendly identifiers (Bluebook numbers, vehicle plates, IDs in URLs). Body text and table digits use `font-sans` with `tabular-nums`; the digits in Inter are designed to read cleanly in tabular contexts.

### Spacing

The spacing scale is base-4 — Tailwind's default. Density tuning across the board uses tighter step sizes for component internals: input height is `36px` (h-9) rather than shadcn-ui's `40px` (h-10); card padding is `16px` (p-4) rather than `24px`; table row vertical padding is `12px` (p-3) by default and `8px` (p-2) in the compact variant.

| Token | Tailwind | Pixels | Common usage |
| --- | --- | --- | --- |
| `space.0` | `0` | 0 | None |
| `space.1` | `1` | 4 | Tight icon spacing, badge padding |
| `space.2` | `2` | 8 | Compact table row padding |
| `space.3` | `3` | 12 | Default table row padding, input vertical padding |
| `space.4` | `4` | 16 | Card padding, form field vertical spacing |
| `space.6` | `6` | 24 | Section spacing, modal padding |
| `space.8` | `8` | 32 | Page horizontal padding |
| `space.12` | `12` | 48 | Large section breaks |
| `space.16` | `16` | 64 | Page header bottom margin |

### Sizing

Component sizes are tightened from shadcn-ui's defaults to suit table-heavy ERP density. The default input and default button both stand at 36px to keep form rows tight; the compact table variant goes tighter still.

| Token | Tailwind | Pixels | Usage |
| --- | --- | --- | --- |
| `size.button.sm` | `h-8` | 32 | Compact button (toolbar, table-row actions) |
| `size.button.default` | `h-9` | 36 | Default button |
| `size.button.lg` | `h-10` | 40 | Large button (primary CTA on a focused form) |
| `size.input.default` | `h-9` | 36 | Default input height (tightened from shadcn-ui's `h-10`) |
| `size.input.lg` | `h-11` | 44 | Search bar, large form |
| `size.icon.sm` | `h-4 w-4` | 16 | Inline icons, small buttons |
| `size.icon.default` | `h-5 w-5` | 20 | Default icons, button icons |
| `size.icon.lg` | `h-6 w-6` | 24 | Header icons, prominent toggles |
| `size.card.padding` | `p-4` | 16 | Card content padding |
| `size.modal.sm` | `max-w-sm` | 384 | Confirmation dialogs |
| `size.modal.md` | `max-w-md` | 448 | Small forms |
| `size.modal.lg` | `max-w-2xl` | 672 | Standard forms |
| `size.modal.xl` | `max-w-4xl` | 896 | Wide forms, multi-column layouts |

### Borders and corners

Border weights are **1px** everywhere. There is no 2px+ tier. Emphasis comes from color (`color.border.strong`, `color.border.focus`), not from thickness — thicker borders read as ornament and fight the instrument-like voice. Data surfaces (tables) stay sharp (`radius.none`) so rows align visually with adjacent rows.

| Token | Tailwind | Pixels | Usage |
| --- | --- | --- | --- |
| `radius.none` | `rounded-none` | 0 | Tables (data surfaces stay sharp) |
| `radius.sm` | `rounded-sm` | 2 | Badges, small chips |
| `radius.default` | `rounded` | 4 | Buttons, inputs, cards (tightened from shadcn-ui's `6px`) |
| `radius.lg` | `rounded-lg` | 8 | Modals, popovers |
| `radius.xl` | `rounded-xl` | 12 | Reserved; not used in v1 |

**Focus ring — the one deliberate exception.** The 1px / no-2px+ rule above governs **structural borders** (an element's resting edge). A **focus ring** is not a border: it is a transient `:focus-visible` affordance that sits outside the box model and exists only while the control is focused. It is intentionally thicker so a keyboard user cannot miss the focused control. `focus.ring.width` is **3px** (rendered in `color.border.focus` at 50% opacity) — the single deliberate exception to the 1px rule, applying to rings only, never to a resting border. It is single-sourced as `--focus-ring-width: 3px` in the `@theme` block; controls consume it via `ring-[length:var(--focus-ring-width)]`, and the design-token-drift test pins the DESIGN.md ↔ `@theme` match.

| Token | Tailwind | Pixels | Usage |
| --- | --- | --- | --- |
| `focus.ring.width` | `ring-[length:var(--focus-ring-width)]` | 3 | Focus-ring thickness (the one sub-1px-rule exception) |

### Shadows and elevation

Three elevation levels are sufficient for an ERP surface; deeper elevation reads as iOS-app, not as a tool.

| Token | Tailwind | Usage |
| --- | --- | --- |
| `elevation.flat` | `shadow-none` | Table rows, inline panels, default |
| `elevation.raised` | `shadow-sm` | Cards, dropdowns, sticky headers |
| `elevation.elevated` | `shadow-md` | Modals, popovers, content-over-content |

Motion principles (one stack for the whole product):

- **Default duration:** `150ms`.
- **Default easing:** `cubic-bezier(0.2, 0, 0, 1)` (out-cubic).
- **Allowed:** hover transitions, focus ring fade-in, modal enter/exit, dropdown open/close.
- **Forbidden:** page-level transitions, decorative animation, motion as branding (see anti-pattern #5).

## Components

Each component subsection names its shadcn-ui upstream so a future agent can compare against the latest published version and decide whether to pull in an upstream change. Component code is owned in-tree at `apps/web/src/components/ui/<name>.tsx` per ADR-0016's copy-paste-not-install model; the subsections below document the contract DESIGN.md commits FleetCo to, not the implementation detail.

### Component status (built vs contract)

DESIGN.md documents the **contract** for each component; not every contract is implemented yet. Check this table before importing — a component marked *contract only* has **no file** under `apps/web/src/components/ui/` and importing it will fail. Each row is flipped to **Built** by the PR that implements it (the §Components subsections describe the contract regardless of status).

| Component | Status | Where |
| --- | --- | --- |
| Button | Built | `ui/button.tsx` |
| Input | Built | `ui/input.tsx` |
| Label | Built | `ui/label.tsx` |
| Form | Built | `ui/form.tsx` |
| Table | Built | `ui/table.tsx` |
| Select (Radix) | Built | `ui/select.tsx` |
| Popover | Built | `ui/popover.tsx` |
| AlertDialog | Built | `ui/alert-dialog.tsx` |
| Badge | Built | `ui/badge.tsx` |
| `<NepaliDate>` (display) | Built | `components/nepali-date.tsx` (over `lib/nepali-date.ts`) |
| `<NepaliDatePicker>` (input) | Built | `components/nepali-date-picker.tsx` (ADR-0032) |
| Card | Built | `ui/card.tsx` |
| Dialog (non-alert modal) | Contract only | — |
| Sheet (drawer) | Contract only | — |
| Tabs | Contract only | — |
| Checkbox | Built | `ui/checkbox.tsx` |
| Textarea | Built | `ui/textarea.tsx` |
| Skeleton | Built | `ui/skeleton.tsx` |
| Breadcrumb | Contract only | — |
| Pagination | Built | `ui/pagination.tsx` |
| SortableHeader / SortArrow | Built | `ui/sortable-header.tsx` |
| DetailRow | Built | `ui/detail-row.tsx` |
| `<Money>` (display) | Built | `components/money.tsx` (over `formatNpr`) |
| `<MoneyInput>` (input) | Contract only — use `rupeesToPaisa` / `paisaToRupeesInput` (`lib/money.ts`) until built | — |
| Navigation shell (sidebar / top bar) | Built | `components/app-shell/` |

**Provenance of in-tree components (as of 2026-05-21, Ticket 10).** The first four shadcn-ui components copied into `apps/web/src/components/ui/` were `button.tsx`, `input.tsx`, `label.tsx`, and `form.tsx`, pulled via `pnpm dlx shadcn@latest add ...` with the CLI at version `4.7.0` and the unified `radix-ui` peer at `1.4.3`. Subsequent component additions append a one-line note here naming the CLI version at the time of addition (per ADR-0016's "maintaining a short note... referencing the shadcn-ui version the component was copied from").

- **2026-05-21 (Vehicles iter 1):** `table.tsx` added. Shape matches shadcn-ui's `new-york` Table primitive (the style configured in `apps/web/components.json`) with FleetCo density tuning applied inline: default row vertical padding 12px (`p-3`), headers `font-medium` and not uppercase, row separators in `color.border.subtle`. Hand-written rather than CLI-pulled to keep iter-1's added surface tight; the next CLI invocation will reconcile if upstream has changed meaningfully.
- **2026-05-25 (Vehicles iter 3):** `alert-dialog.tsx` added. Source copied verbatim from `https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/alert-dialog.tsx` and lightly trimmed (the `AlertDialogMedia` variant was dropped as unused; import paths re-pointed to `@/lib/utils` and `@/components/ui/button`). The underlying Radix primitive is `@radix-ui/react-alert-dialog@1.1.15`, already vendored by the umbrella `radix-ui@1.4.3` peer that the iter-1/iter-2 components import from — no new top-level dependency was added. File-level provenance comment in the component itself records the fetch URL and date for upstream tracking.
- **2026-05-26 (Vehicles iter 4):** `select.tsx` added. Source copied from `https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/select.tsx` (fetched 2026-05-26). Underlying primitive is `@radix-ui/react-select` vendored via the umbrella `radix-ui@1.4.3` peer (same import shape as `button.tsx`, `form.tsx`, `alert-dialog.tsx` — no new top-level dependency). Local edits to upstream: (a) the three lucide-react icon imports were initially replaced with byte-equivalent inline SVG components because `lucide-react` was not yet a dependency of `apps/web` — **reversed 2026-06-06 (see the 2026-06-06 entry below): `lucide-react` was adopted, the inline substitutes were removed, and the icons now import from `lucide-react` (`Check` / `ChevronDown` / `ChevronUp`), discharging the tech-debt entry.** (b) Import paths re-pointed to `@/lib/utils`. Tailwind class strings preserved byte-for-byte; the CSS variable aliases in `apps/web/src/app/globals.css` already map `--background`, `--input`, `--ring`, `--popover`, `--accent`, etc. onto the FleetCo semantic tokens. File-level provenance comment in the component itself records the fetch URL, date, and (as of 2026-06-06) the lucide-react adoption rationale for upstream tracking.
- **2026-06-05 (BS dates N3):** `badge.tsx` added. Hand-written (not CLI-pulled) as a CVA `<span>` mirroring `button.tsx`'s `cva`/`cn` shape — no new top-level dependency. A status indicator, never an action (anti-pattern #2). Its five variants (`warning`/`error`/`success`/`info`/`neutral`) bind only to `color.status.*` / surface / text tokens already declared in DESIGN.md → `globals.css` `@theme`, so it introduces no new design token and the design-token-drift test is untouched. Implements the §"Status badges" contract verbatim (amber = expiring-soon/warning, red = error, `radius.sm` + `text.xs`, hue always paired with a text label). First consumer: the vehicle-compliance expiry badges on the Vehicle detail page (ADR-0031 §E).
- **2026-06-06 (Polish & debt sweep, P2):** `lucide-react` adopted as a direct dependency of `apps/web` — the icon library this §Iconography section already names — paying off the "`lucide-react` not yet adopted" tech-debt entry. The three inline-SVG icon substitutes in `select.tsx` (`ChevronDown` / `ChevronUp` / `Check`) and the inline `SortArrow` `<svg>` in `vehicles/page.tsx` now render from `lucide-react`'s named imports. Null visual diff: Lucide's chevron/check path data is byte-identical to the removed inline SVGs (verified against the installed `lucide-react@1.17.0`), and each call-site passes an explicit `strokeWidth` (1.5 for the size-4 chevrons, 1.75 for the size-4 Check and the 12px sort arrow) plus `aria-hidden`, matching the prior render and the §Iconography "Stroke width" rule (1.5/1.75, **not** Lucide's default of 2). No new design token — the design-token-drift test is untouched. Isolated to its own PR (`feat/lucide-react-adoption`), mirroring the `bullmq` / `react-leaflet` / `nepali-date-converter` dependency-isolation precedent.
- **2026-06-06 (BS date-picker B1):** `popover.tsx` added. Source copied from `https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/popover.tsx` (fetched 2026-06-06). Underlying primitive is `@radix-ui/react-popover` vendored via the umbrella `radix-ui@1.4.3` peer (same import shape as `select.tsx` / `alert-dialog.tsx` — no new top-level dependency; ADR-0032 commitment 1, hand-built BS date-picker over the installed Radix Popover). Local edits to upstream: (a) color classes mapped from shadcn's `:root` aliases to FleetCo's `@theme` semantic tokens (`bg-popover` → `bg-surface-elevated`, `text-popover-foreground` → `text-text-primary`, explicit `border-border-subtle`), because this project's `globals.css` exposes only the `--color-*` `@theme` tokens as Tailwind utilities — the shadcn `:root` aliases are plain CSS variables, not theme colors, so `bg-popover` generates no utility here; no new design token is introduced, so the design-token-drift test is untouched. (b) The upstream entrance/exit animation utilities are kept for upstream-diff fidelity but are inert (the project ships no `tailwindcss-animate` plugin). (c) Import path re-pointed to `@/lib/utils`. File-level provenance comment in the component records the fetch URL, date, and the token-mapping rationale. First consumer: `<NepaliDatePicker>` (the BS month-grid date input, ADR-0032).
- **2026-06-22 (Phase 0b leaf primitives):** `card.tsx`, `skeleton.tsx`, `textarea.tsx`, `checkbox.tsx` added under `ui/`, plus the FleetCo `<Money>` display component at `components/money.tsx`. All hand-written to match the shadcn-ui `new-york` shapes (Skeleton/Card/Textarea are styled elements with no Radix primitive; Checkbox wraps `@radix-ui/react-checkbox` via the umbrella `radix-ui@1.4.3` peer — no new top-level dependency). Each is re-pointed from shadcn's dead `:root` aliases to FleetCo's `@theme` semantic utilities — the now-merged consumption guard (`apps/web/test/design-token-consumption.test.ts`) auto-scans every `ui/*.tsx` and fails on any dead alias: `bg-card`/`text-card-foreground` → `bg-surface-raised`/`text-text-primary`, `bg-accent` → `bg-surface-muted`, `border-input` → `border-border-strong`, `data-[state=checked]:bg-primary` → `bg-accent-primary`, `*-destructive` → `*-status-error`. FleetCo density/radius applied (Card `p-4` + `rounded`; controls `rounded` 4px; the focus ring uses the tokenized `--focus-ring-width`); inert `dark:` variants dropped. `<Money>` wraps `formatNpr` with `tabular-nums`. No new design token — the design-token-drift test is untouched. These discharge the matching contract-only rows in the Component-status table above.
- **2026-06-22 (Phase 1 app-shell program):** the navigation shell and the shared list components landed. (a) `lib/nav.ts` — the single nav source (five PO-ratified groups: Operations / Money / Maintenance / Reports / Logs) feeding both the sidebar and the home quick-links strip; `navForRole` gates by role (UI affordance only — the API's `permissions.ts` is the security boundary). (b) `components/app-shell/app-shell.tsx` — the §Navigation shell (a 240px↔64px collapsible sidebar persisted to `localStorage`, active item `bg-accent-primary` + `text-accent-foreground`, a top bar with a Popover-backed user menu + sign-out), hosted by `app/(app)/layout.tsx` — the route group wrapping every authenticated page with one auth gate + a `/me` role fetch. It reuses the built Popover (Dialog / Sheet / DropdownMenu stay contract-only); the ⌘K command palette is deferred to its own `cmdk` dependency ticket, and the mobile Sheet drawer is deferred (still contract-only). (c) `ui/sortable-header.tsx` / `ui/pagination.tsx` / `ui/detail-row.tsx` + `lib/list-params.ts` — the four helpers previously hand-redefined in ~12 pages each, extracted verbatim (a `basePath` prop replaces the hardcoded route; `SortArrow` renders Lucide chevrons, byte-identical to the inline SVG per the 2026-06-06 sweep). All consume `@theme` utilities (the consumption guard scans the `ui/` additions and passes); no new design token, so the design-token-drift test is untouched. The home dashboard's inline sign-out and "Signed in as `<email>`" move to the top-bar user menu (see §"Home dashboard").

### Buttons

- **shadcn-ui upstream:** `Button` from `ui/button.tsx`.
- **Variants:** `primary` (emerald, default action), `secondary` (zinc, alternative action), `outline` (border-only, neutral), `ghost` (no background, low-emphasis), `destructive` (red, dangerous action), `link` (text-only, inline).
- **Sizes:** `sm` (h-8), `default` (h-9), `lg` (h-10), `icon` (h-9 w-9 square).
- **States:** default, hover, focus (visible ring in `color.border.focus`), active, disabled (opacity 50, no pointer events), loading (spinner replaces icon; label stays visible; button cannot be dismissed mid-action).
- **When to use:** one `primary` per surface (the default action the user is most likely to take); multiple `secondary` and `ghost` allowed; `destructive` for irreversible actions only.
- **Anti-patterns referenced:** #2 (badges as buttons), #3 (primary buttons in navigable cards).

### Inputs and forms

- **shadcn-ui upstream:** `Input`, `Textarea`, `Select`, `Checkbox`, `RadioGroup`, `Switch`, `Label`, `Form` (with react-hook-form + zod).
- **Text input:** `h-9`, 1px border in `color.border.strong`, `radius.default` (4px); placeholder uses `color.text.muted`; focus state shows a focus ring in `color.border.focus`.
- **Number input:** same shell as text input. For NPR/paisa entry, use the `<MoneyInput>` component (contract only today — see [Component status](#component-status-built-vs-contract); `rupeesToPaisa` / `paisaToRupeesInput` in `lib/money.ts` are the shipped converters): paisa-aware, integer entry, group separators applied on blur.
- **Date input:** use the **`<NepaliDatePicker>`** component (ADR-0032; `components/nepali-date-picker.tsx`) — a Popover-backed BS month-grid picker over the input shell; the trigger shows BS + Gregorian, the popup shows a BS month grid with Gregorian dates underlaid. The stored/submitted value stays ISO/AD (`YYYY-MM-DD`); BS is render-only. **Every date field across the app already uses it** (the earlier interim "native AD date input" note is superseded). For *display* of a date (not entry), use `<NepaliDate>` (see [Data display](#data-display)).
- **Select dropdown:** chosen by capability, not cosmetics. The **native `<select>`** is the default for in-form enumerated fields (status, category, fixed type lists) — lighter, no portal, inherits platform accessibility and mobile behavior, and well-suited to the small static option sets forms carry. Reach for the shadcn-ui **`Select`** (Radix-backed, portal-rendered, keyboard-navigable) only when the control needs what native cannot give: rendering outside the form's stacking/overflow context (the filter toolbars over tables — its current use), rich item content (icons, two-line items), or typeahead. Rule of thumb: a static set of **≲8 plain-text options inside a form is native**; portal-escape, rich items, or typeahead is the Radix `Select`. Many-option or searchable → `Combobox`. Native selects are styled to the text-input shell (1px `color.border.strong`, `radius.default`, focus ring in `color.border.focus`) so the two read as one family.
- **Multi-select:** shadcn-ui `Combobox` for complex (more than five options); a checkbox group for simple.
- **Checkbox, radio, toggle (Switch):** standard shadcn-ui; checkbox is the default for boolean fields in forms; Switch is reserved for live preference toggles ("enable notifications").
- **File upload:** simple `<Input type="file">` for Phase 1. Drag-drop affordance is deferred to Phase 2+ when GPS log uploads land.
- **Form layout:** vertical; labels above inputs; helper text below the input; error text below in `color.status.error`; required fields marked with `*` followed by a visually-hidden "(required)" for screen readers.
- **Validation timing:** on blur for text fields; on change for select/checkbox/toggle; on submit for the whole form (see anti-pattern #10).
- **Diff-against-initial-values for PATCH:** edit forms (forms that load existing data and submit a partial update) keep a snapshot of the initial values they were hydrated with, and on submit compute a shallow diff against that snapshot, sending only the keys whose value actually changed. The pattern matters whenever the API has any field-coupled rule that derives one field from another in response to a transition — the Vehicles slice's retirement-transition rule in `VehiclesService.update` is the canonical example: a status change from `RETIRED` back to `ACTIVE` clears `retiredAt` on the server side, so the form must not pre-emptively include `retiredAt` in the PATCH payload unless the user explicitly cleared it, and must not include `status` in the payload at all if the user did not change it. Sending the diff (rather than the full form snapshot) keeps both rules intact. The iter-3 Vehicles edit form (`apps/web/src/app/vehicles/[id]/edit/edit-vehicle-form.tsx`) established this pattern; the next form to load-then-PATCH (Drivers, Customers, Trips) follows the same shape. Forms that submit a full create payload do not need this discipline.
- **Loading and error states for server-rendered pages:** server-rendered pages that fetch from the API ship a sibling `loading.tsx` (Suspense skeleton matching the page's layout to keep the transition layout-stable) and `error.tsx` (`"use client"` boundary with a Retry button calling the framework-provided `reset()` and a fallback link back to the index). Auth and not-found paths are handled inside the page itself via `redirect()` and `notFound()`; the error boundary catches the unexpected residue (network failure, malformed API response). The iter-3 Vehicles detail and edit pages set this precedent; the loading skeleton uses `animate-pulse` blocks sized to the real layout, and the error surface uses DESIGN.md voice ("state the fact, no apology").
- **Anti-patterns referenced:** #10 (validation on every keystroke), #13 (English-only errors for Nepali-named fields), #14 (monetary floats).

### Tables

Tables are the primary surface for FleetCo. Particular care.

- **shadcn-ui upstream:** `Table` primitive + `DataTable` pattern (TanStack Table-backed).
- **Variants:**
  - `default` — 12px row vertical padding (`p-3`), `text-sm`. Used by every standard list (Vehicles, Drivers, Customers, Jobs).
  - `compact` — 8px row vertical padding (`p-2`), `text-xs`. Used on data-dense surfaces where the table *is* the page (Trips list, GPS events in Phase 2). The compact variant earns its use only when the row count and column density make it the better read; the default is preferred otherwise.
- **Headers:** `text-sm`, `font-medium`, `color.text.secondary`, NOT uppercase. (Uppercase headers read as marketing; lowercase headers read as instrument.) Sortable headers show a sort indicator (Lucide `ChevronUp` / `ChevronDown`) right-aligned in the cell.
- **Rows:** `text-sm` (default) or `text-xs` (compact); `color.surface.raised` background; hover state shows `color.surface.muted`; selection state shows a 4px left border in `color.accent.primary` plus a faint accent-tinted background.
- **Row separators:** 1px `color.border.subtle` between rows. No row striping (chosen over striping because separators read cleaner with `tabular-nums` columns).
- **Numeric columns:** right-aligned, `tabular-nums`, `font-sans` (mono is reserved for code, not for data).
- **Empty state:** an explicit statement of fact (no apology, no decoration) plus an optional CTA. Examples: "No trips registered." or "No trips matching `<filter text>`."
- **Pagination:** page-number-based at the bottom; default 50 rows per page; selectable 25 / 50 / 100; total row count visible.
- **Anti-patterns referenced:** #7 (color-coding rows), #8 (oversized icons).

### Cards

- **shadcn-ui upstream:** `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`.
- **Variants:** `default` (raised, `size.card.padding`) and `embedded` (inside another card; flat).
- **Header:** `text-lg`, `font-semibold` title; optional `text-sm`, `color.text.muted` description; optional action row right-aligned.
- **Body:** variable.
- **Footer:** action row right-aligned; optional left-aligned secondary text (e.g., "Last updated 2 hours ago").
- **When to use:** grouping related fields on detail pages; summary panels; not for navigation tiles (see anti-pattern #3).

### Modals and drawers

- **shadcn-ui upstream:** `Dialog` (modal), `Sheet` (drawer), `AlertDialog` (confirmation).
- **Modal (`Dialog`):** for tasks that fit in ≤ 1 screen; sizes `sm` / `md` / `lg` / `xl` (per Sizing tokens).
- **Drawer (`Sheet`):** slides in from the right for long lists, secondary forms, batch operations. Drawers are for peripheral panels (filters, detail-on-hover, transient state); modals are for centered tasks the user must complete or cancel.
- **Confirmation (`AlertDialog`):** destructive actions only; named action (e.g., "Delete trip"), named cancel (e.g., "Keep trip"). Never "Are you sure?".
- **Dismissal:** ESC key, backdrop click (configurable per dialog — destructive `AlertDialog` does *not* dismiss on backdrop), explicit close button.
- **Stacking:** max one modal at a time. If a nested confirmation is needed, the outer modal closes and the confirmation opens, or the confirmation is inline in the outer modal.
- **Anti-patterns referenced:** #1 (`Dialog` used as `Sheet`).

### Navigation

- **shadcn-ui upstream:** composed from `NavigationMenu`, `Sheet`, `Avatar`, `DropdownMenu`.
- **Primary:** vertical sidebar (`240px` expanded, `64px` icon-only collapsed); top bar with user menu and global actions.
- **Sidebar items:** icon (`size.icon.default`) + label (`text-sm`, `font-medium`); active item shows `color.accent.primary` background + `color.accent.foreground` text.
- **Breadcrumbs:** above page title for nested resources. Example: `Vehicles › K-1-1234 › Trips › 2026-05-20`.
- **Page header:** title (`text-2xl`, `font-semibold`), optional description (`text-sm`, `color.text.muted`), action row right-aligned.
- **Tabs:** shadcn-ui `Tabs` for in-page section switching; max ~5 tabs per surface (more than five becomes hard to scan).

### Iconography

- **Icon library:** Lucide React (`lucide-react`) — shadcn-ui's default. Permissively licensed (ISC); ~1,500 icons; tree-shakeable.
- **Canonical sizes:** 16px (`h-4 w-4`), 20px (`h-5 w-5`), 24px (`h-6 w-6`). Per Sizing tokens. No other sizes inline; the upper bound is 32px for header-level decoration, used sparingly.
- **Color:** icons inherit `color.text.primary` by default; status icons take the matching status color (e.g., warning triangles take `color.status.warning`); icons on accent backgrounds take `color.accent.foreground`.
- **Stroke width:** Lucide's default `1.5` for 16/20px; `1.75` for 24px (slightly heavier when larger so the visual weight stays balanced).
- **Specific icon names** live in component code, not centrally cataloged. The convention is to import named imports at the top of each component file (`import { ChevronUp, Trash2 } from "lucide-react"`).
- **Anti-patterns referenced:** #8 (oversized icons — 24px is the upper bound for inline use).

### Data display

- **Money:** `<Money paisa={integer} />` component (contract only today — see [Component status](#component-status-built-vs-contract); `formatNpr` in `lib/money.ts` is the shipped display path until `<Money>` is built). Output: `Rs. ` + Intl-grouped integer rupees (en-IN locale, Nepali lakh grouping) + `.` + 2-digit paisa. Examples: `12550025` paisa → `"Rs. 1,25,500.25"`; `100` paisa → `"Rs. 1.00"`; `0` paisa → `"Rs. 0.00"`. Right-aligned in tables; `tabular-nums` applied. Negative amounts use parentheses: `-125000` paisa → `"(Rs. 1,250.00)"`. See [NPR / paisa display](#npr--paisa-display) for the full specification.
- **Dates:** `<NepaliDate iso="2026-05-20" format="bs|en|both" />`. Default `format="both"` shows BS prominent (`2083 Jestha 6`) with Gregorian in muted parenthetical (`(2026-05-20)`); `format="bs"` shows BS only; `format="en"` shows Gregorian only. The calendar widget pattern is documented in [BS calendar](#bs-bikram-sambat-calendar).
- **Duration:** human-readable, abbreviated. `"2h 15m"` for hours/minutes; `"3d 4h"` for multi-day; `"45m"` for short durations. No "minutes" or "hours" spelled out; the unit suffix is the unit.
- **Distance:** Latin numerals, kilometers, one decimal place: `"12.4 km"`. No imperial units; FleetCo operates in Nepal and never displays miles.
- **Status badges:** `<Badge variant="...">` — emerald (in-progress / scheduled / success), zinc (completed / inactive), red (failed / cancelled / error), amber (expiring-soon / warning). Status badges always pair the hue with a text label; never hue-only. The hue is recognition; the label is meaning.

## Surfaces

Page-level compositions that arrange the Components above into a specific screen. A surface introduces **no new tokens or components — only an arrangement**, so it is specified here in prose and built directly from this section. ADR-0008 permits a locked `docs/design/slices/<name>.html` mockup when a surface "benefits from a mockup," and ADR-0007 names "a dashboard" as such a candidate; the established FleetCo practice, however — every Phase-1 aggregate **and the per-vehicle cost report** — has built surfaces directly from this file without a slice mockup, and the surfaces below reuse only already-designed components. They are therefore specified here, not as slice mockups; this section records that deliberate choice.

### Home dashboard

- **Purpose.** The authenticated landing surface (`/`). It replaces the placeholder navigation-only home with a daily-ops overview — what the operator needs to see and act on first — composed entirely from existing operational data (no dashboard-specific backend). It is the operator's instrument panel, not a marketing home.
- **Shell & header.** A server component behind the auth gate (unauthenticated → `/login`). The app's standard container: `<main class="bg-surface-canvas min-h-svh">` with `mx-auto max-w-6xl px-8 py-8`. The page renders **inside** the [Navigation](#navigation) shell (`app/(app)/layout.tsx`), which provides the top bar — a user menu carrying "Signed in as `<email>`" and sign-out — and the sidebar (the primary navigation). The page's own header is therefore just the page title (`text-2xl font-semibold`) plus a `text-sm` `color.text.muted` subline with today's date via `<NepaliDate format="both">`; the sign-out and the signed-in-as line moved to the top-bar user menu so there is no duplicate.
- **Zone A — overview cards.** A responsive grid (`grid gap-4 sm:grid-cols-2 lg:grid-cols-3`). Each card uses the section idiom (`border-border-subtle bg-surface-raised rounded border p-4 shadow-sm`; `text-lg`, `font-semibold` title; dense `text-sm` / `text-xs` body; `tabular-nums` on numbers; status hues only via `<Badge>`). Six cards, in priority order:
  1. **Fleet compliance** (headline; spans the grid full-width, `lg:col-span-3`). The day's most actionable signal: how many vehicles carry a lapsing or lapsed compliance document. Shows the count of vehicles needing attention, then two chips — `<Badge variant="error">N expired</Badge>` and `<Badge variant="warning">N expiring soon</Badge>` — and a muted "across M vehicles", with "Review vehicles →" linking to `/vehicles`. A vehicle's state is the **worst** of its three documents (bluebook / insurance / route permit), classified by the shipped `complianceBadgeState` helper (the 30-day window). All-clear is a stated fact, not a celebration: `<Badge variant="success">All documents current</Badge>`. Empty fleet → "No vehicles registered." linking to `/vehicles/new`.
  2. **Active trips.** Trips in progress now: a count + a short list (≤ 5) of `registration · driver`, each `<Badge variant="success">In progress</Badge>`; "All trips →". Empty → "No trips in progress."
  3. **This-month cost.** The fleet's fuel + expense spend for the current calendar month: the total via the money display (`<Money>` / `formatNpr`), a muted fuel/other split, the month range, and "Cost report →". Empty → `Rs. 0.00` and "No fuel or expense logs this month."
  4. **Recent fuel** & **5. Recent expenses.** The last five entries each — `registration · <NepaliDate> · amount` — linking to the respective log surface. Empty → "No fuel logs." / "No expense logs."
  6. **Fleet counts.** Three tabular stats — vehicles, drivers, active trips.
- **Zone B — Quick links.** A compact convenience strip below the cards. The [Navigation](#navigation) sidebar (now built) is the app's primary navigation; this strip is sourced from the **same** shared nav model (`lib/nav.ts`) that feeds the sidebar, so the two cannot drift — one source of truth, rendered here in the sidebar's group order. It augments the sidebar; it no longer carries primary navigation on its own.
- **Data & states.** The cards compose existing read endpoints fetched in parallel — no dashboard-specific endpoint. Per [Voice](#voice-and-tone), every empty/zero state states the fact without exclamation or apology ("No trips in progress.", "All documents current"). The surface ships a loading skeleton (the root `loading.tsx`, mirroring the list pages' `animate-pulse` blocks) and an error boundary whose copy is the Voice network-error line — "Cannot reach the server. Retry." The compliance count is bounded by the vehicles-list page size (200); a larger fleet is a future dedicated-count concern, not a dashboard one.
- **Anti-patterns referenced:** #3 (cards are summaries with a single contextual link, not navigable tiles with competing inner primary buttons), #7 (status is a `<Badge>`, never row-level color coding), #4 (no gradients).

### Per-vehicle fuel-efficiency report

- **Purpose.** A read-only report at `/reports/per-vehicle-efficiency` that surfaces, per vehicle over a chosen window, how far it travelled, how much fuel it burned, and the two efficiency ratios that matter — **km/L** (distance per litre) and **NPR/km** (fuel cost per kilometre) — each flagged against the same vehicle's prior-period baseline so a sudden drop reads at a glance. It completes the "fuel efficiency" deliverable named for Reports v1 in `docs/product/roadmap.md` (§"Phase 1 — The Spine") that iter-23 left unshipped: iter-23 shipped the cost half only (the per-vehicle cost report's `getPerVehicleCost`), so this surface is the efficiency half, landing as Reports v2 in the Phase-2 window — deferred Phase-1 daily-use polish, not new Phase-2 scope (the same category as the [Home dashboard](#home-dashboard) and the BS-date work). It is the operator's instrument for "which truck is drinking fuel," not a forensic per-fill audit (see **Coverage** below).
- **Route & shape.** Mirrors the per-vehicle cost report exactly: a date-range picker (two date inputs in a client island) defaulting to the current calendar month (UTC), plus an optional single-vehicle filter populated from a server-side `/api/v1/vehicles` pre-fetch. Filter state lives in URL `searchParams`; the page is a server component behind the auth gate (unauthenticated → `/login`). Same shell as every report / list surface: `<main class="bg-surface-canvas min-h-svh">`, `mx-auto max-w-6xl px-8 py-8`, breadcrumb `FleetCo › Per-vehicle fuel-efficiency report`, `text-2xl font-semibold` title.
- **Table.** Per [Tables](#tables) (`default` variant), one row per vehicle with activity in the window — zero-activity vehicles do not appear (no zero-fill), matching the cost report. Numeric columns are right-aligned `tabular-nums` per [Tables](#tables). Columns:
  1. **Vehicle** — registration number, `font-mono`, linking to `/vehicles/<id>`.
  2. **Distance** — kilometres travelled in the window, via `formatKm` (one decimal).
  3. **Litres** — fuel consumed in the window, via `formatLiters`.
  4. **km/L** — the efficiency ratio to **two decimal places**; an **em-dash (—)** when the window holds too little data to compute it trustworthily (see **Status** → `insufficient-data`).
  5. **NPR/km** — fuel cost per kilometre via `formatNpr` over the paisa-per-km figure; em-dash when distance is zero (no divide-by-zero).
  6. **Fuel cost** — total fuel paisa in the window, via `formatNpr`.
  7. **Status** — the efficiency flag rendered through the shipped [`<Badge>`](#data-display), comparing this window's km/L against the vehicle's prior equal-length window:
     - `degraded` → `<Badge variant="error">Efficiency down</Badge>` — km/L fell beyond the service's default deviation threshold (≈15%). The label is **"investigate," not "proven theft"** (see **Coverage**).
     - `improved` → `<Badge variant="success">Improved</Badge>`.
     - `normal` → **no badge.** Within the threshold; the absence of a badge is itself the signal (quiet by default).
     - `insufficient-data` → `<Badge variant="neutral">Not enough data</Badge>` — too little distance or fuel in the window (a small-window floor) to compute a ratio worth trusting; the km/L cell em-dashes.

     The exact deviation threshold and the insufficient-data floor are the report service's constants, not design law. The Status column is a **status indicator, not an action** — anti-pattern #2 (badges are status, never actions) and #7 (the hue lives in one badge cell, never the whole row).
- **Subtitle & BS calendar.** The window subtitle renders the resolved `from` / `to` through `<NepaliDate>` / `formatNepaliDate` (the `bs` variant, keeping the sentence compact), e.g. "5 vehicles with activity from `<BS>` to `<BS>`." The date **inputs** use the shipped `<NepaliDatePicker>` (ADR-0032) — exactly as on the cost report, which adopted it in B3 — so the operator picks the window in the Bikram Sambat calendar while the value stays the ISO/AD `YYYY-MM-DD` the API expects. (This supersedes ADR-0031 commitment 6's interim "date inputs stay native AD"; ADR-0032 was the now-shipped BS date-picker slice that commitment named as the follow-up.)
- **Coverage & honest framing.** This is a **fleet / period-level km/L trend + exception flag, not a forensic per-fill meter** — say so in the UI, do not dress it up. Distance is the system-of-record figure — the sum of completed-trip odometer deltas (ADR-0003: the Trip aggregate owns distance, and the Trip → Vehicle odometer auto-update already maintains it) — **not** the fuel log's `odometerReadingKm`, which is nullable and non-monotonic by recorded decision (`docs/tech-debt.md`, Paid-off; see the **Fuel log** / **Odometer** glossary entries) and would inject noise. Even on the trip basis, ~15–20% dashboard drift and partial fills mean a single row is a signal, not a measurement. The surface therefore carries a **light coverage note** — a muted `text-xs` line beneath the table, [Voice](#voice-and-tone) register, no apology — that frames outliers as **"investigate"** rather than proven, and notes that the report self-sharpens once the driver app makes odometer-at-fill routine.
- **Empty state.** Per [Voice](#voice-and-tone), when the window holds no fuel or trip activity: **"No fuel or trip activity in the selected window."** — stated as fact, no exclamation, no apology.
- **No new tokens or components.** The surface reuses [`<Badge>`](#data-display), the shadcn `Table*` primitives, `<NepaliDate>` / `formatNepaliDate`, and the `formatNpr` / `formatLiters` / `formatKm` formatters as-is. It introduces **no new design token and no new component**, so `apps/web/src/app/globals.css`'s `@theme` block is untouched and the [design-token-drift test](#how-this-file-relates-to-code) stays green.
- **Anti-patterns referenced:** #2 (Status is a `<Badge>`, never an action), #7 (status hue lives in one badge cell, never row-level colour coding), #14 (money stays integer paisa — `formatNpr` formats only at the edge; the km/L and NPR/km ratios are display-only, computed at render and never stored).

### Preventive maintenance (service schedules & history)

- **Purpose.** The operator-facing web surface for the preventive-maintenance aggregate (ADR-0037): the pages that let the operator define recurring **service schedules** for a vehicle, record **completed services** (with their cost link into the existing `ExpenseLog` ledger), and see at a glance **what is due**. It is the management + at-a-glance front-end for the B3 CRUD API + the B4 due/overdue classifier (`serviceScheduleState`); it is **not** a reminder channel — active delivery (email/SMS) is ADR-0038 / Phase 3, exactly as the compliance badge is the passive producer for its own future delivery. Like the [Home dashboard](#home-dashboard) and the BS-date work, this is deferred Phase-3 (Program B) scope pulled forward under ADR-0025's ahead-of-gate pattern (ADR-0036 + ADR-0037, both accepted 2026-06-18); it adds **no new token and no new component**.
- **Routes & shape.** Two aggregates, each a standard CRUD route tree behind the auth gate (unauthenticated → `/login`), mirroring `apps/web/src/app/geofences/` and the Phase-1 aggregates exactly — the app container (`<main class="bg-surface-canvas min-h-svh">`, `mx-auto max-w-…`), breadcrumb-above-title page header, the shared `Table*` primitives with sortable headers + "Showing M–N of T" pagination, native `<select>` pickers, and the AlertDialog delete island with named action/cancel labels.
  - **`/service-schedules`** (list / `new` / `[id]` / `[id]/edit`) — the recurring intervals.
  - **`/service-schedules/due`** — the fleet-wide due-list (below).
  - **`/service-records`** (list / `new` / `[id]` / `[id]/edit`) — the completed-service history.
- **Service schedules — list.** One row per schedule across the fleet. The list response carries only `vehicleId` (it does not nest the Vehicle), so the owning **vehicle registration** is resolved by a single `/api/v1/vehicles?take=200` fetch mapped by id — the same enrichment pattern the Geofences list uses for customer names (a vehicle outside the first 200, or a failed enrichment, falls back to the raw id). Columns: **Name** (links to the schedule detail), **Vehicle** (`font-mono` registration, links to `/vehicles/<id>`), **Interval** (e.g. "Every 5,000 km" / "Every 250.0 h" / "Every 90 days", via `formatKm` / `formatHours`), **Status** (the `ACTIVE` / `INACTIVE` lifecycle), **Created** (`<NepaliDate format="bs">`). Filter by vehicle and status; sort by name / createdAt (the API whitelist). The list deliberately carries the **lifecycle** status, not the due/overdue badge — "what needs attention" is the dedicated due-list's job (the same separation the vehicles list draws between the management list and the Home compliance card).
- **Service schedules — detail / new / edit.** The **detail** page paints the B4 `serviceScheduleState` badge (`<Badge variant="error">Service overdue</Badge>` / `<Badge variant="warning">Service due soon</Badge>` / a quiet "On track" / an em-dash for "none"), classified against the schedule's owning vehicle's current meter reading (fetched alongside), shows the interval / derived "next due" (`nextDueForSchedule`) / last-service anchor, and lists **this schedule's service history** (the `/service-records?serviceScheduleId=…` rows). The **new / edit** forms collect vehicle (a server-fetched picker; immutable on edit), name, optional description, `intervalType`, the `intervalValue` whose **label, unit, and conversion follow the type** — kilometres for `DISTANCE_KM`, **decimal hours → integer tenths via `hoursToTenths`** for `ENGINE_HOURS`, days for `CALENDAR_DAYS` — `status`, and the optional last-service anchor (date via `<NepaliDatePicker>` + the dimension's meter reading; left blank, the API seeds it from the vehicle's current reading per ADR-0037 c4). Field-level error mapping routes the meter-consistency 400 (an `ENGINE_HOURS` schedule on an `ODOMETER_KM` vehicle) to the `intervalType` input and the duplicate-name 409 (`field: "name"`) to the name input.
- **Service records — list / detail / new / edit.** The history of completed services. **List** columns: **Performed** (`<NepaliDate>`, the default sort, desc), **Vehicle** (resolved registration, links to `/vehicles/<id>`), **Schedule** (the resolved schedule name, or "Ad-hoc" when `serviceScheduleId` is null), **Odometer** / **Engine hours** (`formatKm` / `formatHours`, em-dash when null). Filter by vehicle / schedule. The **detail** page renders the readings, notes, the linked **schedule** (deep-link), and the linked **cost** — the linked `ExpenseLog`'s `amountPaisa` via `formatNpr`, read **through** the ExpenseLog (a deep-link to `/expense-logs/<id>`), never a second money column (ADR-0037 c6). The **record-a-service** form collects vehicle (required picker), the optional **schedule** (filtered client-side to the chosen vehicle's schedules; an unset schedule is an ad-hoc service), `performedAt` (`<NepaliDatePicker>`), the optional meter reading(s), the optional **cost link** (a picker over the chosen vehicle's `MAINTENANCE` / `REPAIR` expense logs, each option labelled with its `formatNpr` amount + date), and notes. Field-level error mapping routes the cost-link 400 (wrong category / different vehicle) to the `expenseLogId` picker, the schedule-vehicle-mismatch 400 to the `serviceScheduleId` picker, and the stale-FK 400s to their inputs.
- **Due-list (`/service-schedules/due`).** The at-a-glance "what is due now" surface. It fetches all `ACTIVE` schedules + the fleet's vehicles, classifies each schedule with `serviceScheduleState` against its vehicle's current reading, keeps only the `due-soon` / `overdue` ones, and **groups them by vehicle** — each vehicle section headed by its registration (deep-link) and a single worst-of `<Badge>` (`worstServiceState`, the rotation of `worstComplianceState`), with a small table of that vehicle's due/overdue schedules (Name / Interval / Next due / Status badge) beneath. Empty state per [Voice](#voice-and-tone): "No services due. Every active schedule is on track." Bounded by the same `take=200` ceiling the dashboard documents.
- **Home dashboard — "Services due" card.** A seventh [Home dashboard](#home-dashboard) Zone-A card (added after Fleet compliance, the same family of attention signals): the count of `ACTIVE` schedules across the fleet currently in `due-soon` / `overdue`, with `<Badge variant="error">N overdue</Badge>` / `<Badge variant="warning">N due soon</Badge>` chips shown only when non-zero, an all-clear `<Badge variant="success">All services on track</Badge>`, and a single contextual "Services due →" link to `/service-schedules/due` (anti-pattern #3). The roll-up is computed server-side in `lib/dashboard.ts` (`rollUpServiceSchedules`, the sibling of `rollUpCompliance`) over the already-fetched vehicle rows + one added `service-schedules?status=ACTIVE&take=200` read; it inherits the **same >200-vehicle / >200-schedule undercount caveat** the compliance roll-up documents.
- **Navigation.** "Service schedules" and "Service history" join the Zone-B quick-links strip (the next entries after "Geofences"), preserving the augments-never-replaces-navigation rule until the sidebar lands.
- **No new tokens or components.** The surfaces reuse the shipped `<Badge>` / `<NepaliDate>` / `<NepaliDatePicker>`, the shadcn `Table*` / `Form*` / `AlertDialog` primitives, and the `formatNpr` / `formatKm` / `formatHours` / `hoursToTenths` formatters as-is, so `apps/web/src/app/globals.css`'s `@theme` block is untouched and the [design-token-drift test](#how-this-file-relates-to-code) stays green.
- **Anti-patterns referenced:** #2 (the due/overdue state is a `<Badge>`, never an action), #3 (the dashboard card is a summary with one contextual link), #7 (status hue lives in one badge cell, never row-level colour), #14 (the maintenance cost stays integer paisa in the single `ExpenseLog` column — `formatNpr` formats at the edge, read through the link, never duplicated).

### Customer VAT invoicing

- **Purpose.** The operator-facing web surface for FleetCo's first **revenue-side** aggregate (ADR-0039): the pages that draft an invoice from the Customer → Job → Trip chain, preview the Nepal VAT/TDS breakdown, **issue** it (assigning the gapless Bikram-Sambat-fiscal-year number, freezing the tax snapshot, and storing the PDF), and download the issued PDF. It is the management front-end for the D1–D5 API; it consumes that API **exactly as it stands** (UI only — no new endpoint, schema, capability, or design token). Like the [Preventive maintenance](#preventive-maintenance-service-schedules--history) surface, this is Phase-4 ("Money") scope pulled forward under ADR-0025's ahead-of-gate pattern (ADR-0039 accepted 2026-06-18, build-now path); the Nepal tax rates + FleetCo's own supplier PAN remain **operator/accountant-verify before real billing** (ADR-0039 c9).
- **Routes & shape.** A standard CRUD route tree behind the auth gate (unauthenticated → `/login`), mirroring `apps/web/src/app/jobs/` exactly — the app container (`<main class="bg-surface-canvas min-h-svh">`, `mx-auto max-w-…`), breadcrumb-above-title page header, the shared `Table*` primitives with sortable headers + "Showing M–N of T" pagination, native `<select>` pickers, and the `AlertDialog` confirmation islands. Routes: **`/invoices`** (list), **`/invoices/[id]`** (detail), **`/invoices/new`** (create the DRAFT header), **`/invoices/[id]/edit`** (the DRAFT line workbench), and **`/invoices/[id]/pdf`** (a same-origin Next route handler that forwards the session cookie and streams the authenticated PDF from `GET /api/v1/invoices/:id/pdf`, so the download carries auth in both dev cross-origin and prod same-origin).
- **List.** One row per invoice. Columns: **Number** (`font-mono`, sortable; an em-dash "— draft" before issue), **Customer**, **Status** + **Document type** (the shipped [`<Badge>`](#data-display) — see the variant mapping below), **Gross** + **Net receivable** (`formatNpr`, right-aligned `tabular-nums`, em-dash until issue), **Issue date** (`<NepaliDate format="bs">`, em-dash until issue). Filters: status / document type / customer (a native-`<select>` toolbar island; only the customer **id** rides the URL — PII discipline, anti-pattern #15). Sort: the two API-whitelisted columns, `number` (a clickable header) and `createdAt` (the default, no rendered column). The `{ items, total, skip, take, sortBy, sortDir }` wire shape + the shared paginator/sortable-header idiom.
- **Status & document-type badges (no new token).** Bound to existing `color.status.*` tokens only: **status** — `DRAFT` → `neutral` (a working state), `ISSUED` → `success` (committed / valid), `CANCELLED` → `error` (voided); **document type** — `INVOICE` → `neutral` (the common case), `CREDIT_NOTE` → `info` (the rare corrective document, "blue = informational, rare"). The hue is recognition, the label is meaning (anti-pattern #2 / #7).
- **Detail.** The full invoice: nested **customer** (deep-link `/customers/<id>`, with the buyer PAN), the optional **job** (deep-link `/jobs/<id>`), the **lines** table, and the **VAT/TDS breakdown** — subtotal → discount → taxable → VAT (% of taxable) → **gross billed** (what the customer owes) → the **TDS-withheld memo** → **net receivable** (the expected cash), all `formatNpr`. For an **ISSUED** invoice the breakdown renders the **frozen snapshot columns** (never recomputed — the anti-tamper freeze, ADR-0039 c3/c5); for a **DRAFT** it renders a **provisional preview** computed by the pure `computeInvoiceTaxPreview` (a faithful mirror of the API's `computeInvoiceTax`, pinned by a unit test, integer paisa half-up). Dates render `<NepaliDate>`.
- **The DRAFT-editable / ISSUED-read-only split (enforced visually, ADR-0039 c5).** A **DRAFT** shows Edit / **Issue** / **Cancel draft** + a "Download draft preview" (the watermarked, provisional-tax PDF); an **ISSUED** invoice is read-only + "Download PDF" (the frozen artifact) + **Create credit note** (the only correction path); a **CANCELLED** invoice is read-only + a preview download. Issue / Cancel / Create-credit-note are `AlertDialog` islands with named, specific confirmations (§Voice "Confirmations are specific"); issuing surfaces the API's actionable 422s — **supplier PAN not configured** / **R2 not configured** / no service type / no lines — verbatim (they name the env var the operator must set; the supplier PAN is operator-supplied, never fabricated — ADR-0039 c9).
- **Create + edit workbench.** `new` collects the DRAFT header — customer (required) → optional job (filtered client-side to the chosen customer) → optional service type (selects the TDS rate; required to issue) → optional discount — then redirects to `edit`. `edit` is the **DRAFT-only** workbench (a non-DRAFT id redirects to the read-only detail): a header form (service type / discount / job; the customer is **fixed**), **manual** line add / inline-edit / remove (the amount is derived server-side), **build-from-job** (pick a job + a set of trips with per-trip amounts — **operator-selected, not a Job→Trip traversal**, because the schema has no `Trip.jobId`; see `docs/tech-debt.md`), and the live provisional tax preview that re-renders after each mutation. Money is entered as a rupees decimal at the form edge and converted to integer paisa (`rupeesToPaisa`); dates display BS via `<NepaliDate>` — the workbench has no user-entered date (the issue date is server-assigned at issue time).
- **Voice & empty states.** Per [Voice](#voice-and-tone): "No invoices on file." / "No invoices match the current filters."; "Draft the first invoice"; "No lines yet." — stated as fact, no exclamation, no apology.
- **No new tokens or components.** Reuses the shipped `<Badge>` / `<NepaliDate>`, the shadcn `Table*` / `Form*` / `AlertDialog` primitives, and `formatNpr` / `rupeesToPaisa` / `paisaToRupeesInput` as-is, so `globals.css`'s `@theme` block is untouched and the [design-token-drift test](#how-this-file-relates-to-code) stays green.
- **Anti-patterns referenced:** #2 (status / document type are `<Badge>`, never actions), #7 (status hue lives in one badge cell, never row-level colour), #11 (`formatNpr` is the NPR money formatter shared with every money surface; never the `₹` glyph), #14 (money is integer paisa end-to-end — `rupeesToPaisa` at the form edge in, `formatNpr` at the render edge out; the VAT/TDS math is integer paisa half-up, never a float), #15 (only the customer **id** rides the filter URL; names/PANs resolve server-side).

## Voice and tone

The voice is **quiet, professional, technical**. The user is the operator; the UI is the instrument. No marketing affectations. Eight principles govern every label, button, error, and empty state:

1. **Precise nouns.** "Trip" not "Item." "Vehicle" not "Record." "Bluebook" not "Document." Generic words make a generic-feeling tool.
2. **No exclamation marks.** Ever. Exclamation marks read as marketing or as alarm; neither belongs.
3. **State the fact.** Empty states announce; they do not narrate. "No trips." not "Looks like there are no trips yet."
4. **Errors name the cause.** "Bluebook number K-1-1234 is already registered." not "Something went wrong." The user needs the cause; the cause is what lets them act.
5. **Buttons are verbs.** "Create trip" not "OK" or "Submit." A button label tells the user what will happen when they click; verbs do that.
6. **Confirmations are specific.** "Delete trip 2026-05-20 / K-1-1234?" not "Are you sure?" Specificity is the safety mechanism.
7. **Loading is silent or specific.** A spinner alone, or `"Saving trip…"`. Never `"Loading…"` — it is a non-statement.
8. **Don't apologize for non-failures.** "No results." not "Sorry, no results found." The empty state is information, not regret.

| Surface | Bad | Good |
| --- | --- | --- |
| Empty table | Looks like there are no trips yet! Try creating one. | No trips. |
| Save button | Submit | Save trip |
| Validation error | Something went wrong. Please try again. | Bluebook number K-1-1234 is already registered. |
| Destructive confirmation | Are you sure you want to delete this? | Delete trip 2026-05-20 / K-1-1234? |
| Loading state | Loading… | (spinner) Saving trip… |
| Network error | Oops! | Cannot reach the server. Retry. |
| Tooltip | Click to edit | Edit driver |
| Section heading | Awesome stats | Fleet summary |

## Anti-patterns

Fifteen patterns to avoid. The first ten are shadcn-ui / general UI anti-patterns relevant to FleetCo's voice. The last five are FleetCo / Nepal-specific.

1. **`<Dialog>` for side-slide content.** Use `<Sheet>` (drawer) when content slides in from the edge. Dialogs are for centered tasks; drawers are for peripheral panels.
2. **Badges as buttons.** Badges are status, not actions. Use a low-emphasis button (`ghost`, `link`) for inline actions.
3. **Primary buttons inside navigable cards.** The card itself is the click target; an inner primary button creates two competing actions. Move the action to the page-level toolbar or a contextual menu.
4. **Gradient backgrounds.** Reads as marketing. Inappropriate for an instrument-like ERP surface.
5. **Decorative motion.** Animations exist only to communicate state change; never to decorate or delight.
6. **Full-page reloads for state changes that should be local.** Use optimistic UI or in-place state updates.
7. **Color-coding tables by row.** Drowns the actual data signal in chromatic noise. Use a single status column or badge instead.
8. **Oversized icons.** 24 px is the upper bound for inline icons. Headers may use 32 px sparingly. Never above 32 px inside the admin web.
9. **Toast notifications for actions the user just initiated.** The action's own UI should confirm in-place. Toasts are for background events the user did not initiate.
10. **Validation on every keystroke.** Validate on blur for text fields; on change for select / checkbox; on submit for the form.
11. **INR / NPR symbol confusion.** Always `Rs.` for FleetCo. `₹` is INR and never appears in this product. Imported INR data (if ever) must be explicitly converted and re-labeled.
12. **Fabricated BS conversions.** Use the chosen library (to be picked by a Phase 1 ADR) or a verified conversion source. Never approximate. Never store BS as a string; convert to ISO at the boundary.
13. **English-only error messages for Nepali-named fields.** Compliance fields with Devanagari names (Bishesh Anumati, Bluebook, Route Permit) need bilingual error messages so the user can recognize the field in either script.
14. **Monetary floats.** Paisa is integer-only end-to-end. UI never accepts decimal paisa. Internal math is in integer paisa; display formatting converts to rupees.
15. **PII in default logs.** Driver names, license numbers, customer phone numbers are Tier 2 per ADR-0013; never logged at record level. UI must not echo PII in URL query strings — use POST bodies or path parameters resolved server-side.

## Nepal-specific considerations

### Devanagari rendering

- **Font:** Noto Sans Devanagari (Google Fonts; SIL OFL license). Loaded via Next.js's `next/font/google` to ship the font with the app rather than fetching at runtime.
- **Stack:** a single `font-sans` stack contains both Latin and Devanagari families. The browser's per-character fallback handles mixed-script text without explicit `lang` switching.
- **Pairing:** Inter (Latin) and Noto Sans Devanagari (Devanagari) are visually matched on x-height and weight palette; no manual size adjustment is needed when scripts mix in a single line.
- **Tabular numerals:** `tabular-nums` applies to Latin digits in numeric columns. Devanagari numerals (०१२३४५६७८९) are not used in v1; all numbers — money, dates, distances, durations — render in Latin script.

### BS (Bikram Sambat) calendar

- **Pattern:** a `<NepaliDate>` React component renders both BS and Gregorian values from a single ISO date stored in the database.
- **Default rendering:** `"2083 Jestha 6 (2026-05-20)"` — BS prominent in Latin transliteration, Gregorian parenthetical in `color.text.muted`. (The BS value is the output of the verified conversion library, not a hand-written pair — anti-pattern #12; `formatNepaliDate` and its test pin this: BS 2083 Baishakh 1 ≈ 2026-04-14, so Jestha 6 = 2026-05-20.)
- **Calendar widget pattern:** trigger button shows the current BS + Gregorian date; popup shows a BS month grid with Gregorian dates underlaid in muted text in the corner of each cell; user can switch BS months via arrow controls; today is highlighted with a `color.accent.primary` outline.
- **Storage:** dates are always stored as ISO/UTC in Postgres per CLAUDE.md. BS is a render-time conversion only. Never store BS as a string; never roundtrip BS through the API as the canonical form.
- **Library choice:** **deferred.** A Phase 1 ADR will pick the conversion library when the first BS-calendar requirement lands (likely the Trip detail surface). Candidates worth evaluating then (non-binding): `nepali-date-converter`, `nepali-datepicker-reactjs`, or an in-tree implementation derived from a verified reference table. Until that ADR, the component contract is documented above; the implementation is empty.
- **Anti-pattern referenced:** #12 (fabricated BS conversions).

### NPR / paisa display

- **Storage:** integer paisa per CLAUDE.md. 1 NPR = 100 paisa. The full stack — database column, API DTO, internal computation, UI prop — uses integer paisa. No `BigDecimal`, no floats, no string-based decimals.
- **Component:** `<Money paisa={integer} />`.
- **Format:** `Rs.` prefix, a space, then Nepali lakh-grouped integer rupees, then `.`, then 2-digit paisa.
- **Grouping:** Nepali lakh style — `Rs. 1,25,500.25`, not `Rs. 125,500.25`. Implementation: `Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`. The `en-IN` locale gives the lakh-style grouping; the `minimumFractionDigits` / `maximumFractionDigits` pinning ensures paisa always show even when zero.
- **Examples:**
  - `12550025` paisa → `"Rs. 1,25,500.25"`
  - `100` paisa → `"Rs. 1.00"`
  - `0` paisa → `"Rs. 0.00"`
  - `-125000` paisa → `"(Rs. 1,250.00)"`
- **Alignment:** right-aligned in tables; left-aligned in inline body text; `tabular-nums` applied so digits line up across rows.
- **Anti-patterns referenced:** #11 (INR / NPR symbol confusion), #14 (monetary floats).

## How this file relates to code

**Tokens are canonical here.** The Markdown tables in the Foundations section are the source of truth for FleetCo's design tokens. The `@theme` block in `apps/web/src/app/globals.css` (created in Ticket 8 per ADR-0019) declares those tokens as Tailwind 4 CSS variables. ADR-0007 is the discipline; this section is the mechanism.

**Manual sync.** When a token table in DESIGN.md changes, the same PR updates the `@theme` block in `apps/web/src/app/globals.css` by hand. There is no code generation step in v1 — a build-step generator can come later if drift becomes a real problem, but the manual sync is simpler to reason about and easier to review in a diff. The rule is: the two files always change together in every PR that touches tokens.

**CI drift test.** A test at `apps/web/test/design-token-drift.test.ts` (created in Ticket 8 per ADR-0019) reads `docs/design/DESIGN.md`, extracts the color-token Markdown table into a token map, parses the `@theme` block in `apps/web/src/app/globals.css` into a comparable token map, and asserts equality of hex values. The test fails the PR on any drift between the two. The CI job that runs the test is wired in Ticket 11 (CI pipeline). The contract names the *inputs* (DESIGN.md's Color tokens table, `apps/web/src/app/globals.css`'s `@theme` block), the *assertion* (every semantic token in DESIGN.md has a CSS variable in `@theme` with the same hex), and the *failure mode* (CI fail). Phase 0 ships color-token coverage; the test grows to cover typography / spacing / sizing / borders / shadows as DESIGN.md introduces customized non-color tokens that diverge from Tailwind 4's defaults — each such PR extends both the `@theme` block and the test in the same diff.

**Token consumption, not just definition.** The drift test above proves the token *table* and the `@theme` block agree on hex values; it does **not**, by itself, prove components *consume* those tokens. The distinction is load-bearing in Tailwind 4: only variables declared in the `@theme` block become utility classes (`--color-accent-primary` → `bg-accent-primary`, `--color-border-strong` → `border-border-strong`, `--color-border-focus` → `ring-border-focus`, and so on). The sibling `:root` block that aliases shadcn-ui's standard names (`--primary`, `--input`, `--ring`, `--border`, …) holds plain CSS variables, **not** `@theme` tokens — those names generate **no** utilities here, so `bg-primary`, `border-input`, and `ring-ring` are **dead classes** that compile to nothing. A component copied from shadcn-ui upstream must therefore be re-pointed to FleetCo's `@theme` semantic utilities, exactly as `apps/web/src/components/ui/popover.tsx` does and documents in its provenance comment (`bg-popover` → `bg-surface-elevated`, etc.). **The rule: a FleetCo component consumes the `@theme` semantic utilities; it never relies on a `:root` shadcn alias to produce a style.**

**Slice mockups.** When a Phase 1 slice has a locked HTML mockup, it lives at `docs/design/slices/<slice-name>.html` per ADR-0008. DESIGN.md is the token + component language; slice mockups apply that language to specific surfaces. After implementation merges, the mockup moves to `docs/design/slices/_archive/`. External design tools (Open Design, Figma, hand-coded HTML) are iteration surfaces only; conclusions must commit to `docs/design/` to count as the project's perceptual memory.
