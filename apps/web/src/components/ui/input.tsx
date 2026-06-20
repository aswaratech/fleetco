import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // Re-pointed from shadcn `:root` aliases to FleetCo `@theme` utilities
        // (DESIGN.md §"How this file relates to code"); inert `dark:` variants
        // dropped (light mode only); radius.default `rounded` (4px) per §Borders.
        "h-9 w-full min-w-0 rounded border border-border-strong bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-accent-primary selection:text-accent-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text-primary placeholder:text-text-muted disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-border-focus focus-visible:ring-[3px] focus-visible:ring-border-focus/50",
        "aria-invalid:border-status-error aria-invalid:ring-status-error/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
