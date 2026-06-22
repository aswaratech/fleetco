// Root loading skeleton — the first app-root `loading.tsx`. Rendered by
// Next.js's Suspense boundary while the Home dashboard's server-side
// loadDashboard() (six parallel reads) is in flight, so the transition into
// the dashboard is layout-stable. Mirrors the list pages' `animate-pulse`
// idiom (apps/web/src/app/vehicles/loading.tsx) shaped for the dashboard:
// a header placeholder, the Zone A card grid (the full-width headline plus
// five cards), and the Zone B quick-links strip.
//
// DESIGN.md §"Home dashboard" Data & states: "The surface ships a loading
// skeleton (the root loading.tsx, mirroring the list pages' animate-pulse
// blocks)."

const CARD_COUNT = 5;
const QUICK_LINK_COUNT = 9;

export default function Loading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh" aria-busy="true">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-2">
            <div className="bg-surface-muted h-8 w-40 animate-pulse rounded" aria-hidden="true" />
            <div className="bg-surface-muted h-4 w-72 animate-pulse rounded" aria-hidden="true" />
          </div>
          <div className="bg-surface-muted h-9 w-24 animate-pulse rounded" aria-hidden="true" />
        </header>

        {/* Zone A — the full-width compliance headline plus five cards. */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
          <div className="bg-surface-muted h-24 animate-pulse rounded lg:col-span-3" />
          {Array.from({ length: CARD_COUNT }).map((_, i) => (
            <div key={i} className="bg-surface-muted h-40 animate-pulse rounded" />
          ))}
        </div>

        {/* Zone B — the quick-links strip. */}
        <div className="flex flex-wrap gap-2" aria-hidden="true">
          {Array.from({ length: QUICK_LINK_COUNT }).map((_, i) => (
            <div key={i} className="bg-surface-muted h-8 w-24 animate-pulse rounded" />
          ))}
        </div>

        <p className="sr-only">Loading dashboard…</p>
      </div>
    </main>
  );
}
