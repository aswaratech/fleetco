import { complianceBadgeState } from "@fleetco/shared";
import { z } from "zod";

import { type Actor } from "../../auth/driver-scope.service";
import { type DriversService } from "../../drivers/drivers.service";
import { type ExpenseLogsService } from "../../expense-logs/expense-logs.service";
import { type FuelLogsService } from "../../fuel-logs/fuel-logs.service";
import { type ReportsService } from "../../reports/reports.service";
import { type ServiceSchedulesService } from "../../maintenance/service-schedules.service";
import { type TripsService } from "../../trips/trips.service";
import { type VehiclesService } from "../../vehicles/vehicles.service";
import { ListDriversQuerySchema } from "../../drivers/drivers.schemas";
import { ListExpenseLogsQuerySchema } from "../../expense-logs/expense-logs.schemas";
import { ListFuelLogsQuerySchema } from "../../fuel-logs/fuel-logs.schemas";
import { ListServiceSchedulesQuerySchema } from "../../maintenance/service-schedules.schemas";
import { ListTripsQuerySchema } from "../../trips/trips.schemas";
import { ListVehiclesQuerySchema } from "../../vehicles/vehicles.schemas";
import { ReportsQuerySchema } from "../../reports/reports.schemas";
import { toQueryShape } from "./query-shape";
import { type ToolDefinition } from "./tool.types";

// The fleet_snapshot tool (ADR-0043 c3): the Home dashboard's seven parallel
// reads, re-composed IN-PROCESS from the same services the dashboard's
// endpoints serve (there is no dashboard endpoint by design — DESIGN.md
// §Surfaces: "the cards compose existing read endpoints"; this tool mirrors
// apps/web/src/lib/dashboard.ts's loadDashboard() call-for-call). Each
// composed query still round-trips the owning module's real schema (c2) —
// costs nothing, and turns a future schema tightening into a loud test
// failure instead of a silent drift.
//
// DELIBERATE DIVERGENCE from the web dashboard, documented: the web's
// services-due roll-up runs the shared serviceScheduleState machine per
// schedule (km/hours/days windows against each vehicle's meters). The
// snapshot reports only the ACTIVE-schedule count and points the model at
// list_service_schedules + get_vehicle for due/overdue reasoning — porting
// the state machine here would duplicate real logic for a summary number the
// model can derive better by asking. The compliance tally, by contrast, IS
// composed here, because its classifier (complianceBadgeState) already lives
// in @fleetco/shared (the NotificationModule precedent) — worst-of-three
// expiries per vehicle, 30-day window, no logic duplicated.

/** The slice of a Vehicle row the compliance tally reads. */
export interface VehicleComplianceSlice {
  bluebookExpiresAt: Date | null;
  insuranceExpiresAt: Date | null;
  routePermitExpiresAt: Date | null;
}

export interface ComplianceTally {
  /** Vehicles whose worst compliance document is expired. */
  expiredCount: number;
  /** Vehicles whose worst compliance document expires within 30 days. */
  expiringSoonCount: number;
  /** Vehicles scanned (bounded by the take=200 ceiling, like the web). */
  total: number;
}

/**
 * Worst-of-three-documents compliance tally over the shared classifier
 * (ADR-0031's complianceBadgeState — the same helper the web badges and the
 * reminder scan use, so the three surfaces cannot drift). Pure; exported for
 * the unit test.
 */
export function tallyCompliance(
  vehicles: readonly VehicleComplianceSlice[],
  now: Date,
): ComplianceTally {
  let expiredCount = 0;
  let expiringSoonCount = 0;
  for (const vehicle of vehicles) {
    const states = [
      complianceBadgeState(vehicle.bluebookExpiresAt?.toISOString(), now),
      complianceBadgeState(vehicle.insuranceExpiresAt?.toISOString(), now),
      complianceBadgeState(vehicle.routePermitExpiresAt?.toISOString(), now),
    ];
    if (states.includes("expired")) expiredCount += 1;
    else if (states.includes("expiring-soon")) expiringSoonCount += 1;
  }
  return { expiredCount, expiringSoonCount, total: vehicles.length };
}

/**
 * The current-calendar-month report window, UTC (ported from
 * apps/web/src/lib/dashboard.ts — first of the month through today, as the
 * YYYY-MM-DD strings ReportsQuerySchema takes). Pure; exported for the test.
 */
export function currentMonthRange(now: Date): { from: string; to: string } {
  const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from: formatUtcDay(firstOfMonth), to: formatUtcDay(now) };
}

function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface FleetSnapshotDeps {
  vehicles: VehiclesService;
  drivers: DriversService;
  trips: TripsService;
  fuelLogs: FuelLogsService;
  expenseLogs: ExpenseLogsService;
  reports: ReportsService;
  serviceSchedules: ServiceSchedulesService;
}

const FleetSnapshotArgs = z.object({}).strict();

export function buildFleetSnapshotTool(deps: FleetSnapshotDeps): ToolDefinition {
  return {
    name: "fleet_snapshot",
    description:
      "The fleet-overview snapshot (the Home dashboard's reads, composed): vehicle/" +
      "driver counts, in-progress trips (top 5 + total), this calendar " +
      "month's cost totals (integer paisa), the 5 most recent fuel and expense " +
      "logs, a vehicle-compliance tally (expired / expiring within 30 days), and " +
      "the active service-schedule count. Call this first for any 'how is the " +
      "fleet doing' question; drill into list/report tools for detail.",
    capabilities: [
      "vehicles:*",
      "drivers:*",
      "trips:*",
      "fuel-logs:*",
      "expense-logs:*",
      "reports:read",
      "maintenance:*",
    ],
    riskTier: "read",
    argsSchema: FleetSnapshotArgs,
    async execute(args, actor: Actor) {
      FleetSnapshotArgs.parse(args);
      const now = new Date();
      const window = currentMonthRange(now);
      const [
        vehiclesPage,
        activeTrips,
        monthCost,
        recentFuel,
        recentExpenses,
        driversPage,
        activeSchedules,
      ] = await Promise.all([
        deps.vehicles.list(ListVehiclesQuerySchema.parse(toQueryShape({ take: 200 }))),
        deps.trips.list(
          ListTripsQuerySchema.parse(
            toQueryShape({
              status: ["IN_PROGRESS"],
              take: 5,
              sortBy: "startedAt",
              sortDir: "desc",
            }),
          ),
          actor,
        ),
        deps.reports.getPerVehicleCost(ReportsQuerySchema.parse(window)),
        deps.fuelLogs.list(
          ListFuelLogsQuerySchema.parse(toQueryShape({ take: 5, sortBy: "date", sortDir: "desc" })),
          actor,
        ),
        deps.expenseLogs.list(
          ListExpenseLogsQuerySchema.parse(
            toQueryShape({ take: 5, sortBy: "date", sortDir: "desc" }),
          ),
        ),
        deps.drivers.list(ListDriversQuerySchema.parse(toQueryShape({ take: 1 }))),
        deps.serviceSchedules.list(
          ListServiceSchedulesQuerySchema.parse(
            toQueryShape({ status: ["ACTIVE"], take: 1, sortBy: "name", sortDir: "asc" }),
          ),
        ),
      ]);

      return {
        counts: {
          vehicles: vehiclesPage.total,
          drivers: driversPage.total,
          activeTrips: activeTrips.total,
        },
        // The vehicle ROWS never cross into model context — only the tally
        // (the same never-ship-the-scan-rows discipline as the web card).
        compliance: tallyCompliance(vehiclesPage.items, now),
        activeTrips: { items: activeTrips.items, total: activeTrips.total },
        thisMonthCost: {
          from: window.from,
          to: window.to,
          totals: monthCost.totals,
          companyLevel: monthCost.companyLevel,
        },
        recentFuel: recentFuel.items,
        recentExpenses: recentExpenses.items,
        maintenance: { activeScheduleCount: activeSchedules.total },
      };
    },
  };
}
