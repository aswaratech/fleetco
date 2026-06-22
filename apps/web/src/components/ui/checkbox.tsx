"use client";

import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

// shadcn-ui Checkbox primitive (copy-paste-not-install per ADR-0016).
//
// Provenance:
//   - Shape from shadcn-ui new-york Checkbox
//     (https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/checkbox.tsx),
//     hand-written to match. Underlying primitive @radix-ui/react-checkbox,
//     vendored via the umbrella `radix-ui@1.4.3` peer already in
//     apps/web/package.json (the same import shape as select/popover/alert-dialog
//     — no new top-level dependency).
//   - Re-pointed to FleetCo @theme tokens (DESIGN.md §"How this file relates to
//     code"): dead `:root` aliases `border-input` → `border-border-strong`;
//     `data-[state=checked]:bg-primary`/`text-primary-foreground` →
//     `bg-accent-primary`/`text-accent-foreground`; `ring-ring`/`border-ring` →
//     `ring-border-focus`/`border-border-focus`; `aria-invalid:*-destructive` →
//     `*-status-error`. Inert `dark:` variants dropped (light mode only).
//     `rounded` (radius.default, 4px); focus ring via the tokenized
//     `focus.ring.width`. The check icon is lucide-react `Check` (§Iconography)
//     at `strokeWidth={1.75}` (not Lucide's default of 2). DESIGN.md §Inputs:
//     the default control for boolean form fields.
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "border-border-strong data-[state=checked]:bg-accent-primary data-[state=checked]:text-accent-foreground data-[state=checked]:border-accent-primary focus-visible:border-border-focus focus-visible:ring-[length:var(--focus-ring-width)] focus-visible:ring-border-focus/50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 size-4 shrink-0 rounded border shadow-xs transition-shadow outline-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <Check className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
