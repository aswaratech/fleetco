import { redirect } from "next/navigation";

import { NepaliDate } from "@/components/nepali-date";
import { ApiError } from "@/lib/api";
import { loadDashboard, type DashboardData } from "@/lib/dashboard";
import { getServerSession } from "@/lib/session";

import { ActiveTripsCard } from "./_dashboard/active-trips-card";
import { ComplianceCard } from "./_dashboard/compliance-card";
import { FleetCountsCard } from "./_dashboard/fleet-counts-card";
import { QuickLinks } from "./_dashboard/quick-links";
import { RecentExpensesCard } from "./_dashboard/recent-expenses-card";
import { RecentFuelCard } from "./_dashboard/recent-fuel-card";
import { ThisMonthCostCard } from "./_dashboard/this-month-cost-card";
import { SignOutButton } from "./sign-out-button";

// Home daily-ops dashboard — D2 of the Home-dashboard program (the program's
// last ticket). Replaces the placeholder navigation-only home with the
// daily-ops overview specified in DESIGN.md §"Surfaces" → "Home dashboard". It
// is the operator's instrument panel: what to see and act on first, composed
// entirely from existing operational data (no dashboard-specific backend).
//
// Server component behind the auth gate. The shape mirrors every Phase-1 list
// page (apps/web/src/app/vehicles/page.tsx):
//
//   1. getServerSession() → redirect("/login") for the unauthenticated path.
//   2. loadDashboard() (D1's data layer) inside a try/catch that maps an
//      ApiError 401 → redirect("/login") and rethrows anything else. The
//      redirect()'s internal throw must NOT be swallowed, so it is called
//      from the catch body, never wrapped in a second try.
//
// Zone A is the six overview cards (the compliance headline spans full width);
// Zone B is the quick-links strip that preserves all nine CRUD destinations —
// the dashboard augments navigation until the sidebar is built, it never
// replaces it. Every empty/zero state follows the §Voice register: state the
// fact, no exclamation, no apology. The loading skeleton (loading.tsx) and the
// error boundary (error.tsx) round out the surface's states.

export default async function HomePage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) {
    redirect("/login");
  }

  let data: DashboardData;
  try {
    data = await loadDashboard();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  // Today's instant, rendered BS + Gregorian in the header subline. This page
  // is dynamic (it reads the session cookie), so the server component renders
  // per request and `new Date()` is the request time.
  const todayIso = new Date().toISOString();

  return (
    <main className="bg-surface-canvas min-h-svh">
      <div className="mx-auto max-w-6xl space-y-6 px-8 py-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-text-primary text-2xl font-semibold">FleetCo</h1>
            <p className="text-text-muted text-sm">
              <NepaliDate iso={todayIso} format="both" /> · Signed in as{" "}
              <span className="text-text-primary">{session.user.email}</span>
            </p>
          </div>
          <SignOutButton />
        </header>

        <section aria-label="Fleet overview" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <ComplianceCard compliance={data.compliance} />
          <ActiveTripsCard activeTrips={data.activeTrips} />
          <ThisMonthCostCard cost={data.thisMonthCost} />
          <RecentFuelCard items={data.recentFuel} />
          <RecentExpensesCard items={data.recentExpenses} />
          <FleetCountsCard counts={data.counts} />
        </section>

        <QuickLinks />
      </div>
    </main>
  );
}
