// Skeleton shown while the new-trip page server-fetches the active
// Vehicle + Driver lists. Mirrors the form layout below the page
// header so the perceived load shape is stable.
export default function NewTripLoading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-2xl space-y-6 px-8 py-8">
        <header className="space-y-2">
          <div className="bg-surface-raised h-4 w-48 animate-pulse rounded" />
          <div className="bg-surface-raised h-7 w-32 animate-pulse rounded" />
          <div className="bg-surface-raised h-4 w-3/4 animate-pulse rounded" />
        </header>

        <section className="border-border-subtle bg-surface-raised space-y-4 rounded border p-6 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="bg-surface-canvas h-9 animate-pulse rounded" />
            <div className="bg-surface-canvas h-9 animate-pulse rounded" />
          </div>
          <div className="bg-surface-canvas h-9 animate-pulse rounded" />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="bg-surface-canvas h-9 animate-pulse rounded" />
            <div className="bg-surface-canvas h-9 animate-pulse rounded" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="bg-surface-canvas h-9 animate-pulse rounded" />
            <div className="bg-surface-canvas h-9 animate-pulse rounded" />
          </div>
          <div className="bg-surface-canvas h-20 animate-pulse rounded" />
        </section>
      </div>
    </main>
  );
}
