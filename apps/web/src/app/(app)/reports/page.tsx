import Link from "next/link";
import { redirect } from "next/navigation";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { getServerSession } from "@/lib/session";

// /reports — the reports index. Until now /reports had no page (only the two
// leaf reports under it); this gives the Reports nav group a landing surface and
// a clean target for the ⌘K palette. A server component behind the auth gate
// (the (app) layout also gates; the per-page redirect stays per the T3
// decision). No API call — the two reports are a static list. The entries are
// navigable cards (the whole card is the link, no inner button — DESIGN.md
// anti-pattern #3).

const REPORTS: { href: string; title: string; description: string }[] = [
  {
    href: "/reports/per-vehicle-cost",
    title: "Cost report",
    description: "Per-vehicle fuel and expense spend over a date range.",
  },
  {
    href: "/reports/per-vehicle-efficiency",
    title: "Fuel efficiency",
    description: "km/L and NPR/km per vehicle, flagged against the prior period.",
  },
];

export default async function ReportsPage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <div className="space-y-1">
          <Breadcrumb items={[{ label: "FleetCo", href: "/" }, { label: "Reports" }]} />
          <h1 className="text-text-primary text-2xl font-semibold">Reports</h1>
          <p className="text-text-muted text-sm">
            Per-vehicle cost and efficiency over a date range.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {REPORTS.map((report) => (
            <Link
              key={report.href}
              href={report.href}
              className="border-border-subtle bg-surface-raised hover:bg-surface-muted focus-visible:outline-border-focus block rounded border p-4 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <span className="text-text-primary block text-lg font-semibold">{report.title}</span>
              <span className="text-text-muted mt-1 block text-sm">{report.description}</span>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}
