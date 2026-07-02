import { NotFoundException } from "@nestjs/common";
import { TripStatus } from "@prisma/client";
import { z } from "zod";

import { type TripsService } from "../../trips/trips.service";
import { ListTripsQuerySchema, type TripSortColumn } from "../../trips/trips.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Trips read tools (ADR-0043 c3 stage one). TripsService threads the Actor —
// so a DRIVER actor (were chat ever granted below ADMIN) inherits the D2
// own-record row-scope FOR FREE (c1: the capability ceiling and row scope are
// the human's). get_trip returns TripDetail, whose DETAIL_INCLUDE nests the
// FULL Driver row — the canonical case the registry's redaction pass exists
// for (dateOfBirth stripped, licenseNumber masked, nested one level down).

const TRIP_SORT = [
  "startedAt",
  "endedAt",
  "createdAt",
] as const satisfies readonly TripSortColumn[];

const ListTripsArgs = z
  .object({
    status: z.array(z.enum(TripStatus)).optional(),
    vehicleId: z.string().trim().min(1).optional(),
    driverId: z.string().trim().min(1).optional(),
    sortBy: z.enum(TRIP_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export function buildTripsTools(trips: TripsService): ToolDefinition[] {
  return [
    {
      name: "list_trips",
      description:
        "List trips with optional status/vehicleId/driverId filters, sorting, and " +
        "pagination (take ≤ 200). Odometer readings are integer kilometers; engine " +
        "hours integer tenths-of-an-hour; timestamps ISO.",
      capabilities: ["trips:*"],
      riskTier: "read",
      argsSchema: ListTripsArgs,
      async execute(args, actor) {
        const query = ListTripsQuerySchema.parse(toQueryShape(ListTripsArgs.parse(args)));
        return trips.list(query, actor);
      },
    },
    {
      name: "get_trip",
      description:
        "Fetch one trip by id, including its nested vehicle and driver, status, " +
        "start/end times (ISO), and odometer/engine-hour readings.",
      capabilities: ["trips:*"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args, actor) {
        const { id } = GetByIdArgs.parse(args);
        const trip = await trips.findById(id, actor);
        if (trip === null) {
          throw new NotFoundException(`Trip ${id} not found.`);
        }
        return trip;
      },
    },
  ];
}
