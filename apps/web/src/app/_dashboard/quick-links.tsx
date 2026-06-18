import Link from "next/link";

import { Button } from "@/components/ui/button";

// Zone B — Quick links. DESIGN.md §"Home dashboard" Zone B: "The dashboard
// augments, never replaces, navigation." Every CRUD destination stays one click
// away as a compact link strip below the cards. This surface carries the app's
// primary navigation until the Navigation sidebar is built; removing a link
// would strand that screen. All destinations from the prior nav-only home are
// preserved (Cost report → /reports/per-vehicle-cost); Fuel efficiency
// (Reports v2) sits beside it.

interface QuickLink {
  href: string;
  label: string;
}

const QUICK_LINKS: QuickLink[] = [
  { href: "/vehicles", label: "Vehicles" },
  { href: "/drivers", label: "Drivers" },
  { href: "/trips", label: "Trips" },
  { href: "/customers", label: "Customers" },
  { href: "/jobs", label: "Jobs" },
  { href: "/invoices", label: "Invoices" },
  { href: "/fuel-logs", label: "Fuel logs" },
  { href: "/expense-logs", label: "Expense logs" },
  { href: "/geofences", label: "Geofences" },
  { href: "/service-schedules", label: "Service schedules" },
  { href: "/service-records", label: "Service history" },
  { href: "/reports/per-vehicle-cost", label: "Cost report" },
  { href: "/reports/per-vehicle-efficiency", label: "Fuel efficiency" },
  { href: "/notification-logs", label: "Reminder history" },
];

export function QuickLinks(): React.ReactElement {
  return (
    <section aria-labelledby="quick-links-heading" className="space-y-2">
      <h2
        id="quick-links-heading"
        className="text-text-muted text-xs font-medium tracking-wide uppercase"
      >
        Quick links
      </h2>
      <nav aria-label="Primary" className="flex flex-wrap gap-2">
        {QUICK_LINKS.map((link) => (
          <Button key={link.href} asChild variant="outline" size="sm">
            <Link href={link.href}>{link.label}</Link>
          </Button>
        ))}
      </nav>
    </section>
  );
}
