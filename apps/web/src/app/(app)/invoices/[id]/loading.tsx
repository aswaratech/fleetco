// Detail-page skeleton for /invoices/[id]. Rendered by Next.js's Suspense boundary
// while page.tsx's server fetch is in flight. Mirrors the detail layout (header
// block + action cluster, then four stacked section cards) so the transition is
// layout-stable. Mirrors apps/web/src/app/jobs/[id] detail shape.

export default function Loading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh" aria-busy="true">
      <div className="mx-auto max-w-3xl space-y-6 px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-2">
            <div className="bg-surface-muted h-4 w-44 animate-pulse rounded" aria-hidden="true" />
            <div className="bg-surface-muted h-8 w-48 animate-pulse rounded" aria-hidden="true" />
            <div className="bg-surface-muted h-4 w-40 animate-pulse rounded" aria-hidden="true" />
          </div>
          <div className="flex gap-2" aria-hidden="true">
            <div className="bg-surface-muted h-9 w-28 animate-pulse rounded" />
            <div className="bg-surface-muted h-9 w-20 animate-pulse rounded" />
          </div>
        </header>

        {Array.from({ length: 4 }).map((_, i) => (
          <section
            key={i}
            className="border-border-subtle bg-surface-raised space-y-4 rounded border p-6 shadow-sm"
            aria-hidden="true"
          >
            <div className="bg-surface-muted h-3 w-24 animate-pulse rounded" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="bg-surface-muted h-4 w-40 animate-pulse rounded" />
              <div className="bg-surface-muted h-4 w-32 animate-pulse rounded" />
              <div className="bg-surface-muted h-4 w-36 animate-pulse rounded" />
              <div className="bg-surface-muted h-4 w-28 animate-pulse rounded" />
            </div>
          </section>
        ))}

        <p className="sr-only">Loading invoice…</p>
      </div>
    </main>
  );
}
