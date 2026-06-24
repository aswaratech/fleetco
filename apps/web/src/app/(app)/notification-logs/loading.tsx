// List-page skeleton for /notification-logs. Rendered by Next.js's Suspense
// boundary while page.tsx's server-side fetch is in flight — most commonly on a
// filter / sort / pagination change (the NotificationLogsFilters client island
// calls router.push inside a transition, which triggers this loading state).
// Matches the page layout (header, the read-only config panel, one filter
// select, a six-column table, pagination bar) so the transition is layout-stable.
//
// Mirrors apps/web/src/app/customers/loading.tsx with the notification-logs
// shape: a config-panel placeholder above the toolbar, and six table-row column
// bars (Sent, Subject, Kind, State, Recipient, Provider message id).

const SKELETON_ROW_COUNT = 8;

export default function Loading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh" aria-busy="true">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="space-y-2">
          <div className="bg-surface-muted h-4 w-40 animate-pulse rounded" aria-hidden="true" />
          <div className="bg-surface-muted h-8 w-48 animate-pulse rounded" aria-hidden="true" />
          <div className="bg-surface-muted h-4 w-24 animate-pulse rounded" aria-hidden="true" />
        </header>

        {/* Read-only delivery-config panel skeleton. */}
        <div
          className="border-border-subtle bg-surface-raised space-y-2 rounded border p-4 shadow-sm"
          aria-hidden="true"
        >
          <div className="bg-surface-muted h-3 w-32 animate-pulse rounded" />
          <div className="bg-surface-muted h-3 w-full animate-pulse rounded" />
          <div className="bg-surface-muted h-3 w-3/4 animate-pulse rounded" />
        </div>

        {/* Filter toolbar skeleton — one select-shaped placeholder. */}
        <div className="flex flex-wrap items-end gap-3" aria-hidden="true">
          <div className="flex flex-col gap-1">
            <div className="bg-surface-muted h-3 w-20 animate-pulse rounded" />
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
              <div className="bg-surface-muted h-3 w-36 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-20 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-20 animate-pulse rounded" />
              <div className="bg-surface-muted h-3 w-32 animate-pulse rounded" />
              <div className="bg-surface-muted ml-auto h-3 w-24 animate-pulse rounded" />
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

        <p className="sr-only">Loading reminder history…</p>
      </div>
    </main>
  );
}
