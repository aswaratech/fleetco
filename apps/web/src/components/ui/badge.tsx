import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// <Badge> — a status indicator, NOT an action. DESIGN.md anti-pattern #2
// ("Badges are status, not actions") is why this renders a <span>, never a
// button and never an interactive element. Mirrors button.tsx's CVA shape
// (same `cva`/`cn` convention), ADR-0031 commitment 5 / §E.
//
// Every variant is bound to a `color.status.*` / surface / text token ALREADY
// declared in DESIGN.md → globals.css `@theme`, so this component introduces
// NO new design token and the design-token-drift test
// (apps/web/test/design-token-drift.test.ts) stays untouched and green.
//
// DESIGN.md §"Status badges" fixes the palette: amber = expiring-soon /
// warning, red = failed / cancelled / error, emerald = in-progress / scheduled
// / success, zinc = completed / inactive (the neutral chip), blue =
// informational (rare). "Status badges always pair the hue with a text label;
// never hue-only — the hue is recognition, the label is meaning." `radius.sm`
// (rounded-sm) + `text.xs` per the DESIGN.md badge tokens.
//
// Foreground choice is per-variant for legibility: white on the darker
// saturated fills (matching the destructive/primary buttons' white-on-color),
// and near-black `text-text-primary` on the light amber `warning` fill (amber
// + white fails contrast; amber + near-black is the legible caution pairing).
// N3 renders only `warning` and `error` (the compliance badges); the other
// three round out DESIGN.md's status set for future adopters.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 rounded-sm px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      variant: {
        warning: "bg-status-warning text-text-primary",
        error: "bg-status-error text-white",
        success: "bg-status-success text-white",
        info: "bg-status-info text-white",
        neutral: "bg-surface-muted text-text-secondary",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

function Badge({
  className,
  variant = "neutral",
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
