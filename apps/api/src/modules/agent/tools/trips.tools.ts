import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TripStatus } from "@prisma/client";
import { z } from "zod";

import { type TripsService } from "../../trips/trips.service";
import {
  CreateTripSchema,
  ListTripsQuerySchema,
  UpdateTripSchema,
  type TripSortColumn,
} from "../../trips/trips.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Trips tools (ADR-0043 c3: A4 reads, A7 create). TripsService threads the
// Actor — so a DRIVER actor (were chat ever granted below ADMIN) inherits the
// D2 own-record row-scope FOR FREE (c1: the capability ceiling and row scope
// are the human's); on the CREATE path the service additionally rejects
// DRIVER actors outright (drivers do not create trips — a service-level 403
// the loop records as a `denied` action). get_trip returns TripDetail, whose
// DETAIL_INCLUDE nests the FULL Driver row — the canonical case the
// registry's redaction pass exists for (dateOfBirth stripped, licenseNumber
// masked, nested one level down).

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

// Mirrors CreateTripSchema field-for-field, minus its superRefine (the
// meter-agnostic timing/end-≥-start rules re-validate module-side at
// execute; the meter-AWARE required-readings rule runs in the service,
// which knows the vehicle's meterType). Timestamps are full ISO 8601
// datetimes — the module schema keeps them as strings (z.iso.datetime),
// so the wrapper mirrors exactly.
const CreateTripArgs = z
  .object({
    vehicleId: z.string().min(1),
    driverId: z.string().min(1),
    status: z.enum(TripStatus),
    startedAt: z.iso.datetime({ offset: true, local: true }).nullable().optional(),
    endedAt: z.iso.datetime({ offset: true, local: true }).nullable().optional(),
    startOdometerKm: z.number().int().min(0).max(9_999_999).nullable().optional(),
    endOdometerKm: z.number().int().min(0).max(9_999_999).nullable().optional(),
    startEngineHours: z.number().int().min(0).max(10_000_000).nullable().optional(),
    endEngineHours: z.number().int().min(0).max(10_000_000).nullable().optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict();

// Mirrors UpdateTripSchema field-for-field plus the wrapper-only `id`:
// vehicleId/driverId are MUTABLE (reassignment) but never null; timestamps
// and meter readings are clearable via explicit null; notes is NOT nullable
// (the module contract — clear it by sending ""). UpdateTripSchema has no
// empty-patch refine (the service merges then re-validates), so the tool's
// execute guards id-only calls itself.
const UpdateTripArgs = z
  .object({
    id: z.string().trim().min(1),
    vehicleId: z.string().min(1).optional(),
    driverId: z.string().min(1).optional(),
    status: z.enum(TripStatus).optional(),
    startedAt: z.iso.datetime({ offset: true, local: true }).nullable().optional(),
    endedAt: z.iso.datetime({ offset: true, local: true }).nullable().optional(),
    startOdometerKm: z.number().int().min(0).max(9_999_999).nullable().optional(),
    endOdometerKm: z.number().int().min(0).max(9_999_999).nullable().optional(),
    startEngineHours: z.number().int().min(0).max(10_000_000).nullable().optional(),
    endEngineHours: z.number().int().min(0).max(10_000_000).nullable().optional(),
    notes: z.string().max(1000).optional(),
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
    {
      name: "create_trip",
      description:
        "Create a trip. Required: vehicleId and driverId (resolve both with the " +
        "list tools first — never guess), and status (PLANNED, IN_PROGRESS, " +
        "COMPLETED, or CANCELLED — pick the real lifecycle stage). Timing " +
        "(startedAt/endedAt) are full ISO 8601 datetimes; readings are integer " +
        "kilometers / integer tenths-of-an-hour — which readings IN_PROGRESS/" +
        "COMPLETED require depends on the vehicle's meterType (get_vehicle shows " +
        "it). A COMPLETED trip updates the vehicle's meter automatically. The " +
        "write happens immediately and exactly once; the result includes the new " +
        "trip's id.",
      capabilities: ["trips:*"],
      riskTier: "reversible-write",
      resultEntityType: "Trip",
      argsSchema: CreateTripArgs,
      async execute(args, actor) {
        const input = CreateTripSchema.parse(CreateTripArgs.parse(args));
        return trips.create(input, actor.userId, actor);
      },
    },
    {
      name: "update_trip",
      description:
        "Update fields on an existing trip (partial update — send only what " +
        "changes; the prior row is captured for undo). Status transitions are " +
        "enforced: PLANNED → IN_PROGRESS → COMPLETED, CANCELLED from any " +
        "non-terminal state; COMPLETED and CANCELLED are final. Completing a " +
        "trip updates the vehicle's meter automatically. vehicleId/driverId " +
        "REASSIGN the trip — omit them unless reassignment is intended. " +
        "Explicit null clears timing/meter readings; clear notes by sending an " +
        "empty string. The write happens immediately and exactly once.",
      capabilities: ["trips:*"],
      riskTier: "reversible-write",
      resultEntityType: "Trip",
      argsSchema: UpdateTripArgs,
      async capturePreImage(args) {
        // The RAW row (no nested relations) — the faithful undo source.
        const { id } = UpdateTripArgs.parse(args);
        return trips.findByIdRaw(id);
      },
      async execute(args, actor) {
        const { id, ...patch } = UpdateTripArgs.parse(args);
        // UpdateTripSchema carries no empty-body refine (the service
        // re-validates the MERGED shape instead), so guard id-only calls
        // here — a no-op "update" must not mint a succeeded audit row.
        if (Object.keys(patch).length === 0) {
          throw new BadRequestException("At least one field besides id is required.");
        }
        const input = UpdateTripSchema.parse(patch);
        return trips.update(id, input, actor);
      },
    },
  ];
}
