import { z } from "zod";

import { type FuelLogsService } from "../../fuel-logs/fuel-logs.service";
import { ListFuelLogsQuerySchema, type FuelLogSortColumn } from "../../fuel-logs/fuel-logs.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Fuel-log read tools (ADR-0043 c3 stage one). Actor-threaded (the DRIVER
// own-record scope inherited for free, c1). getById enforces the own-record
// scope itself and throws NotFound — propagated as-is.

const FUEL_LOG_SORT = ["date", "createdAt"] as const satisfies readonly FuelLogSortColumn[];

const ListFuelLogsArgs = z
  .object({
    vehicleId: z.string().trim().min(1).optional(),
    tripId: z.string().trim().min(1).optional(),
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    sortBy: z.enum(FUEL_LOG_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export function buildFuelLogsTools(fuelLogs: FuelLogsService): ToolDefinition[] {
  return [
    {
      name: "list_fuel_logs",
      description:
        "List fuel fills with optional vehicleId/tripId filters and an inclusive " +
        "startDate/endDate window (ISO YYYY-MM-DD), sorted (default: date desc), " +
        "paginated (take ≤ 200). Volumes are integer MILLILITERS (litersMl); money " +
        "is integer PAISA (pricePerLiterPaisa, totalCostPaisa; 1 NPR = 100 paisa).",
      capabilities: ["fuel-logs:*"],
      riskTier: "read",
      argsSchema: ListFuelLogsArgs,
      async execute(args, actor) {
        const query = ListFuelLogsQuerySchema.parse(toQueryShape(ListFuelLogsArgs.parse(args)));
        return fuelLogs.list(query, actor);
      },
    },
    {
      name: "get_fuel_log",
      description:
        "Fetch one fuel log by id, including its nested vehicle and (when paired) " +
        "trip. Volumes integer milliliters; money integer paisa.",
      capabilities: ["fuel-logs:*"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args, actor) {
        const { id } = GetByIdArgs.parse(args);
        return fuelLogs.getById(id, actor);
      },
    },
  ];
}
