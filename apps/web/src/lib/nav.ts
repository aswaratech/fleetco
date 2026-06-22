// The single source of truth for FleetCo's authenticated navigation IA.
//
// One list, consumed by every navigation surface so they cannot drift:
//   - the §Navigation sidebar (Phase 1 / T3, the (app) route-group shell);
//   - the home dashboard's quick-links strip (refactored to read from here in
//     T3, alongside the DESIGN.md §"Home dashboard" update that records the
//     sidebar superseding the strip as primary nav);
//   - the ⌘K command palette (T7).
// The locked visual contract is docs/design/slices/app-shell.html (it moves to
// _archive/ once the shell merges). The five-group IA below is PO-ratified.
//
// RBAC note — this is a UI affordance, NOT the security boundary. The API's
// capability map (apps/api/src/modules/auth/permissions.ts) is what actually
// authorizes a request; `allowedRoles` here only decides whether to render a
// link, and the server still returns 403 if someone navigates to a path their
// role cannot use. The web is admin-facing — DRIVER uses the separate Expo app
// and has no web surface — so today every item is ADMIN + OFFICE_STAFF; the
// field exists so the first ADMIN-only surface is a one-line change, not a
// refactor.

import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Building2,
  CalendarClock,
  ClipboardList,
  Fuel,
  Gauge,
  LayoutDashboard,
  MapPin,
  Receipt,
  Route,
  TrendingUp,
  Truck,
  TriangleAlert,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";

// The three roles the API issues (apps/api/src/modules/auth/permissions.ts).
export type Role = "ADMIN" | "OFFICE_STAFF" | "DRIVER";

export interface NavItem {
  /** App route, e.g. "/vehicles". Matches the path the page lives at. */
  href: string;
  /** Display label — the exact strings the quick-links strip uses today. */
  label: string;
  /** Lucide icon component, rendered at 20px / stroke 1.5 per §Iconography. */
  icon: LucideIcon;
  /** Roles for which the link renders. UI affordance only (see file header). */
  allowedRoles: readonly Role[];
}

export interface NavGroup {
  /** Stable id (used as a React key and the palette group key). */
  id: string;
  /** Section heading shown in the sidebar (title-case, not ALL-CAPS). */
  label: string;
  items: readonly NavItem[];
}

// Everything an office staffer needs daily is visible to both web roles.
const ADMIN_OFFICE: readonly Role[] = ["ADMIN", "OFFICE_STAFF"];

// The top-level destination, rendered above the groups in the sidebar (the
// daily-ops dashboard at /). Kept separate from NAV because it is ungrouped and
// the quick-links strip historically does not list it.
export const HOME: NavItem = {
  href: "/",
  label: "Home",
  icon: LayoutDashboard,
  allowedRoles: ADMIN_OFFICE,
};

// The five PO-ratified groups. Item order within a group is the sidebar's
// vertical order. The flattened set is exactly the 15 destinations the
// quick-links strip carries today (Geofences in Logs, the two reports their own
// group) — only the order is regrouped, a change T3 makes under the DESIGN.md
// §"Home dashboard" update.
export const NAV: readonly NavGroup[] = [
  {
    id: "operations",
    label: "Operations",
    items: [
      { href: "/vehicles", label: "Vehicles", icon: Truck, allowedRoles: ADMIN_OFFICE },
      { href: "/drivers", label: "Drivers", icon: Users, allowedRoles: ADMIN_OFFICE },
      { href: "/trips", label: "Trips", icon: Route, allowedRoles: ADMIN_OFFICE },
      { href: "/customers", label: "Customers", icon: Building2, allowedRoles: ADMIN_OFFICE },
      { href: "/jobs", label: "Jobs", icon: ClipboardList, allowedRoles: ADMIN_OFFICE },
    ],
  },
  {
    id: "money",
    label: "Money",
    items: [
      { href: "/invoices", label: "Invoices", icon: Receipt, allowedRoles: ADMIN_OFFICE },
      { href: "/fuel-logs", label: "Fuel logs", icon: Fuel, allowedRoles: ADMIN_OFFICE },
      { href: "/expense-logs", label: "Expense logs", icon: Wallet, allowedRoles: ADMIN_OFFICE },
    ],
  },
  {
    id: "maintenance",
    label: "Maintenance",
    items: [
      {
        href: "/service-schedules",
        label: "Service schedules",
        icon: CalendarClock,
        allowedRoles: ADMIN_OFFICE,
      },
      {
        href: "/service-schedules/due",
        label: "Services due",
        icon: TriangleAlert,
        allowedRoles: ADMIN_OFFICE,
      },
      {
        href: "/service-records",
        label: "Service history",
        icon: Wrench,
        allowedRoles: ADMIN_OFFICE,
      },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    items: [
      {
        href: "/reports/per-vehicle-cost",
        label: "Cost report",
        icon: TrendingUp,
        allowedRoles: ADMIN_OFFICE,
      },
      {
        href: "/reports/per-vehicle-efficiency",
        label: "Fuel efficiency",
        icon: Gauge,
        allowedRoles: ADMIN_OFFICE,
      },
    ],
  },
  {
    id: "logs",
    label: "Logs",
    items: [
      { href: "/geofences", label: "Geofences", icon: MapPin, allowedRoles: ADMIN_OFFICE },
      {
        href: "/notification-logs",
        label: "Reminder history",
        icon: Bell,
        allowedRoles: ADMIN_OFFICE,
      },
    ],
  },
];

/**
 * The groups a role may see, with items filtered to that role and any group
 * left empty dropped. Pure — never mutates NAV. The sidebar renders HOME (if
 * `HOME.allowedRoles` includes the role) followed by these groups; the
 * quick-links strip and the command palette flatten the result.
 *
 * Examples:
 *   navForRole("ADMIN")        → all 5 groups, all 15 items
 *   navForRole("OFFICE_STAFF") → all 5 groups, all 15 items (web is admin-facing)
 *   navForRole("DRIVER")       → [] (DRIVER has no web surface; uses the Expo app)
 */
export function navForRole(role: Role): NavGroup[] {
  return NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.allowedRoles.includes(role)),
  })).filter((group) => group.items.length > 0);
}

/**
 * The role's visible items as a flat list, HOME first when allowed. The shape
 * the quick-links strip and the ⌘K palette consume (the palette regroups via
 * `navForRole`; this is the convenience flattening for the strip).
 */
export function navItemsForRole(role: Role): NavItem[] {
  const items = navForRole(role).flatMap((group) => group.items);
  return HOME.allowedRoles.includes(role) ? [HOME, ...items] : items;
}
