"use client";

import { Button } from "@/components/ui/button";

// Root error boundary — the first app-root `error.tsx`. Next.js renders this
// when the Home dashboard's server component throws an unexpected error (the
// auth path is handled explicitly via redirect in page.tsx; this catches
// anything else — typically the FleetCo API being unreachable). Mirrors the
// detail-page error boundaries (apps/web/src/app/vehicles/[id]/error.tsx) with
// the dashboard's copy.
//
// DESIGN.md §"Voice and tone" network-error line: "Cannot reach the server.
// Retry." — state the fact, no apology, no decoration. The Retry button calls
// reset() to re-attempt the failed render.

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorBoundary({ error, reset }: ErrorProps): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-2xl space-y-4 px-8 py-16">
        <h1 className="text-text-primary text-xl font-semibold">Cannot reach the server.</h1>
        <p className="text-text-muted text-sm">The dashboard could not load.</p>
        {error.digest ? (
          <p className="text-text-muted font-mono text-xs">Reference: {error.digest}</p>
        ) : null}
        <div className="pt-2">
          <Button onClick={reset}>Retry</Button>
        </div>
      </div>
    </main>
  );
}
