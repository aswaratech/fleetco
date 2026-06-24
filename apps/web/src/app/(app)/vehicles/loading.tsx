// List-page skeleton. Rendered by Next.js's Suspense boundary while
// /vehicles/page.tsx's server-side fetch is in flight — most commonly
// on a filter / sort / pagination change (the VehiclesFilters client
// island calls router.push inside a transition, which triggers this
// loading state). Matches the page layout (max-width, header block,
// filter toolbar, table with N skeleton rows, pagination bar) so the
// transition is layout-stable.
//
// Iter 3 set the loading/error precedent for the Vehicles slice via
// the detail page; iter 4 extends the same pattern to the list root.
// See DESIGN.md §"Inputs and forms" "Loading and error states for
// server-rendered pages".

const SKELETON_ROW_COUNT = 8;

export default function Loading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh" aria-busy="true">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-2">
            <div className="bg-surface-muted h-4 w-32 animate-pulse rounded" aria-hidden="true" />
            <div className="bg-surface-muted h-8 w-40 animate-pulse rounded" aria-hidden="true" />
            <div className="bg-surface-muted h-4 w-24 animate-pulse rounded" aria-hidden="true" />
          </div>
          <div className="bg-surface-muted h-9 w-32 animate-pulse rounded" aria-hidden="true" />
        </header>

        {/* Filter toolbar skeleton — two select-shaped placeholders
            sized like the real triggers (w-44, h-9). Layout matches
            VehiclesFilters so the transition does not jump. */}
        <div className="flex flex-wrap items-end gap-3" aria-hidden="true">
          <div className="flex flex-col gap-1">
            <div className="bg-surface-muted h-3 w-12 animate-pulse rounded" />
            <div className="bg-surface-muted h-9 w-44 animate-pulse rounded" />
          </div>
          <div className="flex flex-col gap-1">
            <div className="bg-surface-muted h-3 w-12 animate-pulse rounded" />
            <div className="bg-surface-muted h-9 w-44 animate-pulse rounded" />
          </div>
        </div>

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {/* Header row + N body rows + pagination bar. Heights line up
              with the rendered table (h-10 header, h-12 rows, bottom
              border for the pagination strip). */}
          <div className="border-border-subtle h-10 border-b" aria-hidden="true" />
          {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
            <div
              key={i}
              className="border-border-subtle flex h-12 items-center gap-4 border-b px-3 last:border-b-0"
              aria-hidden="true"
            >
              <div className="bg-surface-muted h-3 w-24 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-16 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-32 animate-pulse rounded" />
              <div className="bg-surface-muted ml-auto h-3 w-12 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-16 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-20 animate-pulse rounded" />
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

        <p className="sr-only">Loading vehicles…</p>
      </div>
    </main>
  );
}
