import { Skeleton } from "@/components/ui/skeleton";

// Loading skeleton for /chat (DESIGN.md §"Agent chat"): rail rows + a
// transcript-shaped column, mirroring the list pages' pulse blocks.
export default function ChatLoading(): React.ReactElement {
  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <header className="mb-6 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-40" />
        </header>
        <div className="flex flex-col gap-6 md:flex-row">
          <div className="w-full shrink-0 space-y-2 md:w-64">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <div className="flex justify-end">
              <Skeleton className="h-14 w-2/3" />
            </div>
            <Skeleton className="h-20 w-3/4" />
            <div className="flex justify-end">
              <Skeleton className="h-14 w-1/2" />
            </div>
            <Skeleton className="h-24 w-full" />
          </div>
        </div>
      </div>
    </main>
  );
}
