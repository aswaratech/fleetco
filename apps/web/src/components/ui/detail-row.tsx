import * as React from "react";

// Shared definition-list row for the 12 detail pages. The inline copies
// diverged only in which optional props they carried — some lacked `numeric`,
// three lacked `className`, and notification-logs adds `break-all` for long
// monospace identifiers (emails, hex ids). This is their superset, so every
// detail page can adopt it with a null visual diff (passing only the props it
// used). The dt/dd class strings are the common form; the `uppercase` /
// `tracking-wide` ordering some pages used is computed-identical in Tailwind.

export interface DetailRowProps {
  label: string;
  value: React.ReactNode;
  /** Render the value monospace (IDs, plates, bluebook numbers). */
  mono?: boolean;
  /** Tabular figures so numeric values align across rows. */
  numeric?: boolean;
  /** Break long unbroken monospace strings (emails, hex ids). */
  breakAll?: boolean;
  className?: string;
}

export function DetailRow({
  label,
  value,
  mono,
  numeric,
  breakAll,
  className,
}: DetailRowProps): React.ReactElement {
  const valueClass = [
    "text-text-primary text-sm",
    mono ? (breakAll ? "font-mono break-all" : "font-mono") : "",
    numeric ? "tabular-nums" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const wrapperClass = ["space-y-1", className].filter(Boolean).join(" ");
  return (
    <div className={wrapperClass}>
      <dt className="text-text-muted text-xs font-medium uppercase tracking-wide">{label}</dt>
      <dd className={valueClass}>{value}</dd>
    </div>
  );
}
