"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

// Edit-page error boundary. Auth and 404 paths are handled explicitly
// in page.tsx (redirect / notFound); this surface catches anything else
// — typically API connectivity failures while loading the vehicle to
// pre-fill. The PATCH-submit error path is handled inline in the form
// itself (apps/web/src/app/vehicles/[id]/edit/edit-vehicle-form.tsx).

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorBoundary({ error, reset }: ErrorProps): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-2xl space-y-4 px-8 py-16">
        <h1 className="text-text-primary text-xl font-semibold">Could not load the edit form.</h1>
        <p className="text-text-muted text-sm">
          The FleetCo API did not return the vehicle. Retry, or return to the vehicle list.
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
