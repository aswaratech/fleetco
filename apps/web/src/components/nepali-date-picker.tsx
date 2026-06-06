"use client";

import * as React from "react";
import { Calendar, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NepaliDate } from "@/components/nepali-date";
import {
  BS_MAX_YEAR,
  BS_MIN_YEAR,
  WEEKDAY_LABELS,
  buildMonthGrid,
  initialBsMonth,
  stepBsMonth,
  stepBsYear,
  type BsMonth,
} from "@/lib/nepali-date-picker";

// <NepaliDatePicker> — the Bikram Sambat date-PICKER input (ADR-0032), the
// input twin of the <NepaliDate> display component. A Radix Popover whose
// trigger shows the current BS + Gregorian date (via <NepaliDate format="both">)
// and whose panel is a BS month grid (Gregorian day underlaid in muted corner
// text, arrow controls to switch BS month/year, today outlined in
// color.accent.primary, the selected day filled) — DESIGN.md §"BS calendar".
//
// THE VALUE CONTRACT (ADR-0032 commitment 3, load-bearing): it accepts and
// emits the EXACT ISO date string (`YYYY-MM-DD`, the UTC calendar day) the
// native <input type="date"> uses, so it is a drop-in at the input layer — the
// form Zod schemas, server actions, and API contracts are untouched. All the
// conversion/grid correctness lives in the pure helpers in
// `lib/nepali-date-picker.ts` (unit-tested); this component is the thin shell.
//
// It must be a Client Component: the popover is interactive and the BS↔AD
// conversion runs in the browser as the operator navigates. The forms that use
// it are already client islands, so no server/client boundary changes.

type NepaliDatePickerProps = {
  /** The current value as an ISO/UTC date string, or null when unset. */
  value: string | null;
  /** Emits the picked day's ISO string, or null when cleared. */
  onChange: (iso: string | null) => void;
  disabled?: boolean;
} & Omit<
  React.ComponentPropsWithoutRef<"button">,
  "value" | "onChange" | "disabled" | "type" | "children"
>;

// The trigger mirrors the native date input's chrome (h-9, bordered, rounded)
// using working FleetCo @theme tokens (the shadcn :root aliases are not Tailwind
// utilities in this project — see popover.tsx provenance). `aria-invalid` is
// honored so a form error paints the border, like the other inputs intend to.
const TRIGGER_CLASSES =
  "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-border-focus focus-visible:ring-2 focus-visible:ring-border-focus aria-invalid:border-status-error disabled:cursor-not-allowed disabled:opacity-50";

const CELL_BASE =
  "relative flex size-9 flex-col items-center justify-center rounded-md leading-none tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-border-focus";

// The AD day-of-month for a cell's corner text (the Gregorian "underlay"); the
// full AD date is in the cell's title/aria-label so the corner stays compact.
function adDayOf(adIso: string): number {
  return Number(adIso.slice(8, 10));
}

function NavButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="text-text-secondary inline-flex size-7 items-center justify-center rounded-md outline-none hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-border-focus disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export const NepaliDatePicker = React.forwardRef<HTMLButtonElement, NepaliDatePickerProps>(
  function NepaliDatePicker({ value, onChange, disabled, className, ...triggerProps }, ref) {
    const [open, setOpen] = React.useState(false);
    // "now" as an ISO instant; the helpers only read its UTC calendar day.
    const todayIso = React.useMemo(() => new Date().toISOString(), []);
    const [view, setView] = React.useState<BsMonth>(() =>
      initialBsMonth({ selectedIso: value, todayIso }),
    );

    function handleOpenChange(next: boolean): void {
      // Re-sync the visible month to the selected value (or today) each time the
      // popover opens, so reopening after an external change lands in the right
      // month — avoids a useEffect and its exhaustive-deps dance.
      if (next) setView(initialBsMonth({ selectedIso: value, todayIso }));
      setOpen(next);
    }

    function handleSelect(iso: string): void {
      onChange(iso);
      setOpen(false);
    }

    function handleClear(): void {
      onChange(null);
      setOpen(false);
    }

    const grid = buildMonthGrid(view, { todayIso, selectedIso: value });

    return (
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            ref={ref}
            type="button"
            disabled={disabled}
            data-slot="nepali-date-picker-trigger"
            className={cn(TRIGGER_CLASSES, !value && "text-text-muted", className)}
            {...triggerProps}
          >
            <span className="truncate">
              {value ? <NepaliDate iso={value} format="both" /> : "Select date"}
            </span>
            <Calendar className="size-4 shrink-0 opacity-50" strokeWidth={1.5} aria-hidden="true" />
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-auto p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <NavButton
                label="Previous year"
                onClick={() => setView((v) => stepBsYear(v, -1))}
                disabled={view.year <= BS_MIN_YEAR}
              >
                <ChevronsLeft className="size-4" strokeWidth={1.5} aria-hidden="true" />
              </NavButton>
              <NavButton
                label="Previous month"
                onClick={() => setView((v) => stepBsMonth(v, -1))}
                disabled={view.year <= BS_MIN_YEAR && view.month <= 0}
              >
                <ChevronLeft className="size-4" strokeWidth={1.5} aria-hidden="true" />
              </NavButton>
            </div>

            <div className="text-text-primary text-sm font-medium tabular-nums" aria-live="polite">
              {grid.monthName} {grid.year}
            </div>

            <div className="flex items-center gap-1">
              <NavButton
                label="Next month"
                onClick={() => setView((v) => stepBsMonth(v, 1))}
                disabled={view.year >= BS_MAX_YEAR && view.month >= 11}
              >
                <ChevronRight className="size-4" strokeWidth={1.5} aria-hidden="true" />
              </NavButton>
              <NavButton
                label="Next year"
                onClick={() => setView((v) => stepBsYear(v, 1))}
                disabled={view.year >= BS_MAX_YEAR}
              >
                <ChevronsRight className="size-4" strokeWidth={1.5} aria-hidden="true" />
              </NavButton>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-1">
            {WEEKDAY_LABELS.map((label) => (
              <div
                key={label}
                className="text-text-muted flex h-8 w-9 items-center justify-center text-xs font-medium"
              >
                {label}
              </div>
            ))}

            {Array.from({ length: grid.leadingBlanks }, (_, i) => (
              <div key={`pad-${i}`} className="size-9" aria-hidden="true" />
            ))}

            {grid.cells.map((cell) => (
              <button
                key={cell.adIso}
                type="button"
                title={cell.adIso}
                aria-label={`${grid.monthName} ${cell.bsDay}, ${grid.year} (${cell.adIso})`}
                aria-pressed={cell.isSelected}
                onClick={() => handleSelect(cell.adIso)}
                className={cn(
                  CELL_BASE,
                  cell.isSelected
                    ? "bg-accent-primary text-accent-foreground"
                    : "hover:bg-surface-muted",
                  cell.isToday && !cell.isSelected && "ring-1 ring-accent-primary ring-inset",
                )}
              >
                <span className="text-sm">{cell.bsDay}</span>
                <span
                  className={cn(
                    "text-[10px]",
                    cell.isSelected ? "text-accent-foreground/80" : "text-text-muted",
                  )}
                >
                  {adDayOf(cell.adIso)}
                </span>
              </button>
            ))}
          </div>

          {value ? (
            <div className="mt-2 flex justify-end border-t border-border-subtle pt-2">
              <button
                type="button"
                onClick={handleClear}
                className="text-text-muted inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus"
              >
                <X className="size-3" strokeWidth={2} aria-hidden="true" />
                Clear
              </button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    );
  },
);

NepaliDatePicker.displayName = "NepaliDatePicker";
