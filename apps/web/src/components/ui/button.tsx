import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

// Class strings re-pointed from shadcn's `:root` aliases (bg-primary,
// border-input, ring-ring, …) to FleetCo's `@theme` semantic utilities,
// which are the only ones Tailwind 4 generates here (DESIGN.md §"How this
// file relates to code"; popover.tsx is the template). Mapped by resolved
// color — note shadcn's `accent-foreground` aliases text.primary, NOT
// FleetCo's accent.foreground (white); the ghost/outline hover text is
// therefore text-text-primary. The inert `dark:` variants are dropped
// (FleetCo ships light mode only, DESIGN.md §Color). radius.default is
// `rounded` (4px) per §Borders, not shadcn's `rounded-md` (6px).
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-border-focus focus-visible:ring-[3px] focus-visible:ring-border-focus/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-status-error aria-invalid:ring-status-error/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-accent-primary text-accent-foreground hover:bg-accent-primary-hover",
        destructive:
          "bg-status-error text-white hover:bg-status-error/90 focus-visible:ring-status-error/20",
        outline:
          "border border-border-subtle bg-surface-canvas shadow-xs hover:bg-surface-muted hover:text-text-primary",
        secondary: "bg-surface-muted text-text-primary hover:bg-surface-muted/80",
        ghost: "hover:bg-surface-muted hover:text-text-primary",
        link: "text-text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
