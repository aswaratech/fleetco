import { cn } from "@/lib/utils";
import { formatNpr } from "@/lib/money";

// <Money> — the FleetCo NPR display component (DESIGN.md §Data display).
// A FleetCo component (not a shadcn primitive), homed alongside <NepaliDate>
// in components/ rather than components/ui/. It wraps the single web-side money
// formatter, `formatNpr` (lib/money.ts): "Rs. " + Nepali lakh-grouped rupees +
// 2-digit paisa, negatives in parentheses, em-dash for null/undefined
// (anti-pattern #11). `tabular-nums` is applied so digits align across table
// rows; the cell owns alignment (`text-right` in numeric table columns).
// Render-only — money stays integer paisa everywhere in code (anti-pattern #14);
// never convert a formatted string back to a number.
interface MoneyProps extends Omit<React.ComponentProps<"span">, "children"> {
  paisa: number | null | undefined;
}

export function Money({ paisa, className, ...props }: MoneyProps): React.ReactElement {
  return (
    <span data-slot="money" className={cn("tabular-nums", className)} {...props}>
      {formatNpr(paisa)}
    </span>
  );
}
