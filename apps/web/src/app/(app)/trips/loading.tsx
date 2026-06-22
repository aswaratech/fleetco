// List-page skeleton for /trips. Rendered by Next.js's Suspense
// boundary while page.tsx's server-side fetch is in flight — most
// commonly on a filter / sort / pagination change (the TripsFilters
// client island calls router.push inside a transition, which triggers
// this loading state). Matches the page layout (max-width, header
// block, filter toolbar, table with N skeleton rows, pagination bar)
// so the transition is layout-stable.
//
// Mirrors apps/web/src/app/drivers/loading.tsx in structure. The iter-8
// read path does not render a "New trip" CTA (the iter-9 write path
// adds it), so the header skeleton is narrower than the iter-7 Drivers
// loading shape; we match the iter-6 Drivers shape instead.

const SKELETON_ROW_COUNT = 8;

export default function Loading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh" aria-busy="true">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-2">
            <div className="bg-surface-muted h-4 w-32 animate-pulse rounded" aria-hidden="true" />
            <div className="bg-surface-muted h-8 w-32 animate-pulse rounded" aria-hidden="true" />
            <div className="bg-surface-muted h-4 w-24 animate-pulse rounded" aria-hidden="true" />
          </div>
        </header>

        {/* Filter toolbar skeleton — one select-shaped placeholder
            sized like the real status trigger (w-44, h-9). Trips iter-8
            ships a single filter; vehicleId / driverId arrive on the
            URL transparently from the detail-page deep links. */}
        <div className="flex flex-wrap items-end gap-3" aria-hidden="true">
          <div className="flex flex-col gap-1">
            <div className="bg-surface-muted h-3 w-12 animate-pulse rounded" />
            <div className="bg-surface-muted h-9 w-44 animate-pulse rounded" />
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
              <div className="bg-surface-muted h-3 w-28 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-36 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-20 animate-pulse rounded" />
              <div className="bg-surface-muted ml-auto h-3 w-28 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-28 animate-pulse rounded" />
            </div>
          ))}
          <div className="border-border-subtle flex h-12 items-center justify-between border-t px-3">
            <div className="bg-surface-muted h-3 w-40 animate-pulse rounded" aria-hidden="true" />
            <div className="flex gap-2" aria-hidden="true">
              <div className="bg-surface-muted h-8 w-20 animate-pulse rounded" />
              <div className="bg-surface-muted h-8 w-8 animate-pulse rounded" />
              <div className="bg-surface-muted h-8 w-20 animate-pulse rounded" />
            </div>
          </div>
        </section>

        <p className="sr-only">Loading trips…</p>
      </div>
    </main>
  );
}
