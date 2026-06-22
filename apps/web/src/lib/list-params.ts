// Shared URL-builder helpers for the list surfaces' sortable headers and
// paginator. Extracted verbatim from the per-page inline copies, which the
// divergence audit confirmed byte-identical across all 12 list pages. The
// shared <SortableHeader> and <Pagination> (components/ui/) consume these.
//
// Pure string builders: each takes the page's current URLSearchParams and
// returns a query string ("?…" or "") that the component prepends to the
// page's basePath. They live here, not in ui/, because they carry no JSX —
// keeping ui/ to components and letting this logic be unit-tested directly.
// They never mutate the input (they copy into a fresh URLSearchParams).

export type SortDir = "asc" | "desc";

/**
 * Build the query string for a pagination control. Filter and sort values are
 * preserved; only `skip` changes, and it is dropped entirely at skip=0 so the
 * canonical first-page URL stays clean.
 */
export function paginationParams(searchParams: URLSearchParams, nextSkip: number): string {
  const next = new URLSearchParams(searchParams);
  if (nextSkip === 0) {
    next.delete("skip");
  } else {
    next.set("skip", String(nextSkip));
  }
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Build the query string for a sortable column header. Clicking the active
 * column toggles its direction; clicking a different column selects it
 * descending. `skip` is reset so a re-sort returns to the first page.
 */
export function sortParams(
  searchParams: URLSearchParams,
  column: string,
  activeColumn: string,
  activeDir: SortDir,
): string {
  const next = new URLSearchParams(searchParams);
  if (column === activeColumn) {
    next.set("sortDir", activeDir === "asc" ? "desc" : "asc");
    next.set("sortBy", column);
  } else {
    next.set("sortBy", column);
    next.set("sortDir", "desc");
  }
  next.delete("skip");
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}
