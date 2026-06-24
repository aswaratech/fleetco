"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

// Error boundary for /reports/per-vehicle-cost. DESIGN.md §Inputs "Loading and
// error states": a "use client" boundary with a Retry (reset()) and a fallback
// link back to the index. Voice (§"Voice and tone"): "Cannot reach the server."
// — state the fact, no apology. Mirrors the root error.tsx with report copy.
// The cost report previously shipped no error.tsx (an API failure bubbled to
// the root boundary).
interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorBoundary({ error, reset }: ErrorProps): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-2xl space-y-4 px-8 py-16">
        <h1 className="text-text-primary text-xl font-semibold">Cannot reach the server.</h1>
        <p className="text-text-muted text-sm">The per-vehicle cost report could not load.</p>
        {error.digest ? (
          <p className="text-text-muted font-mono text-xs">Reference: {error.digest}</p>
        ) : null}
        <div className="flex gap-2 pt-2">
          <Button onClick={reset}>Retry</Button>
          <Button asChild variant="outline">
            <Link href="/">Back to the dashboard</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
