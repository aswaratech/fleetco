"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";

// shadcn-ui Select primitive (copy-paste-not-install per ADR-0016).
//
// Provenance:
//   - Source: https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/select.tsx
//   - Fetched: 2026-05-26 (Vehicles iter 4, feat/vehicles-list-polish).
//   - Underlying primitive: @radix-ui/react-select, vendored via the
//     umbrella `radix-ui@1.4.3` package already declared as a direct
//     dependency in apps/web/package.json (the same import shape used by
//     button.tsx, form.tsx, and alert-dialog.tsx). No new top-level
//     dependency is introduced.
//   - Local edits to the upstream:
//       (a) Icons import from `lucide-react` — `Check` / `ChevronDown` /
//           `ChevronUp`, the project icon library per DESIGN.md
//           §Iconography. lucide-react was adopted (and this file's three
//           prior byte-equivalent inline-SVG substitutes removed) in the
//           P2 polish/debt ticket `feat/lucide-react-adoption` (2026-06-06),
//           discharging the "lucide-react not yet adopted" tech-debt entry.
//           We import the non-suffixed aliases (`ChevronDown`, …); current
//           upstream shadcn-ui uses the `*Icon` names (`ChevronDownIcon`,
//           …) — same components, lucide-react exports both. Each call-site
//           passes an explicit `strokeWidth` (1.5 for the size-4 chevrons,
//           1.75 for the size-4 Check) plus `aria-hidden="true"`, so the
//           render is byte-identical to the removed inline SVGs and honors
//           DESIGN.md §Iconography "Stroke width" (1.5/1.75 — NOT Lucide's
//           default of 2). A true null visual diff; no size class changed.
//       (b) Aligned import paths to project convention (`@/lib/utils`).
//       (c) Class strings are RE-POINTED from upstream's `:root` alias
//           utilities to the live `@theme` tokens. (An earlier version of
//           this note claimed the `:root` aliases "already map into the
//           project tokens so upstream classes render correctly" — that was
//           false and is exactly the failure the token-consumption guard
//           exists to catch: in Tailwind 4 only `@theme --color-*` variables
//           emit utilities, so `border-input` / `bg-popover` etc. compile to
//           NOTHING. The 2026-07-02 audit found 27 route files that had
//           copied class strings on that false assurance. Never keep
//           upstream color classes byte-for-byte; re-point them.)
//   - When upstream changes meaningfully (animation tokens, new size
//     variant, accessibility fix), re-fetch the source and re-apply the
//     edits above in a separate PR per ADR-0016's "manual upstream
//     tracking" cost.
//
// DESIGN.md §"Inputs and forms" calls out the shadcn-ui Select as the
// canonical dropdown for selecting from an enumerated set; the iter-4
// list-page filter toolbar is its first use.

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "border-border-strong focus-visible:border-border-focus focus-visible:ring-border-focus/50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 data-[placeholder]:text-text-muted [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-text-muted *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 flex w-fit items-center justify-between gap-2 rounded border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[length:var(--focus-ring-width)] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 opacity-50" strokeWidth={1.5} aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "item-aligned",
  align = "center",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          "bg-surface-elevated text-text-primary data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-border-subtle shadow-md",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className,
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "p-1",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("text-text-muted px-2 py-1.5 text-xs", className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "focus:bg-surface-muted focus:text-text-primary [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-text-muted *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2 outline-hidden relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 text-sm select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span
        data-slot="select-item-indicator"
        className="absolute right-2 flex size-3.5 items-center justify-center"
      >
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("bg-border-subtle pointer-events-none -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronUp className="size-4" strokeWidth={1.5} aria-hidden="true" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <ChevronDown className="size-4" strokeWidth={1.5} aria-hidden="true" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
