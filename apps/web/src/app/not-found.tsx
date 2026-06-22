import Link from "next/link";

import { Button } from "@/components/ui/button";

// Root not-found boundary — the app shipped none, so an unmatched route (or any
// `notFound()` not caught by a closer not-found.tsx) fell through to Next.js's
// unstyled default 404. DESIGN.md §"Voice and tone": state the fact, no apology,
// no decoration; links are verbs. A plain server component (no interactivity
// beyond the link), styled to the app container like the root error.tsx.
export default function NotFound(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-2xl space-y-4 px-8 py-16">
        <h1 className="text-text-primary text-xl font-semibold">Page not found.</h1>
        <p className="text-text-muted text-sm">The page you requested does not exist.</p>
        <div className="pt-2">
          <Button asChild>
            <Link href="/">Go to the dashboard</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
