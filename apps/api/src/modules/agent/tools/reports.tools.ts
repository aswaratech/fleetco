import { z } from "zod";

import { type ReportsService } from "../../reports/reports.service";
import { ReportsQuerySchema } from "../../reports/reports.schemas";
import { type ToolDefinition } from "./tool.types";

// Report tools (ADR-0043 c3 stage one): the two ReportsService reports. The
// wrapper's output — from/to as ISO YYYY-MM-DD strings, optional vehicleId —
// IS ReportsQuerySchema's input shape, so execute parses the module schema
// DIRECTLY (no toQueryShape hop) and inherits its from ≤ to cross-field
// refine for free (c2's re-validation, in its purest form).

const ReportArgs = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    vehicleId: z.string().trim().min(1).optional(),
  })
  .strict();

export function buildReportsTools(reports: ReportsService): ToolDefinition[] {
  return [
    {
      name: "report_per_vehicle_cost",
      description:
        "Per-vehicle cost report over an inclusive from/to window (ISO YYYY-MM-DD): " +
        "fuel + expense totals per vehicle (integer paisa; 1 NPR = 100 paisa), " +
        "grand totals, and a company-level block for vehicle-agnostic expenses. " +
        "Only vehicles with activity in the window appear.",
      capabilities: ["reports:read"],
      riskTier: "read",
      argsSchema: ReportArgs,
      async execute(args) {
        const query = ReportsQuerySchema.parse(ReportArgs.parse(args));
        return reports.getPerVehicleCost(query);
      },
    },
    {
      name: "report_per_vehicle_efficiency",
      description:
        "Per-vehicle efficiency report over an inclusive from/to window (ISO " +
        "YYYY-MM-DD): distance (km), fuel volume (integer milliliters), km-per-litre, " +
        "NPR-per-km (from integer paisa), and a data-quality flag per vehicle.",
      capabilities: ["reports:read"],
      riskTier: "read",
      argsSchema: ReportArgs,
      async execute(args) {
        const query = ReportsQuerySchema.parse(ReportArgs.parse(args));
        return reports.getPerVehicleEfficiency(query);
      },
    },
  ];
}
