// Skeleton for /reports/per-vehicle-efficiency. Rendered by Next.js's Suspense
// boundary while page.tsx's server fetch is in flight — most commonly on a
// filter change (the PerVehicleEfficiencyFilters island calls router.push
// inside a transition). Matches the page layout (max-width, header block,
// three filters, bordered table section with N skeleton rows, coverage note)
// so the transition is layout-stable. The per-vehicle-cost report ships no
// loading.tsx; this mirrors the list-page skeleton shape (e.g. expense-logs/
// loading.tsx) adapted to a report with no pagination bar.

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
          <div className="flex flex-col gap-1">
            <div className="bg-surface-muted h-3 w-12 animate-pulse rounded" />
            <div className="bg-surface-muted h-9 w-56 animate-pulse rounded" />
          </div>
          <div className="flex flex-col gap-1">
            <div className="bg-surface-muted h-3 w-8 animate-pulse rounded" />
            <div className="bg-surface-muted h-9 w-56 animate-pulse rounded" />
          </div>
          <div className="flex flex-col gap-1">
            <div className="bg-surface-muted h-3 w-14 animate-pulse rounded" />
            <div className="bg-surface-muted h-9 w-56 animate-pulse rounded" />
          </div>
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
              <div className="bg-surface-muted h-3 w-16 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-20 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-24 animate-pulse rounded" />
              <div className="bg-surface-muted h-5 w-24 animate-pulse rounded" />
            </div>
          ))}
        </section>

        <div
          className="bg-surface-muted h-3 w-full max-w-3xl animate-pulse rounded"
          aria-hidden="true"
        />

        <p className="sr-only">Loading fuel-efficiency report…</p>
      </div>
    </main>
  );
}
