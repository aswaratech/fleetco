// Edit-page skeleton. Rendered by Next.js's Suspense boundary while the
// server-side fetch in page.tsx is in flight. Matches the edit form's
// layout (max-width, header block, form card with ~8 rows of inputs)
// so the transition is layout-stable. Iter 3 precedent — see
// DESIGN.md §"Inputs and forms" "Loading and error states for
// server-rendered pages".

export default function Loading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh" aria-busy="true">
      <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
        <header className="space-y-2">
          <div className="bg-surface-muted h-4 w-56 animate-pulse rounded" aria-hidden="true" />
          <div className="bg-surface-muted h-8 w-48 animate-pulse rounded" aria-hidden="true" />
          <div className="bg-surface-muted h-4 w-72 animate-pulse rounded" aria-hidden="true" />
        </header>
        <section
          className="border-border-subtle bg-surface-raised space-y-4 rounded border p-6 shadow-sm"
          aria-hidden="true"
        >
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="bg-surface-muted h-3 w-24 animate-pulse rounded" />
              <div className="bg-surface-muted h-9 w-full animate-pulse rounded" />
            </div>
          ))}
        </section>
        <p className="sr-only">Loading vehicle…</p>
      </div>
    </main>
  );
}
