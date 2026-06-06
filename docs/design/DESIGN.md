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

**Provenance of in-tree components (as of 2026-05-21, Ticket 10).** The first four shadcn-ui components copied into `apps/web/src/components/ui/` were `button.tsx`, `input.tsx`, `label.tsx`, and `form.tsx`, pulled via `pnpm dlx shadcn@latest add ...` with the CLI at version `4.7.0` and the unified `radix-ui` peer at `1.4.3`. Subsequent component additions append a one-line note here naming the CLI version at the time of addition (per ADR-0016's "maintaining a short note... referencing the shadcn-ui version the component was copied from").

- **2026-05-21 (Vehicles iter 1):** `table.tsx` added. Shape matches shadcn-ui's `new-york` Table primitive (the style configured in `apps/web/components.json`) with FleetCo density tuning applied inline: default row vertical padding 12px (`p-3`), headers `font-medium` and not uppercase, row separators in `color.border.subtle`. Hand-written rather than CLI-pulled to keep iter-1's added surface tight; the next CLI invocation will reconcile if upstream has changed meaningfully.
- **2026-05-25 (Vehicles iter 3):** `alert-dialog.tsx` added. Source copied verbatim from `https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/alert-dialog.tsx` and lightly trimmed (the `AlertDialogMedia` variant was dropped as unused; import paths re-pointed to `@/lib/utils` and `@/components/ui/button`). The underlying Radix primitive is `@radix-ui/react-alert-dialog@1.1.15`, already vendored by the umbrella `radix-ui@1.4.3` peer that the iter-1/iter-2 components import from — no new top-level dependency was added. File-level provenance comment in the component itself records the fetch URL and date for upstream tracking.
- **2026-05-26 (Vehicles iter 4):** `select.tsx` added. Source copied from `https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/select.tsx` (fetched 2026-05-26). Underlying primitive is `@radix-ui/react-select` vendored via the umbrella `radix-ui@1.4.3` peer (same import shape as `button.tsx`, `form.tsx`, `alert-dialog.tsx` — no new top-level dependency). Local edits to upstream: (a) the three lucide-react icon imports were initially replaced with byte-equivalent inline SVG components because `lucide-react` was not yet a dependency of `apps/web` — **reversed 2026-06-06 (see the 2026-06-06 entry below): `lucide-react` was adopted, the inline substitutes were removed, and the icons now import from `lucide-react` (`Check` / `ChevronDown` / `ChevronUp`), discharging the tech-debt entry.** (b) Import paths re-pointed to `@/lib/utils`. Tailwind class strings preserved byte-for-byte; the CSS variable aliases in `apps/web/src/app/globals.css` already map `--background`, `--input`, `--ring`, `--popover`, `--accent`, etc. onto the FleetCo semantic tokens. File-level provenance comment in the component itself records the fetch URL, date, and (as of 2026-06-06) the lucide-react adoption rationale for upstream tracking.
- **2026-06-05 (BS dates N3):** `badge.tsx` added. Hand-written (not CLI-pulled) as a CVA `<span>` mirroring `button.tsx`'s `cva`/`cn` shape — no new top-level dependency. A status indicator, never an action (anti-pattern #2). Its five variants (`warning`/`error`/`success`/`info`/`neutral`) bind only to `color.status.*` / surface / text tokens already declared in DESIGN.md → `globals.css` `@theme`, so it introduces no new design token and the design-token-drift test is untouched. Implements the §"Status badges" contract verbatim (amber = expiring-soon/warning, red = error, `radius.sm` + `text.xs`, hue always paired with a text label). First consumer: the vehicle-compliance expiry badges on the Vehicle detail page (ADR-0031 §E).
- **2026-06-06 (Polish & debt sweep, P2):** `lucide-react` adopted as a direct dependency of `apps/web` — the icon library this §Iconography section already names — paying off the "`lucide-react` not yet adopted" tech-debt entry. The three inline-SVG icon substitutes in `select.tsx` (`ChevronDown` / `ChevronUp` / `Check`) and the inline `SortArrow` `<svg>` in `vehicles/page.tsx` now render from `lucide-react`'s named imports. Null visual diff: Lucide's chevron/check path data is byte-identical to the removed inline SVGs (verified against the installed `lucide-react@1.17.0`), and each call-site passes an explicit `strokeWidth` (1.5 for the size-4 chevrons, 1.75 for the size-4 Check and the 12px sort arrow) plus `aria-hidden`, matching the prior render and the §Iconography "Stroke width" rule (1.5/1.75, **not** Lucide's default of 2). No new design token — the design-token-drift test is untouched. Isolated to its own PR (`feat/lucide-react-adoption`), mirroring the `bullmq` / `react-leaflet` / `nepali-date-converter` dependency-isolation precedent.

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
- **Number input:** same shell as text input. For NPR/paisa entry, use the `<MoneyInput>` component documented in [Data display](#data-display) — paisa-aware, integer entry, group separators applied on blur.
- **Date input:** use the `<NepaliDate>` component documented in [Nepal-specific considerations](#nepal-specific-considerations); BS-Gregorian dual display; trigger button shows both calendars; popup calendar shows BS month grid with Gregorian dates underlaid.
- **Select dropdown:** shadcn-ui `Select` (Radix-backed); keyboard-navigable; portal-rendered to escape stacking contexts.
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

- **Money:** `<Money paisa={integer} />` component. Output: `Rs. ` + Intl-grouped integer rupees (en-IN locale, Nepali lakh grouping) + `.` + 2-digit paisa. Examples: `12550025` paisa → `"Rs. 1,25,500.25"`; `100` paisa → `"Rs. 1.00"`; `0` paisa → `"Rs. 0.00"`. Right-aligned in tables; `tabular-nums` applied. Negative amounts use parentheses: `-125000` paisa → `"(Rs. 1,250.00)"`. See [NPR / paisa display](#npr--paisa-display) for the full specification.
- **Dates:** `<NepaliDate iso="2026-05-20" format="bs|en|both" />`. Default `format="both"` shows BS prominent (`2082 Jestha 6`) with Gregorian in muted parenthetical (`(2026-05-20)`); `format="bs"` shows BS only; `format="en"` shows Gregorian only. The calendar widget pattern is documented in [BS calendar](#bs-bikram-sambat-calendar).
- **Duration:** human-readable, abbreviated. `"2h 15m"` for hours/minutes; `"3d 4h"` for multi-day; `"45m"` for short durations. No "minutes" or "hours" spelled out; the unit suffix is the unit.
- **Distance:** Latin numerals, kilometers, one decimal place: `"12.4 km"`. No imperial units; FleetCo operates in Nepal and never displays miles.
- **Status badges:** `<Badge variant="...">` — emerald (in-progress / scheduled / success), zinc (completed / inactive), red (failed / cancelled / error), amber (expiring-soon / warning). Status badges always pair the hue with a text label; never hue-only. The hue is recognition; the label is meaning.

## Surfaces

Page-level compositions that arrange the Components above into a specific screen. A surface introduces **no new tokens or components — only an arrangement**, so it is specified here in prose and built directly from this section. ADR-0008 permits a locked `docs/design/slices/<name>.html` mockup when a surface "benefits from a mockup," and ADR-0007 names "a dashboard" as such a candidate; the established FleetCo practice, however — every Phase-1 aggregate **and the per-vehicle cost report** — has built surfaces directly from this file without a slice mockup, and the surfaces below reuse only already-designed components. They are therefore specified here, not as slice mockups; this section records that deliberate choice.

### Home dashboard

- **Purpose.** The authenticated landing surface (`/`). It replaces the placeholder navigation-only home with a daily-ops overview — what the operator needs to see and act on first — composed entirely from existing operational data (no dashboard-specific backend). It is the operator's instrument panel, not a marketing home.
- **Shell & header.** A server component behind the auth gate (unauthenticated → `/login`). The app's standard container: `<main class="bg-surface-canvas min-h-svh">` with `mx-auto max-w-6xl px-8 py-8`. Page header per [Navigation](#navigation) "Page header": title `text-2xl font-semibold`, a `text-sm` `color.text.muted` subline carrying today's date via `<NepaliDate format="both">` and "Signed in as `<email>`", and a right-aligned sign-out in the header action row. Until the [Navigation](#navigation) sidebar is built, this surface also carries the app's primary navigation (see "Quick links").
- **Zone A — overview cards.** A responsive grid (`grid gap-4 sm:grid-cols-2 lg:grid-cols-3`). Each card uses the section idiom (`border-border-subtle bg-surface-raised rounded border p-4 shadow-sm`; `text-lg`, `font-semibold` title; dense `text-sm` / `text-xs` body; `tabular-nums` on numbers; status hues only via `<Badge>`). Six cards, in priority order:
  1. **Fleet compliance** (headline; spans the grid full-width, `lg:col-span-3`). The day's most actionable signal: how many vehicles carry a lapsing or lapsed compliance document. Shows the count of vehicles needing attention, then two chips — `<Badge variant="error">N expired</Badge>` and `<Badge variant="warning">N expiring soon</Badge>` — and a muted "across M vehicles", with "Review vehicles →" linking to `/vehicles`. A vehicle's state is the **worst** of its three documents (bluebook / insurance / route permit), classified by the shipped `complianceBadgeState` helper (the 30-day window). All-clear is a stated fact, not a celebration: `<Badge variant="success">All documents current</Badge>`. Empty fleet → "No vehicles registered." linking to `/vehicles/new`.
  2. **Active trips.** Trips in progress now: a count + a short list (≤ 5) of `registration · driver`, each `<Badge variant="success">In progress</Badge>`; "All trips →". Empty → "No trips in progress."
  3. **This-month cost.** The fleet's fuel + expense spend for the current calendar month: the total via the money display (`<Money>` / `formatNpr`), a muted fuel/other split, the month range, and "Cost report →". Empty → `Rs. 0.00` and "No fuel or expense logs this month."
  4. **Recent fuel** & **5. Recent expenses.** The last five entries each — `registration · <NepaliDate> · amount` — linking to the respective log surface. Empty → "No fuel logs." / "No expense logs."
  6. **Fleet counts.** Three tabular stats — vehicles, drivers, active trips.
- **Zone B — Quick links.** The dashboard **augments, never replaces, navigation.** Every CRUD destination (Vehicles, Drivers, Trips, Customers, Jobs, Fuel logs, Expense logs, Geofences, Cost report) stays one click away as a compact link strip below the cards. This surface carries the app's navigation until the [Navigation](#navigation) sidebar is built; removing the links would strand those screens.
- **Data & states.** The cards compose existing read endpoints fetched in parallel — no dashboard-specific endpoint. Per [Voice](#voice-and-tone), every empty/zero state states the fact without exclamation or apology ("No trips in progress.", "All documents current"). The surface ships a loading skeleton (the root `loading.tsx`, mirroring the list pages' `animate-pulse` blocks) and an error boundary whose copy is the Voice network-error line — "Cannot reach the server. Retry." The compliance count is bounded by the vehicles-list page size (200); a larger fleet is a future dedicated-count concern, not a dashboard one.
- **Anti-patterns referenced:** #3 (cards are summaries with a single contextual link, not navigable tiles with competing inner primary buttons), #7 (status is a `<Badge>`, never row-level color coding), #4 (no gradients).

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
- **Default rendering:** `"2082 Jestha 6 (2026-05-20)"` — BS prominent in Latin transliteration, Gregorian parenthetical in `color.text.muted`.
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

**Slice mockups.** When a Phase 1 slice has a locked HTML mockup, it lives at `docs/design/slices/<slice-name>.html` per ADR-0008. DESIGN.md is the token + component language; slice mockups apply that language to specific surfaces. After implementation merges, the mockup moves to `docs/design/slices/_archive/`. External design tools (Open Design, Figma, hand-coded HTML) are iteration surfaces only; conclusions must commit to `docs/design/` to count as the project's perceptual memory.
