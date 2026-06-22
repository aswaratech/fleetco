import * as React from "react";

import { cn } from "@/lib/utils";

// shadcn-ui Card primitive (copy-paste-not-install per ADR-0016).
//
// Provenance:
//   - Shape from shadcn-ui new-york Card
//     (https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/card.tsx),
//     hand-written as a set of styled <div>s (no Radix primitive, no CLI pull,
//     no new dependency).
//   - Re-pointed to FleetCo @theme tokens + density (DESIGN.md §Cards, §"How
//     this file relates to code"): shadcn's dead `:root` aliases
//     `bg-card`/`text-card-foreground` → `bg-surface-raised`/`text-text-primary`;
//     `text-muted-foreground` → `text-text-muted`. Density tuning: `p-4`
//     (size.card.padding, 16px) instead of shadcn's `py-6`/`px-6`; `rounded`
//     (radius.default, 4px) instead of `rounded-xl`; `shadow-sm`
//     (elevation.raised). This matches the card idiom already used inline by the
//     dashboard cards (apps/web/src/app/_dashboard/*.tsx). CardTitle is `text-lg
//     font-semibold` per §Cards.
function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "bg-surface-raised text-text-primary border-border-subtle flex flex-col gap-4 rounded border p-4 shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-header" className={cn("flex flex-col gap-1", className)} {...props} />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-title" className={cn("text-lg font-semibold", className)} {...props} />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-text-muted text-sm", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn(className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center justify-end gap-2", className)}
      {...props}
    />
  );
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
