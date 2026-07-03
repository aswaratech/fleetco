import { z } from "zod";

import { type FuelLogsService } from "../../fuel-logs/fuel-logs.service";
import {
  CreateFuelLogSchema,
  ListFuelLogsQuerySchema,
  type FuelLogSortColumn,
} from "../../fuel-logs/fuel-logs.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Fuel-log tools (ADR-0043 c3: A4 reads, A7 create). Actor-threaded (the
// DRIVER own-record scope inherited for free, c1): a DRIVER actor creating a
// fill must pair one of their OWN trips (service-enforced). getById enforces
// the own-record scope itself and throws NotFound — propagated as-is.
// totalCostPaisa is DERIVED server-side (mL × paisa/L ÷ 1000, half-up) — the
// create wrapper structurally cannot supply it.

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

// Mirrors CreateFuelLogSchema field-for-field (totalCostPaisa deliberately
// absent — server-derived). Id shapes stay loose here; the module's Cuid
// regex re-validates at execute.
const CreateFuelLogArgs = z
  .object({
    vehicleId: z.string().trim().min(1),
    tripId: z.string().trim().min(1).nullable().optional(),
    date: z.iso.date(),
    litersMl: z.number().int().min(1).max(1_000_000_000),
    pricePerLiterPaisa: z.number().int().min(1).max(10_000_000),
    odometerReadingKm: z.number().int().min(0).max(100_000_000).nullable().optional(),
    station: z.string().trim().min(1).max(256).nullable().optional(),
    receiptNumber: z.string().trim().min(1).max(64).nullable().optional(),
    notes: z.string().max(4096).nullable().optional(),
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
    {
      name: "create_fuel_log",
      description:
        "Record a fuel fill. Required: vehicleId (resolve with list_vehicles " +
        "first — never guess), date (ISO YYYY-MM-DD), litersMl (integer " +
        "MILLILITERS: 45.5 L = 45500), pricePerLiterPaisa (integer PAISA per " +
        "liter: Rs. 165.00 = 16500). totalCostPaisa is computed server-side — " +
        "do not supply it. Optional: tripId (must belong to the same vehicle), " +
        "odometerReadingKm, station, receiptNumber, notes. The write happens " +
        "immediately and exactly once; the result includes the new fuel log's id " +
        "and the derived total.",
      capabilities: ["fuel-logs:*"],
      riskTier: "reversible-write",
      resultEntityType: "FuelLog",
      argsSchema: CreateFuelLogArgs,
      async execute(args, actor) {
        const input = CreateFuelLogSchema.parse(CreateFuelLogArgs.parse(args));
        return fuelLogs.create(input, actor.userId, actor);
      },
    },
  ];
}
