// Detail-page skeleton. Rendered by Next.js's Suspense boundary while
// the server-side fetch in page.tsx is in flight. Matches the detail
// page's layout (max-width, header block, definition-list card) so the
// transition is layout-stable. Iter 3 sets the loading/error precedent
// for the Vehicles slice — see DESIGN.md §"Inputs and forms"
// "Loading and error states for server-rendered pages".

export default function Loading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh" aria-busy="true">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="space-y-2">
          <div className="bg-surface-muted h-4 w-48 animate-pulse rounded" aria-hidden="true" />
          <div className="bg-surface-muted h-8 w-64 animate-pulse rounded" aria-hidden="true" />
          <div className="bg-surface-muted h-4 w-40 animate-pulse rounded" aria-hidden="true" />
        </header>
        <section
          className="border-border-subtle bg-surface-raised rounded border p-6 shadow-sm"
          aria-hidden="true"
        >
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <div className="bg-surface-muted h-3 w-24 animate-pulse rounded" />
                <div className="bg-surface-muted h-4 w-40 animate-pulse rounded" />
              </div>
            ))}
          </dl>
        </section>
        <p className="sr-only">Loading vehicle…</p>
      </div>
    </main>
  );
}
