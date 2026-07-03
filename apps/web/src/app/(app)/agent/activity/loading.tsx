import { Skeleton } from "@/components/ui/skeleton";

// Loading skeleton for /agent/activity (DESIGN.md §"Agent activity"):
// header + three filter controls + seven-column pulse rows, mirroring the
// notification-logs skeleton shape.
export default function AgentActivityLoading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh" aria-busy="true">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-32" />
        </header>
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-9 w-56" />
        </div>
        <div className="border-border-subtle bg-surface-raised space-y-3 rounded border p-4 shadow-sm">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="flex gap-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-28" />
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
