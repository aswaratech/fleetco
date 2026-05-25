import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, ApiError } from "@/lib/api";
import { getServerSession } from "@/lib/session";

// Vehicle list — first Phase 1 vertical slice. Server-rendered; reads
// the session cookie, redirects to /login if absent, and fetches the
// list from the API (apps/api owns the auth handler per ADR-0021).
//
// Columns per the iter-1 ticket: registration number, kind, make/model,
// year, status, current odometer (km). Empty state per DESIGN.md
// §Tables: state the fact, no apology, no decoration.

interface VehicleRow {
  id: string;
  registrationNumber: string;
  kind: string;
  make: string;
  model: string;
  year: number;
  status: string;
  odometerCurrentKm: number;
}

interface VehiclesListResponse {
  items: VehicleRow[];
  total: number;
  skip: number;
  take: number;
}

// Human labels for enums. The Prisma enum values are uppercase
// snake-case (e.g., `IN_MAINTENANCE`); the UI shows title case
// ("In maintenance"). Kept in the page rather than a separate i18n
// module for iter 1; promoted when a second surface needs the same
// mapping.
const KIND_LABELS: Record<string, string> = {
  TRUCK: "Truck",
  TIPPER: "Tipper",
  EXCAVATOR: "Excavator",
  LOADER: "Loader",
  GRADER: "Grader",
  OTHER: "Other",
};

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: "Active",
  IN_MAINTENANCE: "In maintenance",
  RETIRED: "Retired",
  SOLD: "Sold",
};

function formatKilometers(km: number): string {
  // DESIGN.md §Data display "Distance": Latin numerals, kilometers, one
  // decimal place. The DB stores integer kilometers; we render with the
  // same shape ("12.0 km") for consistency with future float-valued
  // distance fields.
  const formatter = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${formatter.format(km)} km`;
}

export default async function VehiclesPage() {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  let data: VehiclesListResponse;
  try {
    data = await apiFetch<VehiclesListResponse>("/api/v1/vehicles?skip=0&take=50");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex items-end justify-between gap-4">
          <div className="space-y-1">
            <nav aria-label="Breadcrumb" className="text-text-muted text-sm">
              <Link href="/" className="hover:text-text-primary">
                FleetCo
              </Link>
              <span aria-hidden="true"> › </span>
              <span className="text-text-secondary">Vehicles</span>
            </nav>
            <h1 className="text-text-primary text-2xl font-semibold">Vehicles</h1>
            <p className="text-text-muted text-sm">
              {data.total === 0 ? "No vehicles registered." : `${data.total} registered.`}
            </p>
          </div>
          {/* Primary action right-aligned per DESIGN.md §"Page header".
              `asChild` lets the Button render as a Next.js <Link>, which
              gets us client-side navigation without a wrapping <a>. */}
          <Button asChild>
            <Link href="/vehicles/new">New vehicle</Link>
          </Button>
        </header>

        <section className="border-border-subtle bg-surface-raised rounded border shadow-sm">
          {data.items.length === 0 ? (
            <div className="text-text-secondary p-8 text-sm">No vehicles registered.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Registration</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Make / Model</TableHead>
                  <TableHead className="text-right tabular-nums">Year</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right tabular-nums">Odometer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-mono text-text-primary">
                      {v.registrationNumber}
                    </TableCell>
                    <TableCell className="text-text-secondary">
                      {KIND_LABELS[v.kind] ?? v.kind}
                    </TableCell>
                    <TableCell className="text-text-primary">
                      {v.make} {v.model}
                    </TableCell>
                    <TableCell className="text-text-secondary text-right tabular-nums">
                      {v.year}
                    </TableCell>
                    <TableCell className="text-text-secondary">
                      {STATUS_LABELS[v.status] ?? v.status}
                    </TableCell>
                    <TableCell className="text-text-primary text-right tabular-nums">
                      {formatKilometers(v.odometerCurrentKm)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </main>
  );
}
