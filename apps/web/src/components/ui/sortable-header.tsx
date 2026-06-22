import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp } from "lucide-react";

import { TableHead } from "@/components/ui/table";
import { sortParams, type SortDir } from "@/lib/list-params";

// Shared sortable table header + its sort-direction arrow, extracted from the
// 12 list pages (identical modulo the hardcoded route base, now the `basePath`
// prop). The arrow renders Lucide ChevronUp/ChevronDown per DESIGN.md
// §Iconography; the 2026-06-06 polish sweep already migrated the vehicles page
// to these and recorded that Lucide's chevron path data is byte-identical to
// the inline SVG the other 11 pages carried — so adopting this shared arrow is
// a null visual diff. Server-renderable (no client state): the page passes its
// current URLSearchParams and the header renders <Link>s, so navigation flows
// through the router exactly as the inline copies did.

export function SortArrow({ direction }: { direction: SortDir }): React.ReactElement {
  const className = "ml-1 inline size-3 align-[-1px]";
  return direction === "asc" ? (
    <ChevronUp className={className} strokeWidth={1.75} aria-hidden="true" />
  ) : (
    <ChevronDown className={className} strokeWidth={1.75} aria-hidden="true" />
  );
}

export interface SortableHeaderProps {
  /** Route base the sort link points at, e.g. "/customers". */
  basePath: string;
  /** This header's column key. */
  column: string;
  /** The currently active sort column. */
  activeColumn: string;
  /** The currently active sort direction. */
  activeDir: SortDir;
  /** The page's current URL search params (sort / filter / skip state). */
  searchParams: URLSearchParams;
  className?: string;
  children: React.ReactNode;
}

export function SortableHeader({
  basePath,
  column,
  activeColumn,
  activeDir,
  searchParams,
  className,
  children,
}: SortableHeaderProps): React.ReactElement {
  const isActive = column === activeColumn;
  const href = `${basePath}${sortParams(searchParams, column, activeColumn, activeDir)}`;
  const ariaSort: "ascending" | "descending" | "none" = isActive
    ? activeDir === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <TableHead aria-sort={ariaSort} className={className}>
      <Link
        href={href}
        className="hover:text-text-primary focus-visible:outline-border-focus inline-flex items-center focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {children}
        {isActive ? <SortArrow direction={activeDir} /> : null}
      </Link>
    </TableHead>
  );
}
