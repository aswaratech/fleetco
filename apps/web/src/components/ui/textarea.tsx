import * as React from "react";

import { cn } from "@/lib/utils";

// shadcn-ui Textarea primitive (copy-paste-not-install per ADR-0016).
//
// Provenance:
//   - Shape from shadcn-ui new-york Textarea
//     (https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/textarea.tsx),
//     hand-written (a single styled <textarea>; no Radix primitive, no new
//     dependency).
//   - Re-pointed to FleetCo @theme tokens — the same re-point input.tsx uses
//     (DESIGN.md §"How this file relates to code"): dead `:root` aliases
//     `border-input` → `border-border-strong`, `placeholder:text-muted-foreground`
//     → `placeholder:text-text-muted`, `aria-invalid:*-destructive` →
//     `*-status-error`. Inert `dark:` variants dropped (light mode only).
//     `rounded` (radius.default, 4px); the focus ring uses the tokenized
//     `focus.ring.width` (`ring-[length:var(--focus-ring-width)]`). DESIGN.md
//     §Inputs: the notes/description field — same shell as the text input.
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-border-strong placeholder:text-text-muted aria-invalid:border-status-error aria-invalid:ring-status-error/20 field-sizing-content flex min-h-16 w-full rounded border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-border-focus focus-visible:ring-[length:var(--focus-ring-width)] focus-visible:ring-border-focus/50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
