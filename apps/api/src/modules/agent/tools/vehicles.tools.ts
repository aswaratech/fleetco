import { NotFoundException } from "@nestjs/common";
import { VehicleKind, VehicleStatus } from "@prisma/client";
import { z } from "zod";

import { type VehiclesService } from "../../vehicles/vehicles.service";
import { ListVehiclesQuerySchema, type VehicleSortColumn } from "../../vehicles/vehicles.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Vehicles read tools (ADR-0043 c3 stage one). The wrapper schema mirrors
// ListVehiclesQuerySchema's filter surface with TYPED values (arrays, real
// ints) — z.toJSONSchema-representable — and execute re-validates through the
// module's real schema via toQueryShape (c2). The sort whitelist is duplicated
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
  ];
}
