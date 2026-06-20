"use client";

import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// shadcn-ui Popover primitive (copy-paste-not-install per ADR-0016).
//
// Provenance:
//   - Source: https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/popover.tsx
//   - Fetched: 2026-06-06 (BS date-picker B1, feat/bs-date-picker-b1).
//   - Underlying primitive: @radix-ui/react-popover, vendored via the umbrella
//     `radix-ui@1.4.3` package already declared as a direct dependency in
//     apps/web/package.json (the same import shape used by select.tsx,
//     alert-dialog.tsx, button.tsx, and form.tsx). No new top-level dependency
//     is introduced — ADR-0032 commitment 1 (hand-built, no new dependency).
//   - Local edits to the upstream:
//       (a) Color classes mapped from shadcn's `:root` aliases to FleetCo's
//           `@theme` semantic tokens: `bg-popover` → `bg-surface-elevated`,
//           `text-popover-foreground` → `text-text-primary`, and an explicit
//           `border-border-subtle`. This project's apps/web/src/app/globals.css
//           declares the DESIGN.md tokens as `--color-*` under `@theme` (which
//           Tailwind 4 turns into utilities like `bg-surface-elevated`) but the
//           shadcn aliases (`--popover`, `--border`, …) live under `:root` as
//           plain CSS variables, NOT theme colors — so `bg-popover` generates no
//           utility here. Mapping to the `@theme` tokens is what makes the
//           popover render an opaque elevated surface. No new design token is
//           introduced (these tokens already exist), so the design-token-drift
//           test is untouched. DESIGN.md §Foundations maps
//           `color.surface.elevated` to "Modals, popovers, dropdowns".
//       (b) The upstream entrance/exit animation utilities
//           (`data-[state=open]:animate-in`, `fade-in-0`, `zoom-in-95`,
//           `slide-in-from-*`) are kept for upstream-diff fidelity but are inert
//           in this project — it ships no tailwindcss-animate / tw-animate-css
//           plugin, so those classes generate no CSS (verified). DESIGN.md
//           §Motion keeps interaction motion minimal regardless.
//       (c) Aligned import paths to project convention (`@/lib/utils`).
//   - When upstream changes meaningfully (new variant, accessibility fix),
//     re-fetch the source and re-apply the edits above in a separate PR per
//     ADR-0016's "manual upstream tracking" cost.
//
// DESIGN.md §"BS calendar" / §Inputs "Date input" call for a popover-backed BS
// month-grid picker; this primitive is the popover surface that <NepaliDatePicker>
// (apps/web/src/components/nepali-date-picker.tsx) builds on (ADR-0032).

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "bg-surface-elevated text-text-primary data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-lg border border-border-subtle p-4 shadow-md outline-hidden",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
