import * as React from "react";
import Link from "next/link";

// Breadcrumb — the trail above a page title for nested resources (DESIGN.md
// §Navigation, e.g. "Vehicles › K-1-1234 › Trips › 2026-05-20"). It reproduces
// the inline pattern the pages have carried — nav[aria-label="Breadcrumb"],
// `text-text-muted text-sm`, "›" separators in an aria-hidden span, linked
// crumbs `hover:text-text-primary`, and the final (current) crumb a non-linked
// `text-text-secondary` — so adopting it on the existing pages is a null visual
// diff. The "FleetCo" root crumb is passed explicitly as items[0], matching how
// the pages spell it out today (no magic implicit first item).

export interface Crumb {
  /** Crumb text — a string, or a node (e.g. a `<NepaliDate/>`) for a rich label. */
  label: React.ReactNode;
  /** Omit on the final (current) crumb — it renders as non-linked text. */
  href?: string;
  /** Extra classes for this crumb's text, e.g. "font-mono" for a plate or id. */
  className?: string;
}

export function Breadcrumb({ items }: { items: Crumb[] }): React.ReactElement {
  return (
    <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
      {items.map((item, index) => (
        <React.Fragment key={item.href ?? "current"}>
          {index > 0 ? <span aria-hidden="true"> › </span> : null}
          {item.href ? (
            <Link
              href={item.href}
              className={["hover:text-text-primary", item.className].filter(Boolean).join(" ")}
            >
              {item.label}
            </Link>
          ) : (
            <span className={["text-text-secondary", item.className].filter(Boolean).join(" ")}>
              {item.label}
            </span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}
