import Link from "next/link";

import { cn } from "@/lib/utils";

// The shared section-card shell for the Home dashboard's Zone A (D2 of the
// Home-dashboard program). DESIGN.md §"Surfaces" → "Home dashboard": each card
// uses the shipped section idiom (`border-border-subtle bg-surface-raised
// rounded border p-4 shadow-sm`; `text-lg` `font-semibold` title; dense
// `text-sm` / `text-xs` body). Centralising the shell here keeps every card on
// the same border / padding / title treatment and enforces DESIGN.md
// anti-pattern #3 structurally: a card is a summary with AT MOST ONE contextual
// link (rendered as a quiet text link, never a competing inner primary button).
//
// Server component — pure markup, no interactivity. The cards that fill it
// (compliance, active-trips, …) are likewise server components.

interface DashboardCardLink {
  href: string;
  /** Label shown before the trailing arrow, e.g. "Review vehicles". */
  label: string;
}

interface DashboardCardProps {
  title: string;
  /** Extra classes on the <section> — e.g. `lg:col-span-3` for the headline card. */
  className?: string;
  /** The card's single contextual link (anti-pattern #3: one link per card). */
  link?: DashboardCardLink;
  children: React.ReactNode;
}

export function DashboardCard({
  title,
  className,
  link,
  children,
}: DashboardCardProps): React.ReactElement {
  return (
    <section
      className={cn(
        "border-border-subtle bg-surface-raised flex flex-col rounded border p-4 shadow-sm",
        className,
      )}
    >
      <h2 className="text-text-primary text-lg font-semibold">{title}</h2>
      <div className="mt-2 flex-1 text-sm">{children}</div>
      {link ? (
        <div className="mt-3">
          <Link
            href={link.href}
            className="text-text-accent focus-visible:outline-border-focus inline-flex items-center gap-1 text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {link.label} <span aria-hidden="true">→</span>
          </Link>
        </div>
      ) : null}
    </section>
  );
}
