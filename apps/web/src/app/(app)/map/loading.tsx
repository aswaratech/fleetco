// Skeleton for /map (DESIGN.md §"Live map": a map-shaped animate-pulse
// block + sidebar rows). Rendered by Next.js's Suspense boundary while the
// server page's initial fetches are in flight; matches the page layout
// (header block, map + sidebar split) so the transition is layout-stable.

export default function Loading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh" aria-busy="true">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="space-y-2">
          <div className="bg-surface-muted h-4 w-32 animate-pulse rounded" aria-hidden="true" />
          <div className="bg-surface-muted h-8 w-40 animate-pulse rounded" aria-hidden="true" />
          <div className="bg-surface-muted h-4 w-72 animate-pulse rounded" aria-hidden="true" />
        </header>

        <div className="flex flex-col gap-4 lg:flex-row">
          <div
            className="bg-surface-muted min-h-[70vh] flex-1 animate-pulse rounded"
            aria-hidden="true"
          />
          <div className="w-full shrink-0 space-y-4 lg:w-72" aria-hidden="true">
            <div className="border-border-subtle bg-surface-raised space-y-2 rounded border p-4 shadow-sm">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="bg-surface-muted h-4 w-full animate-pulse rounded" />
              ))}
            </div>
            <div className="border-border-subtle bg-surface-raised space-y-2 rounded border p-4 shadow-sm">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="bg-surface-muted h-4 w-full animate-pulse rounded" />
              ))}
            </div>
          </div>
        </div>

        <p className="sr-only">Loading the live map…</p>
      </div>
    </main>
  );
}
