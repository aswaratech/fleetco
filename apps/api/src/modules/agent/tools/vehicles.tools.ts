import { NotFoundException } from "@nestjs/common";
import { InsuranceType, MeterType, VehicleKind, VehicleStatus } from "@prisma/client";
import { z } from "zod";

import { type VehiclesService } from "../../vehicles/vehicles.service";
import {
  CreateVehicleSchema,
  ListVehiclesQuerySchema,
  UpdateVehicleSchema,
  type VehicleSortColumn,
} from "../../vehicles/vehicles.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Vehicles tools (ADR-0043 c3: A4 reads, A7 create). The wrapper schemas
// mirror the module schemas' surfaces with TYPED, transform-free values —
// z.toJSONSchema-representable — and execute re-validates through the
// module's real schema (c2): toQueryShape bridges list filters; the create
// wrapper re-parses through CreateVehicleSchema verbatim (its z.coerce.date
// fields accept the wrapper's ISO strings). Wrappers teach SHAPE (types,
// enums, bounds); content rules the module owns (regexes, dynamic year
// ceiling, cross-field refines) re-validate at execute and surface as the
// house 400 the model can read and correct. The sort whitelist is duplicated
// from vehicles.schemas.ts and pinned by `satisfies`, so a module rename is a
// compile error here.

const VEHICLE_SORT = [
  "registrationNumber",
  "odometerCurrentKm",
  "acquiredAt",
  "createdAt",
] as const satisfies readonly VehicleSortColumn[];

const ListVehiclesArgs = z
  .object({
    status: z.array(z.enum(VehicleStatus)).optional(),
    kind: z.array(z.enum(VehicleKind)).optional(),
    sortBy: z.enum(VEHICLE_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

// Mirrors CreateVehicleSchema field-for-field (incl. nullability — explicit
// null ≡ absent in every service create, so accepting it is model-friction
// relief, not a semantic change).
const CreateVehicleArgs = z
  .object({
    registrationNumber: z.string().trim().min(1).max(64),
    kind: z.enum(VehicleKind),
    make: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1).max(64),
    year: z.number().int().min(1980),
    status: z.enum(VehicleStatus).optional(),
    odometerStartKm: z.number().int().min(0).max(10_000_000).optional(),
    odometerCurrentKm: z.number().int().min(0).max(10_000_000).optional(),
    meterType: z.enum(MeterType).optional(),
    engineHoursStart: z.number().int().min(0).max(10_000_000).nullable().optional(),
    engineHoursCurrent: z.number().int().min(0).max(10_000_000).nullable().optional(),
    acquiredAt: z.iso.date(),
    bluebookNumber: z.string().trim().min(1).max(64).optional(),
    bluebookExpiresAt: z.iso.date().nullable().optional(),
    insurer: z.string().trim().min(1).max(64).optional(),
    insurancePolicyNumber: z.string().trim().min(1).max(64).optional(),
    insuranceType: z.enum(InsuranceType).optional(),
    insuranceExpiresAt: z.iso.date().nullable().optional(),
    routePermitNumber: z.string().trim().min(1).max(64).optional(),
    routePermitExpiresAt: z.iso.date().nullable().optional(),
  })
  .strict();

// Mirrors UpdateVehicleSchema field-for-field plus the wrapper-only `id`.
// Explicit null CLEARS a clearable field (engine hours, retiredAt, the
// compliance strings/dates/type); meterType is reclassified, never cleared.
// The module schema's empty-patch refine re-validates at execute.
const UpdateVehicleArgs = z
  .object({
    id: z.string().trim().min(1),
    registrationNumber: z.string().trim().min(1).max(64).optional(),
    kind: z.enum(VehicleKind).optional(),
    make: z.string().trim().min(1).max(64).optional(),
    model: z.string().trim().min(1).max(64).optional(),
    year: z.number().int().min(1980).optional(),
    status: z.enum(VehicleStatus).optional(),
    odometerStartKm: z.number().int().min(0).max(10_000_000).optional(),
    odometerCurrentKm: z.number().int().min(0).max(10_000_000).optional(),
    meterType: z.enum(MeterType).optional(),
    engineHoursStart: z.number().int().min(0).max(10_000_000).nullable().optional(),
    engineHoursCurrent: z.number().int().min(0).max(10_000_000).nullable().optional(),
    acquiredAt: z.iso.date().optional(),
    retiredAt: z.iso.date().nullable().optional(),
    bluebookNumber: z.string().trim().min(1).max(64).nullable().optional(),
    bluebookExpiresAt: z.iso.date().nullable().optional(),
    insurer: z.string().trim().min(1).max(64).nullable().optional(),
    insurancePolicyNumber: z.string().trim().min(1).max(64).nullable().optional(),
    insuranceType: z.enum(InsuranceType).nullable().optional(),
    insuranceExpiresAt: z.iso.date().nullable().optional(),
    routePermitNumber: z.string().trim().min(1).max(64).nullable().optional(),
    routePermitExpiresAt: z.iso.date().nullable().optional(),
  })
  .strict();

export function buildVehiclesTools(vehicles: VehiclesService): ToolDefinition[] {
  return [
    {
      name: "list_vehicles",
      description:
        "List fleet vehicles (trucks, tippers, equipment) with optional status/kind " +
        "filters, sorting, and pagination (take ≤ 200; the response carries items " +
        "plus the un-paginated total). Odometers are integer kilometers; engine " +
        "hours are integer tenths-of-an-hour; dates are ISO.",
      capabilities: ["vehicles:*"],
      riskTier: "read",
      argsSchema: ListVehiclesArgs,
      async execute(args) {
        const query = ListVehiclesQuerySchema.parse(toQueryShape(ListVehiclesArgs.parse(args)));
        return vehicles.list(query);
      },
    },
    {
      name: "get_vehicle",
      description:
        "Fetch one vehicle by its id, including compliance metadata (bluebook / " +
        "insurance / route-permit numbers and ISO expiry dates) and meter readings.",
      capabilities: ["vehicles:*"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args) {
        const { id } = GetByIdArgs.parse(args);
        const vehicle = await vehicles.getById(id);
        if (vehicle === null) {
          throw new NotFoundException(`Vehicle ${id} not found.`);
        }
        return vehicle;
      },
    },
    {
      name: "create_vehicle",
      description:
        "Register a new fleet vehicle. Required: registrationNumber (unique — a " +
        "duplicate fails with a conflict), kind, make, model, year, acquiredAt " +
        "(ISO YYYY-MM-DD). Odometers are integer kilometers; engine hours integer " +
        "tenths-of-an-hour. Compliance fields (bluebook / insurance / route permit " +
        "numbers and ISO expiry dates) are optional. The write happens immediately " +
        "and exactly once; the result includes the new vehicle's id.",
      capabilities: ["vehicles:*"],
      riskTier: "reversible-write",
      resultEntityType: "Vehicle",
      argsSchema: CreateVehicleArgs,
      async execute(args, actor) {
        const input = CreateVehicleSchema.parse(CreateVehicleArgs.parse(args));
        return vehicles.create(input, actor.userId);
      },
    },
    {
      name: "update_vehicle",
      description:
        "Update fields on an existing vehicle (partial update — send only what " +
        "changes; the prior row is captured for undo). Explicit null CLEARS a " +
        "clearable field (engine hours, retiredAt, compliance fields). Setting " +
        "status to RETIRED or SOLD stamps retiredAt automatically. " +
        "registrationNumber stays unique (a duplicate fails with a conflict). " +
        "Units: integer km, integer tenths-of-an-hour, ISO YYYY-MM-DD dates. " +
        "The write happens immediately and exactly once.",
      capabilities: ["vehicles:*"],
      riskTier: "reversible-write",
      resultEntityType: "Vehicle",
      argsSchema: UpdateVehicleArgs,
      async capturePreImage(args) {
        const { id } = UpdateVehicleArgs.parse(args);
        return vehicles.getById(id);
      },
      async execute(args) {
        const { id, ...patch } = UpdateVehicleArgs.parse(args);
        const input = UpdateVehicleSchema.parse(patch);
        const updated = await vehicles.update(id, input);
        if (updated === null) {
          throw new NotFoundException(`Vehicle ${id} not found.`);
        }
        return updated;
      },
    },
  ];
}
