"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

// Detail-page error boundary. Next.js renders this when the server
// component throws an unexpected error (auth and 404 paths are handled
// explicitly via redirect / notFound in page.tsx; this surface catches
// anything else — typically API connectivity failures). Iter 3 sets the
// precedent for the Vehicles slice.
//
// DESIGN.md §"Voice and tone": state the fact, no apology, no
// decoration. We give the user a Retry (reset) and a way back to the
// list.

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorBoundary({ error, reset }: ErrorProps): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-2xl space-y-4 px-8 py-16">
        <h1 className="text-text-primary text-xl font-semibold">Could not load vehicle.</h1>
        <p className="text-text-muted text-sm">
          The FleetCo API did not respond as expected. The page can be retried, or you can return to
          the vehicle list.
        </p>
        {error.digest ? (
          <p className="text-text-muted font-mono text-xs">Reference: {error.digest}</p>
        ) : null}
        <div className="flex items-center gap-2 pt-2">
          <Button onClick={reset}>Retry</Button>
          <Button asChild variant="ghost">
            <Link href="/vehicles">Back to vehicles</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
