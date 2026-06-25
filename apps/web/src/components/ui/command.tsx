"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

// shadcn-ui Command primitive (copy-paste-not-install per ADR-0016), backing the
// ⌘K command palette (ADR-0040, Phase-1 T7).
//
// Provenance:
//   - Source: https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/command.tsx
//   - Fetched: 2026-06-25 (command palette T7, feat/cmdk-command-palette).
//   - Underlying primitive: `cmdk@^1.1.1` — THE one new top-level dependency this
//     ticket adds (ADR-0040). React-19 support verified at add time (its peer range
//     is `react: ^18 || ^19 || ^19.0.0-rc`; the lockfile resolved it against
//     react@19.2.6) — the check the react-leaflet-v5 lesson made mandatory.
//   - Local edits to the upstream:
//       (a) Color classes re-pointed from shadcn's dead `:root` aliases to FleetCo's
//           `@theme` semantic tokens, exactly as popover.tsx documents — in Tailwind 4
//           only `@theme` `--color-*` vars become utilities, so shadcn's `:root`
//           aliases (`bg-popover`, `text-muted-foreground`, `bg-accent`, `bg-border`,
//           …) compile to nothing here. Mapping:
//             `bg-popover`                       → `bg-surface-elevated`
//             `text-popover-foreground` / `text-foreground` → `text-text-primary`
//             `text-muted-foreground`            → `text-text-muted`
//             `data-[selected=true]:bg-accent`   → `data-[selected=true]:bg-surface-muted`
//             `data-[selected=true]:text-accent-foreground`
//                                                → `data-[selected=true]:text-text-primary`
//                 (NOT `text-accent-foreground` — that alias is LIVE and resolves to
//                  WHITE, which on the light `surface-muted` highlight is invisible;
//                  the mockup's active item is `text-primary` on `surface-muted`.)
//             `[&_svg]:text-muted-foreground`    → dropped (icons inherit currentColor,
//                                                  so a row's icon matches its text)
//             `bg-border` (separator)            → `bg-border-subtle`
//           The design-token-consumption guard (apps/web/test/design-token-consumption.test.ts)
//           auto-scans every ui/*.tsx and fails CI on any dead alias, so this is enforced.
//           No new design token is introduced (these tokens already exist) → the
//           design-token-drift test is untouched.
//       (b) Radius per DESIGN.md §Borders: the surface is `rounded-lg` (8px), controls
//           are `rounded` (4px) — never shadcn's `rounded-md` (6px).
//       (c) Geometry matched to the locked mockup Frame 2
//           (docs/design/slices/_archive/app-shell.html, the `.palette*` rules): a
//           560px surface, a 48px search row, a 320px scrolling list, 38px item rows,
//           11px group labels — see the per-component classes below.
//       (d) Two structural deviations from upstream, both deliberate:
//           - CommandDialog is built directly on the `radix-ui` umbrella's Dialog
//             (the same import shape popover.tsx/select.tsx/alert-dialog.tsx use)
//             instead of shadcn's `Dialog` component — that primitive is "Contract
//             only" here (not copied in), and the umbrella `radix-ui@1.4.3` already
//             vendors `@radix-ui/react-dialog`, so the modal adds NO new dependency.
//             cmdk also pulls react-dialog transitively; we consume the umbrella, not
//             the transitive copy. A visually-hidden Dialog Title/Description satisfy
//             Radix's labelling requirement.
//           - The "↑↓ navigate · ↵ open · esc close" footer the mockup shows is
//             composed at the call-site (the AppShell), not baked into this primitive,
//             so the primitive stays a faithful, reusable shadcn shape.
//       (e) Icons import from `lucide-react` (the non-suffixed `Search`), per
//           DESIGN.md §Iconography, at the documented `strokeWidth={1.5}`.
//       (f) Aligned import paths to project convention (`@/lib/utils`).
//   - When upstream changes meaningfully (new variant, accessibility fix), re-fetch
//     the source and re-apply the edits above in a separate PR per ADR-0016's
//     "manual upstream tracking" cost.
//
// DESIGN.md §"Command palette" specifies the surface; <AppShell> mounts it (the ⌘K
// listener + the top-bar "Search… ⌘K" affordance) and feeds it navForRole(role).

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "bg-surface-elevated text-text-primary flex h-full w-full flex-col overflow-hidden rounded-lg",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({ children, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return (
    <DialogPrimitive.Root {...props}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="command-overlay"
          className="fixed inset-0 z-50 bg-black/40"
        />
        <DialogPrimitive.Content
          data-slot="command-dialog"
          className="bg-surface-elevated text-text-primary border-border-subtle fixed top-24 left-1/2 z-50 w-[560px] max-w-[calc(100%-48px)] -translate-x-1/2 overflow-hidden rounded-lg border p-0 shadow-lg outline-hidden"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search for a page and press Enter to navigate to it.
          </DialogPrimitive.Description>
          <Command>{children}</Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="border-border-subtle flex h-12 items-center gap-2.5 border-b px-3.5"
    >
      <Search className="text-text-muted size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "text-text-primary placeholder:text-text-muted flex h-full w-full rounded bg-transparent text-[15px] outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-[320px] scroll-py-1 overflow-x-hidden overflow-y-auto p-1.5", className)}
      {...props}
    />
  );
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="text-text-muted py-6 text-center text-sm"
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "text-text-primary [&_[cmdk-group-heading]]:text-text-muted overflow-hidden [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("bg-border-subtle -mx-1 h-px", className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "text-text-secondary data-[selected=true]:bg-surface-muted data-[selected=true]:text-text-primary relative flex h-[38px] cursor-pointer items-center gap-2.5 rounded px-2.5 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn("text-text-muted ml-auto text-xs tracking-widest", className)}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
