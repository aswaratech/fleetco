import { cn } from "@/lib/utils";

// shadcn-ui Skeleton primitive (copy-paste-not-install per ADR-0016).
//
// Provenance:
//   - Shape from shadcn-ui new-york Skeleton
//     (https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/skeleton.tsx),
//     hand-written (like badge.tsx) — it is a single styled <div>, so no CLI
//     pull was warranted. No new dependency.
//   - Re-pointed to FleetCo @theme tokens (DESIGN.md §"How this file relates to
//     code"): shadcn's `bg-accent` is a dead `:root` alias here → `bg-surface-muted`;
//     `rounded-md` → `rounded` (radius.default, 4px). This is exactly the
//     animate-pulse block the list/report `loading.tsx` files already hand-build
//     (e.g. reports/per-vehicle-cost/loading.tsx); those can adopt this primitive
//     in a later pass.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-surface-muted animate-pulse rounded", className)}
      {...props}
    />
  );
}

export { Skeleton };
