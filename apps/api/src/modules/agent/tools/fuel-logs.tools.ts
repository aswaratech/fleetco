import { z } from "zod";

import { type FuelLogsService } from "../../fuel-logs/fuel-logs.service";
import {
  CreateFuelLogSchema,
  ListFuelLogsQuerySchema,
  UpdateFuelLogSchema,
  type FuelLogSortColumn,
} from "../../fuel-logs/fuel-logs.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Fuel-log tools (ADR-0043 c3: A4 reads, A7 create; ADR-0044 P2 update).
// Actor-threaded (the DRIVER own-record scope inherited for free, c1): a
// DRIVER actor creating a fill must pair one of their OWN trips, and updating
// a foreign row 404s (service-enforced). getById enforces the own-record
// scope itself and throws NotFound — propagated as-is. totalCostPaisa is
// DERIVED server-side (mL × paisa/L ÷ 1000, half-up) — the write wrappers
// structurally cannot supply it, and update recomputes it whenever litersMl
// or pricePerLiterPaisa changes.

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

// Mirrors UpdateFuelLogSchema field-for-field plus the wrapper-only `id` —
// vehicleId is structurally absent (immutable on a fill; the module schema's
// .strict() rejects it too) and totalCostPaisa stays server-derived. Explicit
// null CLEARS tripId, odometerReadingKm, station, receiptNumber, or notes.
// The module schema's empty-patch refine re-validates at execute.
const UpdateFuelLogArgs = z
  .object({
    id: z.string().trim().min(1),
    tripId: z.string().trim().min(1).nullable().optional(),
    date: z.iso.date().optional(),
    litersMl: z.number().int().min(1).max(1_000_000_000).optional(),
    pricePerLiterPaisa: z.number().int().min(1).max(10_000_000).optional(),
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
    {
      name: "update_fuel_log",
      description:
        "Update fields on an existing fuel fill (partial update — send only what " +
        "changes; the prior row is captured for undo). vehicleId cannot be " +
        "changed; totalCostPaisa is recomputed server-side when litersMl or " +
        "pricePerLiterPaisa changes. Explicit null CLEARS tripId, " +
        "odometerReadingKm, station, receiptNumber, or notes; a non-null tripId " +
        "must belong to the fill's vehicle. Units: integer milliliters, integer " +
        "paisa, ISO YYYY-MM-DD. The write happens immediately and exactly once.",
      capabilities: ["fuel-logs:*"],
      riskTier: "reversible-write",
      resultEntityType: "FuelLog",
      argsSchema: UpdateFuelLogArgs,
      async capturePreImage(args) {
        // The RAW row (no nested vehicle/trip) — the faithful undo source.
        const { id } = UpdateFuelLogArgs.parse(args);
        return fuelLogs.findByIdRaw(id);
      },
      async execute(args, actor) {
        const { id, ...patch } = UpdateFuelLogArgs.parse(args);
        const input = UpdateFuelLogSchema.parse(patch);
        return fuelLogs.update(id, input, actor);
      },
    },
  ];
}
