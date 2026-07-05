import { NotFoundException } from "@nestjs/common";
import { ServiceScheduleStatus } from "@prisma/client";
import { z } from "zod";

import { type ServiceRecordsService } from "../../maintenance/service-records.service";
import { type ServiceSchedulesService } from "../../maintenance/service-schedules.service";
import {
  CreateServiceRecordSchema,
  ListServiceRecordsQuerySchema,
  UpdateServiceRecordSchema,
  type ServiceRecordSortColumn,
} from "../../maintenance/service-records.schemas";
import {
  ListServiceSchedulesQuerySchema,
  type ServiceScheduleSortColumn,
} from "../../maintenance/service-schedules.schemas";
import { toQueryShape } from "./query-shape";
import { GetByIdArgs, type ToolDefinition } from "./tool.types";

// Maintenance tools (ADR-0043 c3: A4 reads, A7 create; ADR-0044 P2 update):
// the two aggregates the MaintenanceModule exports. Interval semantics ride
// the descriptions so the model reasons in the right units (ADR-0037's
// integer-minor-units rule). The write tools cover SERVICE RECORDS only
// (recording/correcting work performed — operational data entry);
// creating/retuning SCHEDULES is configuration and stays out of the registry.

const SCHEDULE_SORT = ["name", "createdAt"] as const satisfies readonly ServiceScheduleSortColumn[];

const RECORD_SORT = [
  "performedAt",
  "createdAt",
] as const satisfies readonly ServiceRecordSortColumn[];

const ListServiceSchedulesArgs = z
  .object({
    vehicleId: z.string().trim().min(1).optional(),
    status: z.array(z.enum(ServiceScheduleStatus)).optional(),
    sortBy: z.enum(SCHEDULE_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const ListServiceRecordsArgs = z
  .object({
    vehicleId: z.string().trim().min(1).optional(),
    serviceScheduleId: z.string().trim().min(1).optional(),
    sortBy: z.enum(RECORD_SORT).optional(),
    sortDir: z.enum(["asc", "desc"]).optional(),
    skip: z.number().int().min(0).optional(),
    take: z.number().int().min(1).max(200).optional(),
  })
  .strict();

// Mirrors CreateServiceRecordSchema field-for-field. The same-vehicle rules
// for serviceScheduleId/expenseLogId re-validate in the service at execute.
const CreateServiceRecordArgs = z
  .object({
    vehicleId: z.string().trim().min(1),
    serviceScheduleId: z.string().trim().min(1).nullable().optional(),
    expenseLogId: z.string().trim().min(1).nullable().optional(),
    performedAt: z.iso.date(),
    odometerKm: z.number().int().min(0).max(100_000_000).nullable().optional(),
    engineHours: z.number().int().min(0).max(100_000_000).nullable().optional(),
    notes: z.string().max(4096).nullable().optional(),
  })
  .strict();

// Mirrors UpdateServiceRecordSchema field-for-field plus the wrapper-only
// `id` — vehicleId is structurally absent (immutable; the module schema's
// .strict() rejects it too). Explicit null CLEARS a link or reading. The
// module schema's empty-patch refine re-validates at execute. NOTE: a PATCH
// does NOT advance a linked schedule's last-service anchor (anchor advance is
// a create-only event; editing is manual correction).
const UpdateServiceRecordArgs = z
  .object({
    id: z.string().trim().min(1),
    serviceScheduleId: z.string().trim().min(1).nullable().optional(),
    expenseLogId: z.string().trim().min(1).nullable().optional(),
    performedAt: z.iso.date().optional(),
    odometerKm: z.number().int().min(0).max(100_000_000).nullable().optional(),
    engineHours: z.number().int().min(0).max(100_000_000).nullable().optional(),
    notes: z.string().max(4096).nullable().optional(),
  })
  .strict();

export function buildMaintenanceTools(
  serviceSchedules: ServiceSchedulesService,
  serviceRecords: ServiceRecordsService,
): ToolDefinition[] {
  return [
    {
      name: "list_service_schedules",
      description:
        "List preventive-maintenance schedules with optional vehicleId/status " +
        "filters, sorting, pagination (take ≤ 200). intervalValue units depend on " +
        "intervalType: DISTANCE_KM = integer km, ENGINE_HOURS = integer " +
        "tenths-of-an-hour, CALENDAR_DAYS = days. For due/overdue reasoning, " +
        "compare a schedule's lastService anchor + interval against the vehicle's " +
        "current meter (get_vehicle) or today's date.",
      capabilities: ["maintenance:*"],
      riskTier: "read",
      argsSchema: ListServiceSchedulesArgs,
      async execute(args) {
        const query = ListServiceSchedulesQuerySchema.parse(
          toQueryShape(ListServiceSchedulesArgs.parse(args)),
        );
        return serviceSchedules.list(query);
      },
    },
    {
      name: "get_service_schedule",
      description:
        "Fetch one service schedule by id: name, interval type/value, status, and " +
        "the last-service anchor (date + meter readings).",
      capabilities: ["maintenance:*"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args) {
        const { id } = GetByIdArgs.parse(args);
        return serviceSchedules.getById(id);
      },
    },
    {
      name: "list_service_records",
      description:
        "List performed-service records with optional vehicleId/serviceScheduleId " +
        "filters, sorting (default: performedAt), pagination (take ≤ 200). Costs " +
        "ride the linked expense log; meter readings are integer km / " +
        "tenths-of-an-hour.",
      capabilities: ["maintenance:*"],
      riskTier: "read",
      argsSchema: ListServiceRecordsArgs,
      async execute(args) {
        const query = ListServiceRecordsQuerySchema.parse(
          toQueryShape(ListServiceRecordsArgs.parse(args)),
        );
        return serviceRecords.list(query);
      },
    },
    {
      name: "get_service_record",
      description: "Fetch one service record by id (what was done, when, at what meter).",
      capabilities: ["maintenance:*"],
      riskTier: "read",
      argsSchema: GetByIdArgs,
      async execute(args) {
        const { id } = GetByIdArgs.parse(args);
        return serviceRecords.getById(id);
      },
    },
    {
      name: "create_service_record",
      description:
        "Record maintenance/service work performed on a vehicle. Required: " +
        "vehicleId (resolve with list_vehicles first — never guess), performedAt " +
        "(ISO YYYY-MM-DD). Optional: serviceScheduleId (must be a schedule on the " +
        "SAME vehicle; recording against it advances its last-service anchor), " +
        "expenseLogId (a MAINTENANCE/REPAIR expense on the same vehicle, for the " +
        "cost link), odometerKm (integer km), engineHours (integer " +
        "tenths-of-an-hour), notes. The write happens immediately and exactly " +
        "once; the result includes the new record's id.",
      capabilities: ["maintenance:*"],
      riskTier: "reversible-write",
      resultEntityType: "ServiceRecord",
      argsSchema: CreateServiceRecordArgs,
      async execute(args, actor) {
        const input = CreateServiceRecordSchema.parse(CreateServiceRecordArgs.parse(args));
        return serviceRecords.create(input, actor.userId);
      },
    },
    {
      name: "update_service_record",
      description:
        "Update fields on an existing service record (partial update — send only " +
        "what changes; the prior row is captured for undo). vehicleId cannot be " +
        "changed. Explicit null CLEARS serviceScheduleId, expenseLogId, " +
        "odometerKm, engineHours, or notes; a non-null link must belong to the " +
        "record's vehicle (the expense additionally MAINTENANCE/REPAIR). " +
        "Editing does NOT advance a schedule's last-service anchor. The write " +
        "happens immediately and exactly once.",
      capabilities: ["maintenance:*"],
      riskTier: "reversible-write",
      resultEntityType: "ServiceRecord",
      argsSchema: UpdateServiceRecordArgs,
      async capturePreImage(args) {
        const { id } = UpdateServiceRecordArgs.parse(args);
        return serviceRecords.findById(id);
      },
      async execute(args) {
        const { id, ...patch } = UpdateServiceRecordArgs.parse(args);
        const input = UpdateServiceRecordSchema.parse(patch);
        const updated = await serviceRecords.update(id, input);
        if (updated === null) {
          throw new NotFoundException(`Service record ${id} not found.`);
        }
        return updated;
      },
    },
  ];
}
