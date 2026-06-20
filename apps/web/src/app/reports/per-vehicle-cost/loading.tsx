// Skeleton for /reports/per-vehicle-cost. Rendered by Next.js's Suspense
// boundary while page.tsx's server fetch is in flight (most often on a filter
// change). Matches the page layout — max-width, header block, three filters
// (from / to / vehicle), bordered table section with N skeleton rows — so the
// transition is layout-stable. Mirrors the sibling per-vehicle-efficiency/
// loading.tsx; the cost table has six columns (registration, fuel, expense,
// total, fuel-log count, expense-log count). The cost report previously shipped
// no loading.tsx (the one list/report segment that lacked one).
const SKELETON_ROW_COUNT = 6;

export default function Loading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh" aria-busy="true">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="space-y-2">
          <div className="bg-surface-muted h-4 w-64 animate-pulse rounded" aria-hidden="true" />
          <div className="bg-surface-muted h-8 w-80 animate-pulse rounded" aria-hidden="true" />
          <div className="bg-surface-muted h-4 w-56 animate-pulse rounded" aria-hidden="true" />
        </header>

        <div className="flex flex-wrap items-end gap-3" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="bg-surface-muted h-3 w-12 animate-pulse rounded" />
              <div className="bg-surface-muted h-9 w-56 animate-pulse rounded" />
            </div>
          ))}
        </div>

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          <div className="border-border-subtle h-10 border-b" aria-hidden="true" />
          {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
            <div
              key={i}
              className="border-border-subtle flex h-12 items-center gap-4 border-b px-3 last:border-b-0"
              aria-hidden="true"
            >
              <div className="bg-surface-muted h-3 w-24 animate-pulse rounded" />
              <div className="bg-surface-muted ml-auto h-3 w-20 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-20 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-20 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-12 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-12 animate-pulse rounded" />
            </div>
          ))}
        </section>

        <p className="sr-only">Loading cost report…</p>
      </div>
    </main>
  );
}
